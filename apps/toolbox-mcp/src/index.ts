import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.TOOLBOX_API_KEY ?? "";

// Fixed reference rates (USD base) so the demo is deterministic and works offline.
const USD_RATES: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.2, JPY: 151.4, AUD: 1.52, CAD: 1.36, SGD: 1.35, AED: 3.67, CHF: 0.9,
};

const text = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: "toolbox-mcp", version: "0.1.0" });

  server.registerTool(
    "get_current_time",
    {
      title: "Current time",
      description: "Current date and time in an IANA time zone (e.g. Asia/Kolkata, Europe/Berlin). Default UTC.",
      inputSchema: { timezone: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ timezone }) => {
      const tz = timezone ?? "UTC";
      try {
        const now = new Date();
        const local = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).format(now);
        return text({ timezone: tz, local, utc: now.toISOString() });
      } catch {
        return fail(`Unknown time zone: ${tz}`);
      }
    },
  );

  server.registerTool(
    "convert_currency",
    {
      title: "Convert currency",
      description: `Convert an amount between currencies using fixed reference rates. Supported: ${Object.keys(USD_RATES).join(", ")}.`,
      inputSchema: {
        amount: z.number(),
        from: z.string().length(3).describe("ISO 4217 code, e.g. USD"),
        to: z.string().length(3).describe("ISO 4217 code, e.g. EUR"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ amount, from, to }) => {
      const f = USD_RATES[from.toUpperCase()];
      const t = USD_RATES[to.toUpperCase()];
      if (!f || !t) return fail(`Unsupported currency. Supported: ${Object.keys(USD_RATES).join(", ")}`);
      const converted = Math.round((amount / f) * t * 100) / 100;
      return text({ amount, from: from.toUpperCase(), to: to.toUpperCase(), rate: t / f, converted });
    },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo a message back (toolbox version).",
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => text({ echo: message, from: "toolbox" }),
  );

  server.registerTool(
    "sleep",
    {
      title: "Sleep",
      description: "Wait N seconds, then return. Useful to test timeouts.",
      inputSchema: { seconds: z.number().min(0).max(120) },
      annotations: { readOnlyHint: true },
    },
    async ({ seconds }) => {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return text({ slept: seconds });
    },
  );

  return server;
}

const keyHash = createHash("sha256").update(API_KEY).digest();
function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next();
  const presented = createHash("sha256").update(req.header("x-api-key") ?? "").digest();
  if (!timingSafeEqual(presented, keyHash)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.post("/mcp", requireKey, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").end();
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const httpServer = app.listen(PORT, () => console.log(JSON.stringify({ msg: "toolbox-mcp listening", port: PORT })));
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
