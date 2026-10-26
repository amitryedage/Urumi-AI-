#!/usr/bin/env bash
# One command to run everything on a local kind cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=urumi
TAG="${IMAGE_TAG:-local-$(date +%Y%m%d%H%M%S)}"

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --config deploy/kind-config.yaml
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

echo "==> ingress controller (Traefik)"
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik --version 41.7.1 -n traefik --create-namespace \
  -f deploy/traefik-values-local.yaml >/dev/null
kubectl -n traefik rollout status deploy/traefik --timeout 5m >/dev/null

echo "==> images (tag $TAG)"
scripts/build-images.sh "$TAG"
for img in wordpress everything-mcp woo-mcp toolbox-mcp gateway dashboard; do
  echo "    loading urumi/$img:$TAG ..."
  if ! kind load docker-image "urumi/$img:$TAG" --name "$CLUSTER" 2>/dev/null; then
    echo "    stream pipe dropped, falling back to file transfer for urumi/$img:$TAG ..."
    docker save "urumi/$img:$TAG" -o "${img}.tar"
    docker cp "${img}.tar" "${CLUSTER}-control-plane:/tmp/${img}.tar"
    docker exec "${CLUSTER}-control-plane" ctr --namespace=k8s.io images import "/tmp/${img}.tar" >/dev/null
    docker exec "${CLUSTER}-control-plane" rm -f "/tmp/${img}.tar"
    rm -f "${img}.tar"
  fi
done

echo "==> secrets"
scripts/gen-secrets.sh

# If an earlier run was interrupted (e.g. Ctrl+C), Helm leaves a release in pending-* status.
# Automatically clear the lock so subsequent runs succeed.
unlock_helm_release() {
  local rel="$1"
  local ns="$2"
  local status
  status="$(helm status "$rel" -n "$ns" -o json 2>/dev/null | grep -o '"status":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
  if [[ "$status" =~ ^pending- ]]; then
    echo "    detected stuck $status for release $rel in $ns, clearing lock..."
    kubectl delete secret -n "$ns" -l "owner=helm,name=$rel" 2>/dev/null || true
  fi
}

echo "==> store (first boot installs WordPress + WooCommerce, ~1-2 min)"
unlock_helm_release store store
helm upgrade --install store charts/store -n store -f charts/store/values-local.yaml \
  --set wordpress.image.tag="$TAG" --set mcp.image.tag="$TAG" --wait --timeout 10m

echo "==> gateway"
unlock_helm_release gateway mcp-gateway
helm upgrade --install gateway charts/gateway -n mcp-gateway -f charts/gateway/values-local.yaml \
  --set gateway.image.tag="$TAG" --set dashboard.image.tag="$TAG" \
  --set toolbox.image.tag="$TAG" --set everything.image.tag="$TAG" --wait --timeout 5m

# On Windows, browsers (Chrome/Edge) resolve *.localhost to IPv6 [::1] by default.
# Docker Desktop on Windows binds port 80/443 to IPv4 (127.0.0.1/0.0.0.0), causing ERR_CONNECTION_REFUSED.
# Start a lightweight IPv6 -> IPv4 proxy if node is available.
if command -v node >/dev/null 2>&1; then
  if ! pgrep -f "scripts/ipv6-proxy.js" >/dev/null 2>&1; then
    nohup node scripts/ipv6-proxy.js >/dev/null 2>&1 &
  fi
fi

source .secrets/local.env
cat <<EOM

Ready.
  Storefront   http://store.localhost
  WP admin     http://store.localhost/wp-admin     admin / $WP_ADMIN_PASSWORD
  Dashboard    http://app.localhost                admin@example.com / $ADMIN_PASSWORD
  MCP endpoint http://app.localhost/mcp            (create a key in the dashboard)
EOM
