# Urumi MCP Gateway on Kubernetes

WooCommerce hosting with a **team MCP gateway**. An admin registers MCP servers once in a dashboard;
every team member then uses all of them through **one MCP endpoint** (Claude Code, Cursor, MCP Inspector)
and through a **chat agent** in the dashboard. The first upstream is a WooCommerce MCP server written
from scratch for this project.

```
                     ┌──────────────────────── kind / k3s ─────────────────────────────────────┐
 browser ──► Traefik │  ns: mcp-gateway                              ns: store                  │
   store.localhost ──┼──────────────────────────────────────────────► WordPress+WooCommerce ──► MariaDB
   app.localhost  ───┼─► dashboard (React, /)                              ▲  (PVC)          (PVC)
                     │   gateway (/api, /mcp) ──► Postgres (PVC)            │ REST (OAuth1)
 Claude Code ────────┼─► gateway /mcp ──┬──► woo-mcp  (ns store, internal) ─┘
 Cursor / Inspector  │   (API key)      ├──► toolbox  (ours: time, currency, echo, sleep)
                     │                  └──► everything (official MCP reference server)
                     └─────────────────────────────────────────────────────────────────────────┘
```

| Path | What |
|---|---|
| `apps/woo-mcp` | WooCommerce MCP server (TypeScript, Streamable HTTP): `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| `apps/gateway` | Gateway backend: MCP server at `/mcp` + MCP client to every upstream, REST API for the dashboard, auth, API keys, audit log, chat agent |
| `apps/dashboard` | React + Tailwind v4 dashboard (Vercel theme): servers, chat, API keys, team, audit log |
| `apps/toolbox-mcp` | Second upstream (ours): `get_current_time`, `convert_currency`, `echo`, `sleep` — header credential |
| `images/everything-mcp` | Third upstream: the official MCP reference server (third-party code), pinned |
| `images/wordpress` | WordPress 7.1 + WooCommerce 11.2.1 + Storefront + wp-cli baked into one image, plus `store-init.sh` |
| `charts/store`, `charts/gateway` | Helm charts, each with `values-local.yaml` (kind) and `values-prod.yaml` (k3s VPS) |
| `docs/DESIGN.md` | System design and tradeoffs |
| `docs/THREAT_MODEL.md` | Threat model |

## Local setup (kind)

Prerequisites: Docker (≈6 GB RAM for Docker Desktop), `kind`, `kubectl`, `helm`, `openssl`. Host ports 80/443 must be free.

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # optional: enables the chat agent (see "Chat agent" for other providers)
scripts/local-up.sh                      # creates the cluster, Traefik, images, secrets, both Helm releases
```

The script prints the URLs and generated passwords (also stored in `.secrets/local.env`, git-ignored):

| | URL | Login |
|---|---|---|
| Storefront | http://store.localhost | – |
| WooCommerce admin | http://store.localhost/wp-admin | `admin` / `WP_ADMIN_PASSWORD` |
| Dashboard | http://app.localhost | `admin@example.com` / `ADMIN_PASSWORD` |
| MCP endpoint | http://app.localhost/mcp | `Authorization: Bearer <your API key>` |

**Local domains.** `*.localhost` is reserved (RFC 6761) and resolves to the loopback address in browsers,
curl and Node.js without touching `/etc/hosts` or DNS. kind maps host ports 80/443 to Traefik's NodePorts
(`deploy/kind-config.yaml`), and Ingress rules route by host. If a client of yours does not resolve
`*.localhost`, add `127.0.0.1 store.localhost app.localhost` to `/etc/hosts`.

Re-running `scripts/local-up.sh` rebuilds images with a new tag and does a `helm upgrade` (data is kept).
`scripts/local-down.sh` deletes the cluster.

## Using it

### Place an order
1. Open http://store.localhost, add a product to the cart, go to checkout.
2. Fill in any address and pay with **Cash on delivery**.
3. See it in http://store.localhost/wp-admin → WooCommerce → Orders.

### Team members and API keys
1. Dashboard → **Team** → *Invite member* → copy the one-time invite link (no mail server; links expire in 7 days).
2. The member opens the link, sets a name and password, and lands in the dashboard.
3. **API keys** → *Create key*. The key is shown once, with copy-paste configs for each client.
   Admins can also issue and revoke keys for any member from **Team**.

### Connect an external MCP client
Only the gateway URL and a personal key are needed; upstream credentials are never exposed.

```bash
# Claude Code
claude mcp add --transport http urumi-gateway http://app.localhost/mcp \
  --header "Authorization: Bearer mcpgw_..."

# MCP Inspector (UI): transport "Streamable HTTP", URL http://app.localhost/mcp,
# header Authorization: Bearer mcpgw_...
npx @modelcontextprotocol/inspector
```

Cursor (`~/.cursor/mcp.json`):
```json
{ "mcpServers": { "urumi-gateway": { "url": "http://app.localhost/mcp",
  "headers": { "Authorization": "Bearer mcpgw_..." } } } }
```

Try: *"What orders came in today?"* and, needing two upstreams,
*"List today's orders and convert their total to EUR"* (`woocommerce__list_orders` + `toolbox__convert_currency`).

### Chat agent
Dashboard → **Chat**. It calls the same gateway tools as the logged-in user (calls show inline and in the
audit log with source `chat`). Configure the model with Helm values:

| Provider | Values |
|---|---|
| Claude (default) | `llm.provider=anthropic`, `llm.model=claude-opus-5`, key in Secret `gateway-secrets` / `llm-api-key` |
| Any OpenAI-compatible API (Groq, Gemini, OpenRouter, Ollama…) | `llm.provider=openai`, `llm.baseUrl=https://api.groq.com/openai/v1`, `llm.model=<model>` |

To add or rotate the key later: `export ANTHROPIC_API_KEY=... && scripts/gen-secrets.sh && kubectl -n mcp-gateway rollout restart deploy/gateway-gateway`.

## Definition-of-done walkthrough

| Step | How |
|---|---|
| Storefront order | storefront → cart → checkout → COD; visible in WP admin |
| Chat as user A | Chat: *"Create a product called Demo Hoodie priced at 39.99"* → appears at http://store.localhost/shop; place an order for it; *"What orders came in today?"* |
| External client as user B | invite B, B creates a key, `claude mcp add …`; `/mcp` lists every enabled server's tools; ask the orders question and the two-server question |
| Revoke | Team → B's key → Revoke; B's next call gets `401 API key has been revoked` (audited under B) |
| Disable | Servers → toggle *everything* off; its tools disappear from chat and clients (live sessions get `tools/list_changed`) |
| Kill a pod | `kubectl -n store delete pod -l app.kubernetes.io/component=woo-mcp` (or `scale --replicas=0` to keep it down): dashboard shows **Unreachable** with the reason; toolbox/everything keep working |
| Audit | Audit page: user, source, server, tool, time, duration, outcome, error, arguments |

## Production-like VPS (k3s)

```bash
# 1. VPS with k3s (ships Traefik + local-path storage)
curl -sfL https://get.k3s.io | sh -
# 2. DNS: A records for store.example.com and app.example.com -> VPS IP
# 3. TLS (optional but recommended)
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f deploy/cluster-issuer.yaml           # edit the email first
# 4. Images: build and push to a registry
scripts/build-images.sh 0.1.0 ghcr.io/<you>/urumi-
for i in wordpress everything-mcp woo-mcp toolbox-mcp gateway dashboard; do docker push ghcr.io/<you>/urumi-$i:0.1.0; done
# 5. Secrets (same script; or create them with your secret manager / SOPS / External Secrets)
export ANTHROPIC_API_KEY=...; scripts/gen-secrets.sh
# 6. Same charts, prod values + your domain
helm upgrade --install store charts/store -n store -f charts/store/values-prod.yaml \
  --set store.siteUrl=https://store.example.com --set ingress.host=store.example.com \
  --set wordpress.image.repository=ghcr.io/<you>/urumi-wordpress --set mcp.image.repository=ghcr.io/<you>/urumi-woo-mcp
helm upgrade --install gateway charts/gateway -n mcp-gateway -f charts/gateway/values-prod.yaml \
  --set publicUrl=https://app.example.com --set ingress.host=app.example.com   # + image repositories
```

What changes between local and VPS is **only Helm values** (diff `values-local.yaml` vs `values-prod.yaml`):
domain / `siteUrl` / `publicUrl`, Ingress TLS + cert-manager annotation, Traefik namespace for NetworkPolicies
(`traefik` on kind, `kube-system` on k3s), storage class and sizes, image registry/tags, secure cookies,
gateway replicas + stateless MCP mode, resources. Secrets are always pre-created Kubernetes Secrets.

### Upgrade and rollback
```bash
helm upgrade store charts/store -n store -f charts/store/values-prod.yaml --set wordpress.image.tag=0.2.0
helm history store -n store
helm rollback store <REVISION> -n store
```
- **Store**: the image pins WordPress/WooCommerce versions. On start, `store-init` upgrades core files and
  runs `wp core update-db` + `wp wc update`. WooCommerce DB migrations are forward-only, so **back up
  before a store upgrade** (`kubectl -n store exec store-mariadb-0 -- mariadb-dump ...`); rolling back the
  image after a schema migration needs the backup. Deployment strategy is `Recreate` (RWO volume).
- **Gateway / MCP servers / dashboard**: stateless images, rolling updates; `helm rollback` is safe.
  Gateway schema migrations are additive and versioned (`schema_migrations`).
- PVCs are retained across `helm upgrade`/`rollback`; the WordPress content PVC is also kept on `helm uninstall`.

## Stand-out items implemented
- **Security hardening (6)**: SSRF guard on upstream URLs (blocks loopback, link-local/cloud metadata,
  private IPs except in-cluster service names, redirects off-origin); default-deny NetworkPolicies in both
  namespaces + gateway egress allowlist (only labelled MCP upstreams, Postgres, DNS, public internet);
  non-root containers with dropped capabilities, read-only root FS where possible, no service-account tokens;
  upstream credentials **encrypted at rest** (AES-256-GCM); WooCommerce key owned by a `shop_manager` user.
- **Tool permissions (2)**: per-server "admins only" tools — hidden from members' tool lists and rejected
  (and audited as `denied`) if called directly.
- **Handling many tools (4)**: above `CHAT_TOOL_SEARCH_THRESHOLD` (40) tools the chat agent gets
  `search_tools` + `call_tool` meta-tools instead of every schema.
- **Scaling (7)**: per-key rate limiting; Postgres LISTEN/NOTIFY keeps registries in sync across replicas;
  `gateway.mcpStateless=true` for multi-replica without sticky sessions (prod values run 2 replicas).
- **Observability (8)**: `/metrics` (Prometheus: calls/errors/latency histogram per upstream, upstream up/tool
  counts); dashboard shows the precise reason an upstream is unreachable and 24 h per-server stats.
- **Upgrades and rollback (9)**: see above.
- **VPS deployment (1)**: prod values + instructions; not deployed to a public VPS as part of this repo.

Not attempted: the multi-store provisioning bonus, OAuth on the gateway, hosted (image-based) MCP servers.

## Development
```bash
cd apps/gateway && npm i && npm run typecheck        # same for woo-mcp, toolbox-mcp
cd apps/dashboard && npm i && npm run dev             # proxies /api and /mcp to localhost:8080
```
