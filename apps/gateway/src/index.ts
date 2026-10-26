import { randomUUID } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import { apiRouter } from "./api.js";
import { bootstrapAdmin, requireJsonForMutations, sessionMiddleware } from "./auth.js";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { migrate, pool, query } from "./db.js";
import { log } from "./log.js";
import { mcpRouter, sessionCount } from "./mcp.js";
import { metrics } from "./metrics.js";
import { registry } from "./registry.js";

/** Register servers declared in Helm values once; afterwards the dashboard owns them. */
async function seedServers() {
  for (const s of config.seedServers) {
    const exists = await query("SELECT 1 FROM servers WHERE slug = $1", [s.slug]);
    if (exists.rowCount) continue;
    const credential = s.credentialEnv ? process.env[s.credentialEnv] : undefined;
    if (s.authType !== "none" && !credential) {
      log.warn("seed server credential missing; skipping", { slug: s.slug, env: s.credentialEnv });
      continue;
    }
    await query(
      `INSERT INTO servers (id, slug, name, url, auth_type, auth_header, credential_enc, timeout_ms, restricted_tools, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'helm') ON CONFLICT (slug) DO NOTHING`,
      [randomUUID(), s.slug, s.name, s.url, s.authType, s.authType === "header" ? (s.authHeader ?? "X-API-Key") : null,
        credential ? encrypt(credential) : null, s.timeoutMs ?? config.upstream.defaultTimeoutMs, s.restrictedTools ?? []],
    );
    log.info("seeded upstream server", { slug: s.slug, url: s.url });
  }
}

/** Postgres may start after the gateway (fresh install, node reboot): wait instead of crash-looping. */
async function waitForDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (attempt >= 60) throw err;
      log.warn("database not ready, retrying", { attempt, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await waitForDatabase();
  await migrate();
  await bootstrapAdmin();
  await seedServers();
  await registry.start();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Probes: liveness = process is serving; readiness = database reachable.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, upstreams: registry.list().length, mcpSessions: sessionCount() });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(metrics.render());
  });

  app.use(express.json({ limit: "2mb" }));
  app.use(mcpRouter());
  app.use("/api", cookieParser(), requireJsonForMutations, sessionMiddleware, apiRouter());

  const server = app.listen(config.port, () => log.info("gateway listening", { port: config.port, publicUrl: config.publicUrl }));
  const shutdown = () => {
    log.info("shutting down");
    registry.stop();
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("fatal", { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
