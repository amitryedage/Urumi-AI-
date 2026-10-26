set -euo pipefail
cd "$(dirname "$0")/.."
FILE=.secrets/local.env
mkdir -p .secrets && chmod 700 .secrets
if [ ! -f "$FILE" ]; then
  rnd() { openssl rand -hex "${1:-24}"; }
  cat > "$FILE" <<EOV
DB_PASSWORD=$(rnd)
DB_ROOT_PASSWORD=$(rnd)
WP_ADMIN_PASSWORD=$(rnd 12)
WC_CONSUMER_KEY=ck_$(rnd 20)
WC_CONSUMER_SECRET=cs_$(rnd 20)
WOO_MCP_TOKEN=$(rnd 32)
POSTGRES_PASSWORD=$(rnd)
ENCRYPTION_KEY=$(rnd 32)
ADMIN_PASSWORD=$(rnd 8)
TOOLBOX_API_KEY=$(rnd 24)
EOV
  chmod 600 "$FILE"
  echo "generated $FILE"
fi
set -a; source "$FILE"; set +a
LLM_KEY="${LLM_API_KEY:-${ANTHROPIC_API_KEY:-${OPENAI_API_KEY:-}}}"

kubectl create namespace store --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create namespace mcp-gateway --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl -n store create secret generic store-secrets \
  --from-literal=db-password="$DB_PASSWORD" \
  --from-literal=db-root-password="$DB_ROOT_PASSWORD" \
  --from-literal=wp-admin-password="$WP_ADMIN_PASSWORD" \
  --from-literal=wc-consumer-key="$WC_CONSUMER_KEY" \
  --from-literal=wc-consumer-secret="$WC_CONSUMER_SECRET" \
  --from-literal=mcp-token="$WOO_MCP_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

args=(
  --from-literal=postgres-password="$POSTGRES_PASSWORD"
  --from-literal=encryption-key="$ENCRYPTION_KEY"
  --from-literal=admin-password="$ADMIN_PASSWORD"
  --from-literal=woo-mcp-token="$WOO_MCP_TOKEN"
  --from-literal=toolbox-api-key="$TOOLBOX_API_KEY"
)
[ -n "$LLM_KEY" ] && args+=(--from-literal=llm-api-key="$LLM_KEY")
kubectl -n mcp-gateway create secret generic gateway-secrets "${args[@]}" --dry-run=client -o yaml | kubectl apply -f -
[ -z "$LLM_KEY" ] && echo "note: no LLM key set (export ANTHROPIC_API_KEY=... and re-run to enable the chat agent)"
exit 0
