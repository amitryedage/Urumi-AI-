import { z } from "zod";

const SeedServer = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string().url(),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  authHeader: z.string().optional(),
  // Name of an env var (populated from a Kubernetes Secret) that holds the credential.
  credentialEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  restrictedTools: z.array(z.string()).optional(),
});
export type SeedServer = z.infer<typeof SeedServer>;

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : ["1", "true", "yes"].includes(v.toLowerCase()));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  // 32-byte key (hex or base64) used to encrypt upstream credentials at rest.
  encryptionKey: required("ENCRYPTION_KEY"),
  publicUrl: (process.env.PUBLIC_URL ?? "http://app.localhost").replace(/\/$/, ""),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 168),

  bootstrapAdmin: {
    email: process.env.ADMIN_EMAIL ?? "",
    password: process.env.ADMIN_PASSWORD ?? "",
    name: process.env.ADMIN_NAME ?? "Admin",
  },
  seedServers: z.array(SeedServer).parse(JSON.parse(process.env.SEED_SERVERS ?? "[]")),

  upstream: {
    defaultTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000),
    connectTimeoutMs: Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS ?? 5000),
    healthIntervalMs: Number(process.env.UPSTREAM_HEALTH_INTERVAL_MS ?? 10000),
    // SSRF guard: private/cluster addresses are only allowed for these host suffixes.
    privateHostAllowlist: (process.env.UPSTREAM_PRIVATE_HOST_ALLOWLIST ?? ".svc.cluster.local,.svc")
      .split(",").map((s) => s.trim()).filter(Boolean),
    allowAllPrivate: bool(process.env.UPSTREAM_ALLOW_ALL_PRIVATE, false),
  },

  mcp: {
    sessionIdleMinutes: Number(process.env.MCP_SESSION_IDLE_MINUTES ?? 60),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai",
    model: process.env.LLM_MODEL ?? "claude-opus-5",
    apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.LLM_BASE_URL || undefined, // OpenAI-compatible endpoint (Groq, Gemini, Ollama, ...)
    // Server-side refusal fallbacks (Claude API only). "default" or "off".
    fallbacks: process.env.LLM_FALLBACKS ?? "default",
    maxToolRounds: Number(process.env.CHAT_MAX_TOOL_ROUNDS ?? 8),
    // Above this many tools the agent switches to search_tools/call_tool meta-tools.
    toolSearchThreshold: Number(process.env.CHAT_TOOL_SEARCH_THRESHOLD ?? 40),
    timezone: process.env.CHAT_TIMEZONE ?? "UTC",
  },
};
