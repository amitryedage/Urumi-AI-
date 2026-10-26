import { timingSafeEqual, createHash } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WooClient, WooError } from "./woo.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env.PORT ?? 8080);
const STORE_NAME = process.env.STORE_NAME ?? "WooCommerce store";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

const woo = new WooClient({
  baseUrl: env("WC_BASE_URL"),
  siteUrl: env("WC_SITE_URL"),
  consumerKey: env("WC_CONSUMER_KEY"),
  consumerSecret: env("WC_CONSUMER_SECRET"),
  timeoutMs: Number(process.env.WC_TIMEOUT_MS ?? 10000),
});

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

// ---------- result shaping: keep tool output small and model-friendly ----------

type WcProduct = {
  id: number; name: string; status: string; type: string; sku: string; price: string;
  regular_price: string; sale_price: string; stock_status: string; stock_quantity: number | null;
  permalink: string; date_created: string; short_description: string;
};
type WcOrder = {
  id: number; number: string; status: string; currency: string; total: string; date_created: string;
  date_created_gmt: string; payment_method_title: string; customer_note: string;
  billing: { first_name: string; last_name: string; email: string; phone: string };
  line_items: { product_id: number; name: string; quantity: number; total: string }[];
};

const product = (p: WcProduct) => ({
  id: p.id, name: p.name, status: p.status, sku: p.sku || undefined, price: p.price,
  regular_price: p.regular_price, sale_price: p.sale_price || undefined,
  stock_status: p.stock_status, stock_quantity: p.stock_quantity ?? undefined,
  permalink: p.permalink, date_created: p.date_created,
});

const order = (o: WcOrder) => ({
  id: o.id, number: o.number, status: o.status, total: o.total, currency: o.currency,
  date_created: o.date_created, date_created_gmt: o.date_created_gmt,
  payment_method: o.payment_method_title,
  customer: {
    name: `${o.billing?.first_name ?? ""} ${o.billing?.last_name ?? ""}`.trim() || undefined,
    email: o.billing?.email || undefined,
  },
  items: o.line_items?.map((li) => ({ product_id: li.product_id, name: li.name, quantity: li.quantity, total: li.total })),
  customer_note: o.customer_note || undefined,
});

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: Array.isArray(data) ? { items: data } : (data as Record<string, unknown>),
});

async function run(tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = ok(await fn());
    log("tool ok", { tool, ms: Date.now() - started });
    return result;
  } catch (err) {
    const e = err as WooError;
    log("tool error", { tool, ms: Date.now() - started, status: e.status, error: e.message });
    return {
      isError: true,
      content: [{ type: "text", text: `WooCommerce error${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}` }],
    };
  }
}

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// ---------- MCP server definition ----------

function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce-mcp", version: "0.1.0" });

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: `List or search products in ${STORE_NAME}. Returns id, name, price, stock and storefront URL.`,
      inputSchema: {
        search: z.string().optional().describe("Free-text search on product name/description"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).optional().describe("Default: any"),
        per_page: z.number().int().min(1).max(100).optional().describe("Default 20"),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run("list_products", async () => {
        const rows = await woo.request<WcProduct[]>("GET", "/products", {
          query: { search: args.search, status: args.status ?? "any", per_page: args.per_page ?? 20, page: args.page },
        });
        return rows.map(product);
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: `Create a simple product in ${STORE_NAME}. Published products appear on the storefront immediately.`,
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        regular_price: z.union([z.string(), z.number()]).describe("Price in store currency, e.g. \"19.99\""),
        description: z.string().optional(),
        short_description: z.string().optional(),
        sku: z.string().optional(),
        stock_quantity: z.number().int().min(0).optional().describe("If set, stock is managed"),
        status: z.enum(["publish", "draft"]).optional().describe("Default: publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) =>
      run("create_product", async () => {
        const created = await woo.request<WcProduct>("POST", "/products", {
          body: {
            name: args.name,
            type: "simple",
            status: args.status ?? "publish",
            regular_price: String(args.regular_price),
            description: args.description,
            short_description: args.short_description,
            sku: args.sku,
            ...(args.stock_quantity !== undefined ? { manage_stock: true, stock_quantity: args.stock_quantity } : {}),
          },
        });
        return product(created);
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        `List orders in ${STORE_NAME}, newest first. Use created_on=YYYY-MM-DD for "orders on a given day" ` +
        `(interpreted in the store's timezone), or after/before for a custom range.`,
      inputSchema: {
        created_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Calendar day, YYYY-MM-DD"),
        after: z.string().optional().describe("ISO 8601 date-time, store timezone, exclusive"),
        before: z.string().optional().describe("ISO 8601 date-time, store timezone, exclusive"),
        status: z.enum(["any", ...ORDER_STATUSES]).optional().describe("Default: any"),
        search: z.string().optional().describe("Search by customer name/email, etc."),
        per_page: z.number().int().min(1).max(100).optional().describe("Default 20"),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run("list_orders", async () => {
        let { after, before } = args;
        if (args.created_on) {
          // WooCommerce's after/before are exclusive: (day-1 23:59:59, day+1 00:00:00).
          const day = Date.parse(`${args.created_on}T00:00:00Z`);
          after = new Date(day - 1000).toISOString().slice(0, 19);
          before = new Date(day + 86_400_000).toISOString().slice(0, 19);
        }
        const rows = await woo.request<WcOrder[]>("GET", "/orders", {
          query: {
            after, before, status: args.status ?? "any", search: args.search,
            per_page: args.per_page ?? 20, page: args.page, orderby: "date", order: "desc",
          },
        });
        return rows.map(order);
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: `Get one order from ${STORE_NAME} by id, including line items and customer.`,
      inputSchema: { order_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    (args) => run("get_order", async () => order(await woo.request<WcOrder>("GET", `/orders/${args.order_id}`))),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: `Change the status of an order in ${STORE_NAME} (e.g. processing -> completed).`,
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      run("update_order_status", async () =>
        order(await woo.request<WcOrder>("PUT", `/orders/${args.order_id}`, { body: { status: args.status } })),
      ),
  );

  return server;
}

// ---------- HTTP transport ----------

const tokenHash = createHash("sha256").update(AUTH_TOKEN).digest();
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next();
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const ok = timingSafeEqual(createHash("sha256").update(presented).digest(), tokenHash);
  if (!ok) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Stateless Streamable HTTP: a fresh server+transport per request. The gateway is the
// only client, and stateless mode lets this Deployment scale horizontally.
app.post("/mcp", requireToken, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log("mcp request failed", { error: (err as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", requireToken, methodNotAllowed);
app.delete("/mcp", requireToken, methodNotAllowed);

const httpServer = app.listen(PORT, () => log("woo-mcp listening", { port: PORT, auth: Boolean(AUTH_TOKEN) }));
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)));
