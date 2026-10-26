import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { query } from "./db.js";
import { hashPassword, randomToken, sha256 } from "./crypto.js";
import { log } from "./log.js";

export type Role = "admin" | "member";
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}
/** Who is acting, and through which credential. Used for policy and audit. */
export interface Principal {
  user: User;
  source: "mcp" | "chat";
  apiKeyId?: string;
  apiKeyPrefix?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export const SESSION_COOKIE = "mcpgw_session";

export async function createSession(res: Response, userId: string) {
  const token = randomToken();
  const ttlMs = config.sessionTtlHours * 3600_000;
  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    sha256(token), userId, new Date(Date.now() + ttlMs),
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: config.cookieSecure, maxAge: ttlMs, path: "/",
  });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Dashboard auth: resolves the session cookie to a user (if any). */
export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const { rows } = await query<User>(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
      [sha256(token)],
    );
    if (rows[0]) req.user = rows[0];
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}

/**
 * CSRF defence for cookie-authenticated mutations: browsers cannot send a cross-site
 * request with Content-Type: application/json without a CORS preflight, which we never allow.
 */
export function requireJsonForMutations(req: Request, res: Response, next: NextFunction) {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && type !== "application/json") {
    res.status(415).json({ error: "Content-Type must be application/json" });
    return;
  }
  next();
}

export type ApiKeyLookup =
  | { ok: true; user: User; apiKeyId: string; prefix: string }
  | { ok: false; reason: string; user?: User; apiKeyId?: string; prefix?: string };

/** Gateway (MCP) auth: resolves `Authorization: Bearer mcpgw_...` to a user. */
export async function resolveApiKey(header: string | undefined): Promise<ApiKeyLookup> {
  const key = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) return { ok: false, reason: "Missing bearer token" };
  const { rows } = await query<User & { key_id: string; prefix: string; revoked_at: Date | null; disabled: boolean }>(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, k.id AS key_id, k.prefix, k.revoked_at
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "Invalid API key" };
  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  if (row.revoked_at) return { ok: false, reason: "API key has been revoked", user, apiKeyId: row.key_id, prefix: row.prefix };
  if (row.disabled) return { ok: false, reason: "User is disabled", user, apiKeyId: row.key_id, prefix: row.prefix };
  void query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.key_id]);
  return { ok: true, user, apiKeyId: row.key_id, prefix: row.prefix };
}

export async function bootstrapAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  const { rows } = await query<{ n: string }>("SELECT count(*)::text AS n FROM users");
  if (rows[0]?.n !== "0") return;
  if (!email || !password) {
    log.warn("no users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set; dashboard login impossible");
    return;
  }
  await query("INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4)", [
    randomUUID(), email.toLowerCase(), name, await hashPassword(password),
  ]);
  log.info("bootstrapped admin user", { email });
}
