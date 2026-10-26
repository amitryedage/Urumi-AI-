import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  createSession, destroySession, requireAdmin, requireUser, type Principal, type User,
} from "./auth.js";
import { runChat, type ChatEvent } from "./chat.js";
import { config } from "./config.js";
import { encrypt, hashPassword, newApiKey, randomToken, sha256, verifyPassword } from "./crypto.js";
import { notify, query } from "./db.js";
import { closeSessions } from "./mcp.js";
import { assertSafeUpstreamUrl, registry, SLUG_RE, type ServerRow } from "./registry.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

async function serversChanged() {
  await registry.reload();
  await notify("servers_changed", "1");
}

function serverView(row: ServerRow, isAdmin: boolean) {
  const up = registry.upstreams.get(row.id);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    // Members see that a server exists and its tools, never where/how it is reached.
    url: isAdmin ? row.url : undefined,
    authType: isAdmin ? row.auth_type : undefined,
    authHeader: isAdmin ? row.auth_header : undefined,
    hasCredential: Boolean(row.credential_enc), // the credential itself never leaves the server
    enabled: row.enabled,
    timeoutMs: row.timeout_ms,
    restrictedTools: row.restricted_tools,
    source: row.source,
    status: row.enabled ? (up?.status ?? "connecting") : "disabled",
    lastError: up?.lastError ?? null,
    lastCheckedAt: up?.lastCheckedAt ?? null,
    latencyMs: up?.latencyMs ?? null,
    serverInfo: up?.serverInfo ?? null,
    tools: (up?.tools ?? [])
      .filter((t) => isAdmin || !row.restricted_tools.includes(t.name))
      .map((t) => ({
        name: t.name,
        qualifiedName: `${row.slug}__${t.name}`,
        description: t.description ?? "",
        restricted: row.restricted_tools.includes(t.name),
        readOnly: t.annotations?.readOnlyHint ?? null,
      })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ServerFields = {
  slug: z.string().regex(SLUG_RE, "lowercase letters, digits and dashes (no underscores)"),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  authType: z.enum(["none", "bearer", "header"]),
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullish(),
  credential: z.string().max(4096).nullish(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(120000),
  restrictedTools: z.array(z.string()),
};
const ServerInput = z.object({
  ...ServerFields,
  authType: ServerFields.authType.default("none"),
  enabled: ServerFields.enabled.default(true),
  timeoutMs: ServerFields.timeoutMs.default(config.upstream.defaultTimeoutMs),
  restrictedTools: ServerFields.restrictedTools.default([]),
});
// No defaults here: omitted fields keep their current value.
const ServerPatch = z.object(ServerFields).omit({ slug: true }).partial();

export function apiRouter(): Router {
  const r = Router();

  // ------------------------------------------------------------------ auth
  r.post("/auth/login", wrap(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const { rows } = await query<User & { password_hash: string; disabled: boolean }>(
      "SELECT id, email, name, role, password_hash, disabled FROM users WHERE email = $1", [email.toLowerCase().trim()],
    );
    const u = rows[0];
    if (!u || u.disabled || !(await verifyPassword(password, u.password_hash))) throw new HttpError(401, "Invalid email or password");
    await createSession(res, u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  }));

  r.post("/auth/logout", wrap(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  }));

  r.get("/auth/me", requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  r.get("/invites/:token", wrap(async (req, res) => {
    const { rows } = await query<{ email: string; role: string }>(
      "SELECT email, role FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()", [sha256(String(req.params.token))],
    );
    if (!rows[0]) throw new HttpError(404, "Invite not found or expired");
    res.json(rows[0]);
  }));

  r.post("/invites/:token/accept", wrap(async (req, res) => {
    const body = parse(z.object({ name: z.string().min(1).max(80), password: z.string().min(8).max(200) }), req.body);
    const { rows } = await query<{ id: string; email: string; role: string }>(
      `UPDATE invites SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
       RETURNING id, email, role`, [sha256(String(req.params.token))],
    );
    const inv = rows[0];
    if (!inv) throw new HttpError(404, "Invite not found or expired");
    const id = randomUUID();
    try {
      await query("INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)", [
        id, inv.email, body.name, inv.role, await hashPassword(body.password),
      ]);
    } catch {
      throw new HttpError(409, "A user with this email already exists");
    }
    await createSession(res, id);
    res.json({ user: { id, email: inv.email, name: body.name, role: inv.role } });
  }));

  // Everything below requires a dashboard session.
  r.use(requireUser);

  r.get("/config", (req, res) => {
    res.json({
      mcpUrl: `${config.publicUrl}/mcp`,
      llm: { provider: config.llm.provider, model: config.llm.model, configured: Boolean(config.llm.apiKey) || config.llm.provider === "openai" },
    });
  });

  // ------------------------------------------------------------------ servers
  r.get("/servers", wrap(async (req, res) => {
    const isAdmin = req.user!.role === "admin";
    const { rows } = await query<ServerRow>("SELECT * FROM servers ORDER BY created_at");
    res.json({ servers: rows.map((row) => serverView(row, isAdmin)) });
  }));

  r.post("/servers", requireAdmin, wrap(async (req, res) => {
    const b = parse(ServerInput, req.body);
    if (b.authType !== "none" && !b.credential) throw new HttpError(400, "credential is required for this auth type");
    await assertSafeUpstreamUrl(b.url).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    const id = randomUUID();
    try {
      await query(
        `INSERT INTO servers (id, slug, name, url, auth_type, auth_header, credential_enc, enabled, timeout_ms, restricted_tools)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, b.slug, b.name, b.url, b.authType, b.authType === "header" ? (b.authHeader || "X-API-Key") : null,
          b.authType !== "none" && b.credential ? encrypt(b.credential) : null, b.enabled, b.timeoutMs, b.restrictedTools],
      );
    } catch {
      throw new HttpError(409, `A server with slug "${b.slug}" already exists`);
    }
    await serversChanged();
    const up = registry.upstreams.get(id);
    await up?.check();
    res.status(201).json({ server: serverView(up!.row, true) });
  }));

  r.patch("/servers/:id", requireAdmin, wrap(async (req, res) => {
    const b = parse(ServerPatch, req.body);
    const { rows } = await query<ServerRow>("SELECT * FROM servers WHERE id = $1", [req.params.id]);
    const cur = rows[0];
    if (!cur) throw new HttpError(404, "Server not found");
    const url = b.url ?? cur.url;
    if (b.url) await assertSafeUpstreamUrl(url).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    const authType = b.authType ?? cur.auth_type;
    // credential: undefined/null = keep existing, "" = clear, string = replace
    let credentialEnc = cur.credential_enc;
    if (typeof b.credential === "string") credentialEnc = b.credential ? encrypt(b.credential) : null;
    if (authType === "none") credentialEnc = null;
    if (authType !== "none" && !credentialEnc) throw new HttpError(400, "credential is required for this auth type");
    // Changing where a credential is sent requires re-entering it, so a stored secret can't be
    // redirected to a new host by editing only the URL.
    if (b.url && b.url !== cur.url && cur.credential_enc && typeof b.credential !== "string") {
      throw new HttpError(400, "Re-enter the credential when changing the URL of a server that has one");
    }
    const { rows: updated } = await query<ServerRow>(
      `UPDATE servers SET name=$2, url=$3, auth_type=$4, auth_header=$5, credential_enc=$6, enabled=$7, timeout_ms=$8,
         restricted_tools=$9, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, b.name ?? cur.name, url, authType, authType === "header" ? (b.authHeader ?? cur.auth_header ?? "X-API-Key") : null,
        credentialEnc, b.enabled ?? cur.enabled, b.timeoutMs ?? cur.timeout_ms, b.restrictedTools ?? cur.restricted_tools],
    );
    await serversChanged();
    await registry.upstreams.get(cur.id)?.check();
    res.json({ server: serverView(updated[0]!, true) });
  }));

  r.delete("/servers/:id", requireAdmin, wrap(async (req, res) => {
    const { rowCount } = await query("DELETE FROM servers WHERE id = $1", [req.params.id]);
    if (!rowCount) throw new HttpError(404, "Server not found");
    await serversChanged();
    res.json({ ok: true });
  }));

  r.post("/servers/:id/refresh", wrap(async (req, res) => {
    const up = registry.upstreams.get(String(req.params.id));
    if (!up) throw new HttpError(404, "Server not found");
    await up.check();
    res.json({ server: serverView(up.row, req.user!.role === "admin") });
  }));

  // ------------------------------------------------------------------ team
  r.get("/users", requireAdmin, wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at AS "createdAt",
         (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS "activeKeys",
         (SELECT max(ts) FROM audit_log a WHERE a.user_id = u.id) AS "lastActivity"
       FROM users u ORDER BY u.created_at`,
    );
    res.json({ users: rows });
  }));

  r.patch("/users/:id", requireAdmin, wrap(async (req, res) => {
    const b = parse(z.object({ role: z.enum(["admin", "member"]).optional(), disabled: z.boolean().optional() }), req.body);
    if (req.params.id === req.user!.id) throw new HttpError(400, "You cannot change your own role or status");
    const { rows } = await query(
      `UPDATE users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled) WHERE id = $1
       RETURNING id, email, name, role, disabled`, [req.params.id, b.role ?? null, b.disabled ?? null],
    );
    if (!rows[0]) throw new HttpError(404, "User not found");
    if (b.disabled) {
      await query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
      closeSessions({ userId: String(req.params.id) });
    }
    res.json({ user: rows[0] });
  }));

  r.delete("/users/:id", requireAdmin, wrap(async (req, res) => {
    if (req.params.id === req.user!.id) throw new HttpError(400, "You cannot remove yourself");
    const { rowCount } = await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    if (!rowCount) throw new HttpError(404, "User not found");
    closeSessions({ userId: String(req.params.id) });
    res.json({ ok: true });
  }));

  r.get("/invites", requireAdmin, wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt" FROM invites
       WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    );
    res.json({ invites: rows });
  }));

  r.post("/invites", requireAdmin, wrap(async (req, res) => {
    const b = parse(z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") }), req.body);
    const email = b.email.toLowerCase();
    const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (exists.rowCount) throw new HttpError(409, "That user already exists");
    const token = randomToken();
    await query(
      "INSERT INTO invites (id, token_hash, email, role, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')",
      [randomUUID(), sha256(token), email, b.role, req.user!.id],
    );
    // No mail server: the admin shares this one-time link. Only its hash is stored.
    res.status(201).json({ url: `${config.publicUrl}/invite/${token}`, email, role: b.role });
  }));

  r.delete("/invites/:id", requireAdmin, wrap(async (req, res) => {
    await query("DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL", [req.params.id]);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ API keys
  r.get("/keys", wrap(async (req, res) => {
    const all = req.query.all === "1" && req.user!.role === "admin";
    const { rows } = await query(
      `SELECT k.id, k.name, k.prefix, k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
         u.id AS "userId", u.email AS "userEmail", u.name AS "userName"
       FROM api_keys k JOIN users u ON u.id = k.user_id ${all ? "" : "WHERE k.user_id = $1"}
       ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
      all ? [] : [req.user!.id],
    );
    res.json({ keys: rows });
  }));

  r.post("/keys", wrap(async (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(80), userId: z.string().uuid().optional() }), req.body);
    const ownerId = b.userId ?? req.user!.id;
    if (ownerId !== req.user!.id && req.user!.role !== "admin") throw new HttpError(403, "Only admins can issue keys for others");
    const owner = await query("SELECT 1 FROM users WHERE id = $1 AND NOT disabled", [ownerId]);
    if (!owner.rowCount) throw new HttpError(404, "User not found");
    const k = newApiKey();
    const id = randomUUID();
    await query("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
      id, ownerId, b.name, k.prefix, k.hash, req.user!.id,
    ]);
    // The plaintext key is returned exactly once.
    res.status(201).json({ id, name: b.name, prefix: k.prefix, key: k.key });
  }));

  r.delete("/keys/:id", wrap(async (req, res) => {
    const isAdmin = req.user!.role === "admin";
    const { rows } = await query<{ id: string }>(
      `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL ${isAdmin ? "" : "AND user_id = $2"}
       RETURNING id`, [req.params.id, req.user!.id],
    );
    if (!rows[0]) throw new HttpError(404, "Key not found or already revoked");
    closeSessions({ apiKeyId: rows[0].id });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ audit
  r.get("/audit", wrap(async (req, res) => {
    const isAdmin = req.user!.role === "admin";
    const q = parse(z.object({
      userId: z.string().uuid().optional(),
      server: z.string().optional(),
      outcome: z.enum(["ok", "error", "denied"]).optional(),
      source: z.enum(["mcp", "chat"]).optional(),
      before: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    // Members only ever see their own activity.
    if (!isAdmin) add("user_id = ?", req.user!.id);
    else if (q.userId) add("user_id = ?", q.userId);
    if (q.server) add("server_slug = ?", q.server);
    if (q.outcome) add("outcome = ?", q.outcome);
    if (q.source) add("source = ?", q.source);
    if (q.before) add("id < ?", q.before);
    params.push(q.limit);
    const { rows } = await query(
      `SELECT id, ts, user_id AS "userId", user_email AS "userEmail", api_key_prefix AS "apiKeyPrefix", source, event,
         server_slug AS server, tool_name AS tool, duration_ms AS "durationMs", outcome, error, args
       FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ entries: rows });
  }));

  r.get("/stats", wrap(async (req, res) => {
    const isAdmin = req.user!.role === "admin";
    const { rows } = await query(
      `SELECT server_slug AS server, count(*)::int AS calls,
         count(*) FILTER (WHERE outcome = 'error')::int AS errors,
         count(*) FILTER (WHERE outcome = 'denied')::int AS denied,
         round(avg(duration_ms) FILTER (WHERE outcome <> 'denied'))::int AS "avgMs",
         (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'denied'))::int AS "p95Ms"
       FROM audit_log WHERE event = 'tool_call' AND ts > now() - interval '24 hours' ${isAdmin ? "" : "AND user_id = $1"}
       GROUP BY server_slug ORDER BY calls DESC`,
      isAdmin ? [] : [req.user!.id],
    );
    res.json({ servers: rows });
  }));

  // ------------------------------------------------------------------ chat (SSE)
  r.post("/chat", wrap(async (req, res) => {
    const b = parse(z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) })).min(1).max(50),
    }), req.body);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    const send = (e: ChatEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const principal: Principal = { user: req.user!, source: "chat" };
    await runChat(principal, b.messages.filter((m) => m.content.trim()), send);
    res.end();
  }));

  // ------------------------------------------------------------------ errors
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });
  return r;
}
