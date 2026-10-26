import pg from "pg";
import { config } from "./config.js";
import { log } from "./log.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY,
     email text NOT NULL UNIQUE,
     name text NOT NULL,
     role text NOT NULL CHECK (role IN ('admin','member')),
     password_hash text NOT NULL,
     disabled boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS sessions (
     token_hash text PRIMARY KEY,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS invites (
     id uuid PRIMARY KEY,
     token_hash text NOT NULL UNIQUE,
     email text NOT NULL,
     role text NOT NULL CHECK (role IN ('admin','member')),
     invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
     expires_at timestamptz NOT NULL,
     accepted_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS api_keys (
     id uuid PRIMARY KEY,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name text NOT NULL,
     prefix text NOT NULL,
     key_hash text NOT NULL UNIQUE,
     created_by uuid REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_used_at timestamptz,
     revoked_at timestamptz,
     revoked_by uuid REFERENCES users(id) ON DELETE SET NULL
   );
   CREATE TABLE IF NOT EXISTS servers (
     id uuid PRIMARY KEY,
     slug text NOT NULL UNIQUE,
     name text NOT NULL,
     url text NOT NULL,
     auth_type text NOT NULL CHECK (auth_type IN ('none','bearer','header')),
     auth_header text,
     credential_enc text,
     enabled boolean NOT NULL DEFAULT true,
     timeout_ms integer NOT NULL,
     restricted_tools text[] NOT NULL DEFAULT '{}',
     source text NOT NULL DEFAULT 'dashboard',
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS audit_log (
     id bigserial PRIMARY KEY,
     ts timestamptz NOT NULL DEFAULT now(),
     user_id uuid,
     user_email text,
     api_key_id uuid,
     api_key_prefix text,
     source text NOT NULL,
     event text NOT NULL,
     server_slug text,
     tool_name text,
     duration_ms integer,
     outcome text NOT NULL CHECK (outcome IN ('ok','error','denied')),
     error text,
     args jsonb
   );
   CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
   CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, ts DESC);`,
];

export async function migrate() {
  const client = await pool.connect();
  try {
    // Several gateway replicas may start at once; serialize migrations with an advisory lock.
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    for (const [i, sql] of MIGRATIONS.entries()) {
      const version = i + 1;
      if (applied.has(version)) continue;
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      log.info("applied migration", { version });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}

/** Cross-replica change notifications (Postgres LISTEN/NOTIFY). */
export async function listen(channel: string, onMessage: (payload: string) => void) {
  const connect = async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on("error", (err) => {
      log.warn("listen connection lost, reconnecting", { error: err.message });
      setTimeout(() => void connect().catch(() => {}), 2000);
    });
    client.on("notification", (msg) => onMessage(msg.payload ?? ""));
    await client.connect();
    await client.query(`LISTEN ${channel}`);
  };
  await connect();
}

export async function notify(channel: string, payload: string) {
  await query("SELECT pg_notify($1, $2)", [channel, payload]);
}
