/**
 * Gateway core: the single code path through which BOTH the external MCP endpoint and the
 * dashboard chat agent list and call upstream tools. Policy, routing and audit live here.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "./auth.js";
import { query } from "./db.js";
import { log } from "./log.js";
import { registry, TOOL_SEPARATOR, type Upstream } from "./registry.js";
import { metrics } from "./metrics.js";

export interface GatewayTool extends Tool {
  server: string; // slug
  upstreamName: string;
}

const qualified = (slug: string, tool: string) => `${slug}${TOOL_SEPARATOR}${tool}`;

function allowed(up: Upstream, toolName: string, p: Principal): boolean {
  if (p.user.role === "admin") return true;
  return !up.row.restricted_tools.includes(toolName);
}

/** Tools visible to this principal: every enabled+reachable server, namespaced by slug. */
export function listTools(p: Principal): GatewayTool[] {
  const out: GatewayTool[] = [];
  for (const up of registry.list()) {
    if (!up.row.enabled || up.status !== "connected") continue;
    for (const t of up.tools) {
      if (!allowed(up, t.name, p)) continue;
      out.push({
        ...t,
        name: qualified(up.row.slug, t.name),
        title: t.title ? `${t.title} (${up.row.name})` : undefined,
        // The prefix tells clients (and models) which upstream a tool belongs to.
        description: `[${up.row.name}] ${t.description ?? ""}`.trim(),
        server: up.row.slug,
        upstreamName: t.name,
      });
    }
  }
  return out;
}

export class ToolNotFoundError extends Error {}

const SENSITIVE = /pass(word)?|secret|token|api[-_]?key|authorization|credential/i;
function auditArgs(args: Record<string, unknown> | undefined): unknown {
  if (!args) return null;
  const redacted = JSON.parse(JSON.stringify(args, (k, v) => (k && SENSITIVE.test(k) ? "[redacted]" : v)));
  const s = JSON.stringify(redacted);
  return s.length > 4000 ? { truncated: true, preview: s.slice(0, 4000) } : redacted;
}

export async function audit(entry: {
  p?: Principal;
  source: string;
  event: "tool_call" | "auth";
  server?: string;
  tool?: string;
  durationMs?: number;
  outcome: "ok" | "error" | "denied";
  error?: string;
  args?: unknown;
  user?: { id: string; email: string };
  apiKeyId?: string;
  apiKeyPrefix?: string;
}) {
  const user = entry.p?.user ?? entry.user;
  try {
    await query(
      `INSERT INTO audit_log (user_id, user_email, api_key_id, api_key_prefix, source, event, server_slug, tool_name, duration_ms, outcome, error, args)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        user?.id ?? null, user?.email ?? null, entry.p?.apiKeyId ?? entry.apiKeyId ?? null,
        entry.p?.apiKeyPrefix ?? entry.apiKeyPrefix ?? null, entry.source, entry.event, entry.server ?? null,
        entry.tool ?? null, entry.durationMs ?? null, entry.outcome, entry.error?.slice(0, 1000) ?? null,
        entry.args === undefined ? null : JSON.stringify(entry.args),
      ],
    );
  } catch (err) {
    log.error("audit write failed", { error: (err as Error).message });
  }
}

/** Route a namespaced tool call to its upstream, enforcing policy, timeout and audit. */
export async function callTool(p: Principal, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const sep = name.indexOf(TOOL_SEPARATOR);
  const slug = sep > 0 ? name.slice(0, sep) : "";
  const toolName = sep > 0 ? name.slice(sep + TOOL_SEPARATOR.length) : name;
  const up = slug ? registry.bySlug(slug) : undefined;
  const base = { p, source: p.source, event: "tool_call" as const, server: slug || undefined, tool: toolName, args: auditArgs(args) };

  let denial: string | undefined;
  if (!up) denial = `Unknown tool "${name}"`;
  else if (!up.row.enabled) denial = `Server "${slug}" is disabled`;
  else if (!allowed(up, toolName, p)) denial = `Tool "${name}" is restricted to admins`;
  else if (up.status === "connected" && !up.tools.some((t) => t.name === toolName)) denial = `Unknown tool "${name}"`;
  if (denial) {
    await audit({ ...base, outcome: "denied", error: denial, durationMs: 0 });
    metrics.toolCall(slug || "unknown", "denied", 0);
    throw new ToolNotFoundError(denial);
  }

  const started = Date.now();
  try {
    const result = await up!.callTool(toolName, args);
    const ms = Date.now() - started;
    const outcome = result.isError ? "error" : "ok";
    const errText = result.isError
      ? result.content?.map((c) => (c.type === "text" ? c.text : "")).join(" ").slice(0, 500)
      : undefined;
    await audit({ ...base, outcome, durationMs: ms, error: errText });
    metrics.toolCall(slug, outcome, ms);
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    const message = (err as Error).message;
    await audit({ ...base, outcome: "error", durationMs: ms, error: message });
    metrics.toolCall(slug, "error", ms);
    // Returned as a tool error (not a protocol error) so models can see and explain it.
    return { isError: true, content: [{ type: "text", text: `Gateway error: ${message}` }] };
  }
}
