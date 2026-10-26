import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { listen, query } from "./db.js";
import { log } from "./log.js";

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header: string | null;
  credential_enc: string | null;
  enabled: boolean;
  timeout_ms: number;
  restricted_tools: string[];
  source: string;
  created_at: Date;
  updated_at: Date;
}

export type UpstreamStatus = "connected" | "unreachable" | "disabled" | "connecting";

/** Separator between server slug and upstream tool name. Slugs cannot contain "_". */
export const TOOL_SEPARATOR = "__";
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// ---------------------------------------------------------------------------------------------
// SSRF guard for admin-supplied upstream URLs.
// ---------------------------------------------------------------------------------------------

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("127.0.0.0", 8); // loopback (the gateway itself)
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16); // link-local incl. cloud metadata 169.254.169.254
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8);
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4);
ALWAYS_BLOCKED.addSubnet("100.100.100.200", 32, "ipv4"); // Alibaba metadata
ALWAYS_BLOCKED.addAddress("::1", "ipv6");
ALWAYS_BLOCKED.addAddress("::", "ipv6");
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6");
ALWAYS_BLOCKED.addSubnet("fd00:ec2::", 32, "ipv6"); // AWS IMDS v6

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8);
PRIVATE.addSubnet("172.16.0.0", 12);
PRIVATE.addSubnet("192.168.0.0", 16);
PRIVATE.addSubnet("100.64.0.0", 10);
PRIVATE.addSubnet("fc00::", 7, "ipv6");

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "localhost", "kubernetes.default", "kubernetes.default.svc", "kubernetes.default.svc.cluster.local"]);

export async function assertSafeUpstreamUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("Put credentials in the credential field, not the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) throw new Error(`Host ${host} is not allowed`);

  const allowPrivate =
    config.upstream.allowAllPrivate || config.upstream.privateHostAllowlist.some((s) => host.endsWith(s));
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => {
    throw new Error(`Cannot resolve ${host}`);
  });
  for (const { address, family } of addrs) {
    const type = family === 6 ? "ipv6" : "ipv4";
    if (ALWAYS_BLOCKED.check(address, type)) throw new Error(`${host} resolves to a blocked address (${address})`);
    if (PRIVATE.check(address, type) && !allowPrivate) {
      throw new Error(
        `${host} resolves to a private address (${address}). Only in-cluster service names ` +
          `(${config.upstream.privateHostAllowlist.join(", ")}) may point at private addresses.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One upstream MCP server
// ---------------------------------------------------------------------------------------------

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref()),
  ]);

function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) return `Upstream rejected the gateway's credential (HTTP ${err.code})`;
    return `HTTP ${err.code ?? "error"}: ${err.message}`;
  }
  if (e.cause?.code) return `${e.cause.code}: ${e.cause.message || e.message || "network error"}`;
  return e.message ?? String(err);
}

/**
 * The upstream no longer knows our MCP session (it restarted). Spec-compliant servers answer 404;
 * some (e.g. the reference server) answer 400 "No valid session ID". The request was not
 * processed, so reconnecting and retrying once is safe.
 */
function isSessionLost(err: unknown): boolean {
  if (!(err instanceof StreamableHTTPError)) return false;
  return err.code === 404 || (err.code === 400 && /session/i.test(err.message));
}

function isTransient(err: unknown): boolean {
  const e = err as Error & { cause?: { code?: string } };
  if (err instanceof McpError) return err.code === ErrorCode.RequestTimeout;
  if (err instanceof StreamableHTTPError) return (err.code ?? 0) >= 500;
  const code = e.cause?.code ?? "";
  return ["EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || /timed out|aborted/i.test(e.message ?? "");
}

export class Upstream {
  status: UpstreamStatus = "connecting";
  tools: Tool[] = [];
  lastError?: string;
  lastCheckedAt?: Date;
  connectedAt?: Date;
  latencyMs?: number;
  serverInfo?: { name: string; version: string };
  private client?: Client;
  private inflight?: Promise<void>;
  private transientFailures = 0;

  constructor(public row: ServerRow, private onChange: () => void) {
    if (!row.enabled) this.status = "disabled";
  }

  private headers(): Record<string, string> {
    if (this.row.auth_type === "none" || !this.row.credential_enc) return {};
    const secret = decrypt(this.row.credential_enc);
    if (this.row.auth_type === "bearer") return { Authorization: `Bearer ${secret}` };
    return { [this.row.auth_header || "X-API-Key"]: secret };
  }

  private setState(status: UpstreamStatus, error?: string) {
    const changed = status !== this.status;
    this.status = status;
    this.lastError = error;
    this.lastCheckedAt = new Date();
    if (changed) {
      log.info("upstream status", { server: this.row.slug, status, error });
      this.onChange();
    }
  }

  private async connect() {
    await this.closeClient();
    await assertSafeUpstreamUrl(this.row.url);
    const transport = new StreamableHTTPClientTransport(new URL(this.row.url), {
      // Only the gateway's own stored credential is sent upstream. Client tokens never are.
      requestInit: { headers: this.headers() },
    });
    const client = new Client({ name: "urumi-mcp-gateway", version: "0.1.0" }, { capabilities: {} });
    client.onerror = (err) => log.warn("upstream transport error", { server: this.row.slug, error: describeError(err) });
    await withTimeout(client.connect(transport), config.upstream.connectTimeoutMs, "connect");
    this.client = client;
    this.serverInfo = client.getServerVersion();
    this.connectedAt = new Date();
  }

  private async refreshTools() {
    const client = this.client!;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const started = Date.now();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.upstream.connectTimeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    this.latencyMs = Date.now() - started;
    const before = this.tools.map((t) => t.name).join(",");
    this.tools = tools;
    if (before !== tools.map((t) => t.name).join(",")) this.onChange();
  }

  /** Health check: (re)connect if needed, then list tools. Never throws. */
  check(): Promise<void> {
    if (!this.row.enabled) {
      if (this.status !== "disabled") {
        void this.closeClient();
        this.tools = [];
        this.setState("disabled");
      }
      return Promise.resolve();
    }
    // Coalesce concurrent checks.
    this.inflight ??= (async () => {
      try {
        if (!this.client) await this.connect();
        try {
          await this.refreshTools();
        } catch (err) {
          // Upstream restarted and dropped our session: reconnect immediately once.
          if (!isSessionLost(err)) throw err;
          await this.connect();
          await this.refreshTools();
        }
        this.setState("connected");
        this.transientFailures = 0;
      } catch (err) {
        // A single slow or DNS-flaky probe of a healthy upstream is not an outage: tolerate one
        // transient failure. Definitive failures (refused, 401/403, NXDOMAIN) flip immediately.
        if (this.status === "connected" && isTransient(err) && ++this.transientFailures < 2) {
          log.warn("upstream health check failed, will retry", { server: this.row.slug, error: describeError(err) });
          return;
        }
        this.transientFailures = 0;
        await this.closeClient();
        this.setState("unreachable", describeError(err));
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!this.client) {
      await this.check();
      if (!this.client) throw new Error(`Upstream "${this.row.slug}" is unreachable: ${this.lastError ?? "not connected"}`);
    }
    const attempt = () =>
      this.client!.callTool({ name, arguments: args }, undefined, { timeout: this.row.timeout_ms }) as Promise<CallToolResult>;
    try {
      return await attempt();
    } catch (err) {
      // The upstream restarted and forgot our session; safe to reconnect and retry exactly once.
      if (isSessionLost(err)) {
        await this.closeClient();
        await this.check();
        if (this.client) return await attempt();
      }
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        throw new Error(`Upstream "${this.row.slug}" did not answer within ${this.row.timeout_ms}ms`);
      }
      if (!(err instanceof McpError)) {
        // Transport-level failure: mark unreachable now rather than waiting for the next health tick.
        await this.closeClient();
        this.setState("unreachable", describeError(err));
      }
      throw new Error(`Upstream "${this.row.slug}" failed: ${describeError(err)}`);
    }
  }

  private async closeClient() {
    const c = this.client;
    this.client = undefined;
    if (c) await c.close().catch(() => {});
  }

  async dispose() {
    await this.closeClient();
  }
}

// ---------------------------------------------------------------------------------------------
// Registry of all upstreams (reconciled from the database)
// ---------------------------------------------------------------------------------------------

export class Registry extends EventEmitter {
  readonly upstreams = new Map<string, Upstream>(); // by server id
  private timer?: NodeJS.Timeout;
  private changeTimer?: NodeJS.Timeout;

  /** Debounced "tool list may have changed" signal for MCP sessions. */
  private changed = () => {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit("toolsChanged"), 200);
  };

  async reload() {
    const { rows } = await query<ServerRow>("SELECT * FROM servers ORDER BY created_at");
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.upstreams.get(row.id);
      if (existing && existing.row.updated_at.getTime() === row.updated_at.getTime()) continue;
      if (existing) await existing.dispose();
      const up = new Upstream(row, this.changed);
      this.upstreams.set(row.id, up);
      void up.check();
    }
    for (const [id, up] of this.upstreams) {
      if (!seen.has(id)) {
        await up.dispose();
        this.upstreams.delete(id);
      }
    }
    this.changed();
  }

  async start() {
    await this.reload();
    // Other gateway replicas announce registry edits via NOTIFY; reload on every change.
    await listen("servers_changed", () => void this.reload().catch((e) => log.error("reload failed", { error: String(e) })));
    this.timer = setInterval(() => {
      for (const up of this.upstreams.values()) void up.check();
    }, config.upstream.healthIntervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  bySlug(slug: string): Upstream | undefined {
    for (const up of this.upstreams.values()) if (up.row.slug === slug) return up;
    return undefined;
  }

  list(): Upstream[] {
    return [...this.upstreams.values()];
  }
}

export const registry = new Registry();
