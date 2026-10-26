export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type ServerStatus = "connected" | "unreachable" | "disabled" | "connecting";

export interface ServerTool {
  name: string;
  qualifiedName: string;
  description: string;
  restricted: boolean;
  readOnly: boolean | null;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  url?: string;
  authType?: "none" | "bearer" | "header";
  authHeader?: string | null;
  hasCredential: boolean;
  enabled: boolean;
  timeoutMs: number;
  restrictedTools: string[];
  source: string;
  status: ServerStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  serverInfo: { name: string; version: string } | null;
  tools: ServerTool[];
  createdAt: string;
  updatedAt: string;
}

export interface ServerStat {
  server: string | null;
  calls: number;
  errors: number;
  denied: number;
  avgMs: number | null;
  p95Ms: number | null;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  activeKeys: number;
  lastActivity: string | null;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  userId: string;
  userEmail: string;
  userName: string;
}

export interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  userId: string | null;
  userEmail: string | null;
  apiKeyPrefix: string | null;
  source: "mcp" | "chat";
  event: "tool_call" | "auth";
  server: string | null;
  tool: string | null;
  durationMs: number | null;
  outcome: "ok" | "error" | "denied";
  error: string | null;
  args: unknown;
}

export interface AppConfig {
  mcpUrl: string;
  llm: { provider: string; model: string; configured: boolean };
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; server: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; durationMs: number; preview: string }
  | { type: "error"; message: string }
  | { type: "done" };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  // The gateway requires JSON content-type on every mutation (CSRF defence), even without a body.
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "include",
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `Request failed (HTTP ${res.status})`;
    if (res.status === 401 && path !== "/auth/me" && path !== "/auth/login") {
      window.dispatchEvent(new Event("mcpgw:unauthorized"));
    }
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export interface ServerInput {
  slug?: string;
  name?: string;
  url?: string;
  authType?: "none" | "bearer" | "header";
  authHeader?: string | null;
  credential?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
  restrictedTools?: string[];
}

export const api = {
  me: () => request<{ user: User }>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ user: User }>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  getInvite: (token: string) => request<{ email: string; role: Role }>("GET", `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, name: string, password: string) =>
    request<{ user: User }>("POST", `/invites/${encodeURIComponent(token)}/accept`, { name, password }),

  config: () => request<AppConfig>("GET", "/config"),

  servers: () => request<{ servers: Server[] }>("GET", "/servers"),
  createServer: (input: ServerInput) => request<{ server: Server }>("POST", "/servers", input),
  updateServer: (id: string, input: ServerInput) => request<{ server: Server }>("PATCH", `/servers/${id}`, input),
  deleteServer: (id: string) => request<{ ok: true }>("DELETE", `/servers/${id}`),
  refreshServer: (id: string) => request<{ server: Server }>("POST", `/servers/${id}/refresh`),
  stats: () => request<{ servers: ServerStat[] }>("GET", "/stats"),

  users: () => request<{ users: Member[] }>("GET", "/users"),
  updateUser: (id: string, patch: { role?: Role; disabled?: boolean }) => request<{ user: Member }>("PATCH", `/users/${id}`, patch),
  deleteUser: (id: string) => request<{ ok: true }>("DELETE", `/users/${id}`),
  invites: () => request<{ invites: Invite[] }>("GET", "/invites"),
  createInvite: (email: string, role: Role) => request<{ url: string; email: string; role: Role }>("POST", "/invites", { email, role }),
  deleteInvite: (id: string) => request<{ ok: true }>("DELETE", `/invites/${id}`),

  keys: (all = false) => request<{ keys: ApiKey[] }>("GET", `/keys${all ? "?all=1" : ""}`),
  createKey: (name: string, userId?: string) => request<CreatedKey>("POST", "/keys", { name, userId }),
  revokeKey: (id: string) => request<{ ok: true }>("DELETE", `/keys/${id}`),

  audit: (f: { userId?: string; server?: string; outcome?: string; source?: string; before?: number; limit?: number }) =>
    request<{ entries: AuditEntry[] }>("GET", `/audit${qs(f)}`),
};

/** POST /api/chat and stream Server-Sent Events back to the caller. */
export async function streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `Chat failed (HTTP ${res.status})`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
