# System design and tradeoffs

## Components and responsibilities

| Component | Namespace | Exposure | Responsibility |
|---|---|---|---|
| WordPress + WooCommerce | `store` | Ingress `store.localhost` | Storefront, checkout, WP admin. Content on a PVC. |
| MariaDB (StatefulSet) | `store` | ClusterIP, WordPress only | Store database on a PVC. |
| `store-init` (initContainer) | `store` | – | Idempotent bootstrap on every start: seed/upgrade core, install WooCommerce, apply config from values, register the REST API key from the Secret. |
| wp-cron (CronJob) | `store` | – | Runs WP-Cron every 5 min instead of piggybacking on page views. |
| woo-mcp | `store` | ClusterIP, **gateway pods only** | Our WooCommerce MCP server (Streamable HTTP). |
| gateway | `mcp-gateway` | Ingress `app.localhost/{api,mcp}` | MCP server for clients, MCP client to upstreams, REST API, auth, keys, audit, chat agent. |
| Postgres (StatefulSet) | `mcp-gateway` | ClusterIP, gateway only | Users, sessions, invites, API key hashes, servers (encrypted credentials), audit log. |
| dashboard | `mcp-gateway` | Ingress `app.localhost/` | Static React SPA (nginx-unprivileged). |
| toolbox, everything | `mcp-gateway` | ClusterIP, gateway only | Demo upstreams #2 and #3. |

The store and the gateway are separate Helm releases in separate namespaces. The gateway only knows the
store through an MCP URL plus a credential, which makes it a plain upstream like any other. The same
boundary is what a multi-store setup would provision once per store.

## How the WooCommerce MCP server talks to the store

It uses the **WooCommerce REST API (`wc/v3`)** over the in-cluster WordPress Service. WP-CLI and direct
database access were the alternatives, and I rejected them for three reasons:

- **Business logic:** the REST API runs WooCommerce's own business logic (stock, totals, status transitions,
  hooks and emails). Writing to the database directly would bypass all of it.
- **Isolation:** a separate pod needs only HTTP to WordPress. NetworkPolicy then lets it reach WordPress
  and nothing else. WP-CLI would need the WordPress volume or `exec` rights in that pod.
- **Least privilege:** the API key belongs to a dedicated `shop_manager` user (`mcp-bot`). That user can
  manage products and orders, but cannot install plugins or manage users.

Authentication works like this:

- **Inside the cluster (plain HTTP):** WooCommerce only accepts key and secret as Basic auth when WordPress
  thinks the request is HTTPS. Over plain HTTP its documented method is **OAuth 1.0a one-legged signing**,
  which `apps/woo-mcp/src/woo.ts` implements with HMAC-SHA256. One quirk: WooCommerce rebuilds the
  signature base from `home_url()`, so the server signs against the public `siteUrl` while it sends the
  request to the internal Service.
- **If the internal URL is `https`:** it uses Basic auth instead.

`store-init` creates the key from `wc-consumer-key` and `wc-consumer-secret` in the `store-secrets` Secret.
WooCommerce stores the key as a hash, so rotating it means changing the Secret and restarting the pod.

## Gateway: aggregation, routing and failure handling

**Upstream pool (`registry.ts`).**
- The `servers` table is the source of truth. Each enabled server gets one long-lived MCP `Client` over
  Streamable HTTP, which sends only that server's stored credential.
- A health loop runs every 10 s. It connects if needed and refreshes `tools/list`, so cached tools double
  as a liveness check.
- A connection error or timeout marks the server `unreachable` and records the reason, for example
  `ECONNREFUSED 10.96.x.x:8080`, `HTTP 401: credential rejected` or `connect timed out after 5000ms`.
  The next tick reconnects. If an upstream restarts and loses our session (HTTP 404), the gateway
  reconnects and retries once. That retry is safe because the request was never processed.
- Registry edits on one replica trigger `NOTIFY servers_changed`, and every replica reloads.

**Tool listing.**
- `tools/list` is answered **from the cache, without calling any upstream**. A slow or dead upstream
  therefore can never block or slow down listing.
- Only servers that are `enabled` and `connected` contribute tools. Tools restricted to admins are
  filtered out for members.
- Whenever the merged tool set changes (server added, disabled, died or recovered), every live MCP session
  is sent `notifications/tools/list_changed`. Clients that support it, such as Claude Code, refresh
  automatically.

**Name collisions.**
- Every tool is exposed as `<server-slug>__<tool-name>`, for example `woocommerce__list_orders`. Slugs are
  unique and cannot contain `_`, so the first `__` splits the name without ambiguity.
- The demo has a real collision: both `toolbox` and `everything` expose `echo`, which become
  `toolbox__echo` and `everything__echo`.
- Descriptions are prefixed with `[Server name]`, so models know where each tool comes from.
- Routing doesn't trust the name alone. It looks up the slug in the registry and checks that the tool
  exists in that server's current tool list.

**Calls (`gateway.ts`), one code path for MCP clients and the chat agent.** The steps are:

1. Resolve the slug.
2. Apply policy: return `denied` if the server is disabled, unknown or the tool is admin-only.
3. Call the upstream with a per-server timeout (default 15 s, editable per server).
4. Write the audit row and update metrics.

Timeouts and upstream failures come back as tool results with `isError: true` and a message like
`Upstream "toolbox" did not answer within 2500ms`, so a model can explain the failure. Unknown or denied
tools get JSON-RPC `-32602`. Each upstream has its own client and timeout, so one slow server never
blocks calls to the others.

**Sessions.**
- **Stateful by default:** sessions live in memory, keyed by `Mcp-Session-Id` and bound to the API key
  that opened them. This enables `list_changed` push notifications. The API key is re-checked against the
  database on **every** request, so revocation applies to the next call, and live sessions for a revoked
  key are closed immediately.
- **Stateless mode** (`gateway.mcpStateless=true`): a fresh server per request. Any replica can serve any
  request without sticky sessions; the cost is losing push notifications. The prod values use it with
  2 replicas.

**Chat agent (`chat.ts`).**
- It is a manual tool loop running inside the gateway process. Tools come from
  `listTools(principal)` and calls go through `callTool(principal, …)`.
- The `principal` is the logged-in dashboard user, with `source: "chat"`. The agent therefore sees exactly
  what that user can see, and its calls are audited under that user.
- The model never holds upstream credentials or the user's API key.
- Providers: Claude via the Anthropic SDK (streaming, `claude-opus-5` by default, with server-side refusal
  fallbacks enabled), or any OpenAI-compatible endpoint.
- Above 40 tools it switches to `search_tools` and `call_tool` meta-tools.

## Auth and data model

- **Dashboard:** email and password (scrypt). A random session token is set in an httpOnly, SameSite=Lax
  cookie; only its sha256 is stored. Mutations must send `Content-Type: application/json`, which blocks
  cross-site form CSRF.
- **Roles:** `admin` manages servers, members, invites and anyone's keys, and sees the whole audit log.
  `member` uses tools, manages their own keys and sees only their own audit entries.
- **API keys:** `mcpgw_` followed by 192 random bits. Only `sha256(key)` and a display prefix are stored,
  and the plaintext is shown once. A fast hash is appropriate because the keys are random, not
  human-chosen.
- **Upstream credentials:** AES-256-GCM using `ENCRYPTION_KEY` from a Secret. They are decrypted only
  in-process to build upstream request headers, and no API ever returns them.
- **Audit log:** user, API key prefix, source (`mcp`/`chat`), event (`tool_call`/`auth`), server, tool,
  timestamp, duration, outcome (`ok`/`error`/`denied`), error, and arguments with sensitive keys redacted.
  Rejected calls from revoked keys are attributed to the key's owner.

## Kubernetes choices

- **Helm only:** two charts, with environment differences in `values-local.yaml` and `values-prod.yaml`.
  The charts never create secrets; they reference pre-created Secrets.
- **Probes on every workload:**
  - WordPress: readiness on `/wp-login.php` (a PHP and database round trip); liveness on a static file, so
    a slow database can't restart Apache.
  - MariaDB: `healthcheck.sh`. Postgres: `pg_isready`.
  - Gateway: readiness on `/readyz` (database); liveness on `/healthz`.
  - Node and nginx services: `/healthz`. The reference server: TCP probe.
- **Resources:** every container has requests and limits.
- **Storage:** both databases are StatefulSets with `volumeClaimTemplates`. WordPress content is a PVC
  with `helm.sh/resource-policy: keep`, and the WordPress Deployment uses the `Recreate` strategy
  because the volume is RWO.
- **Ingress:** Traefik on both kind and k3s, one host per app. `/api` and `/mcp` sit on the same origin
  as the SPA, so no CORS is needed. Traefik streams SSE without buffering.
- **NetworkPolicies:** default-deny ingress in both namespaces, with explicit allow rules. In practice:
  - Only gateway pods can reach `woo-mcp`.
  - `woo-mcp` can reach only its WordPress and DNS.
  - MariaDB accepts connections only from WordPress.
  - The gateway can reach only Postgres, pods labelled `mcp-gateway/upstream=true`, DNS and the public
    internet.

  All of this is verified on kind (kindnet enforces NetworkPolicy); probe results are in the README
  walkthrough.

## What changes for production

| Concern | Local (kind) | VPS (k3s) |
|---|---|---|
| DNS | `*.localhost` → 127.0.0.1, no setup | A records → VPS IP |
| Ingress | Traefik chart, NodePort 30080 mapped to host :80 | k3s built-in Traefik (`kube-system`), cert-manager TLS |
| Storage | kind `standard` (local-path) | `local-path` or a replicated class (Longhorn) plus backups |
| Secrets | `scripts/gen-secrets.sh` → Secrets | Same script, or SOPS / Sealed Secrets / External Secrets; charts only reference Secret names |
| Images | `kind load`, `IfNotPresent` | Registry (GHCR), immutable version tags |
| Gateway | 1 replica, stateful MCP sessions | 2 replicas, stateless MCP, `cookieSecure=true` |

## Tradeoffs and known limits

- **In-memory state:** rate limiting and stateful MCP sessions are per replica. Multi-replica deployments
  use stateless mode, and a shared Redis would be the next step for global rate limits.
- **Timeouts:** the gateway doesn't cancel the upstream's work after a timeout. It only stops waiting.
- **SSRF and DNS rebinding:** the SSRF guard resolves DNS at registration and at every connect, so a
  rebinding race between check and use remains possible. The gateway's egress NetworkPolicy is the
  backstop that makes private targets unreachable regardless.
- **Invites:** without a mail server, invite links are shown to the admin to share.
- **WooCommerce HPOS:** the store uses WooCommerce's default storage on new installs. The REST API hides
  the difference.
