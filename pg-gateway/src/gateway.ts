/**
 * pg-gateway: minimal HTTP -> Postgres proxy.
 *
 * Lets a caller run parameterized SQL over HTTP without ever handling the
 * database password itself. The password arrives in the Authorization header
 * (in our setup it is injected by the credential vault's egress proxy, which
 * replaces a placeholder with the real secret on the way out); this server
 * uses it once per request to open the Postgres connection, then discards
 * it. The password is never logged, never stored, and never appears in
 * responses.
 *
 * The gateway serves any number of pre-configured connections. Connection
 * details (host/port/database/user) come from server config; the request
 * only names which connection to use. Destinations are never taken from the
 * request itself — letting callers dial arbitrary host:ports would turn the
 * gateway into an SSRF oracle into the network it runs on.
 *
 * Protocol
 * --------
 * GET  /health   -> {"ok": true}                      (no auth, for probes)
 * POST /query
 *   Authorization: Bearer <db-password>
 *   {"connection": "budget", "sql": "select ...", "params": [...]}
 *   -> {"columns": [...], "rows": [[...]], "rowCount": n, "truncated": bool}
 *   -> {"error": "..."} with 4xx/5xx on failure
 *
 * Configuration (environment)
 * ---------------------------
 * PG_CONNECTIONS          JSON map of name -> {host, port?, database,
 *                         username, sslmode?}. Required. Example:
 *                         {"budget":{"host":"db.internal","database":"budget",
 *                          "username":"museoie"},
 *                          "inbox":{"host":"db.internal","port":5433,
 *                          "database":"inbox","username":"museoie"}}
 *                         port defaults to 5432, sslmode to "require".
 * PORT                    HTTP listen port (default 8080)
 * STATEMENT_TIMEOUT_MS    per-query timeout (default 30000)
 * MAX_ROWS                max rows returned per query (default 10000)
 *
 * Write protection is enforced by the database roles' own grants (this
 * gateway is meant to be used with read-only roles). The gateway itself
 * does not try to parse or restrict SQL.
 */

import postgres from "postgres";

interface ConnDef {
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
}

function loadConnections(): Record<string, ConnDef> {
  const raw = process.env.PG_CONNECTIONS;
  if (!raw) throw new Error("missing required env PG_CONNECTIONS");
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PG_CONNECTIONS is not valid JSON");
  }
  const out: Record<string, ConnDef> = {};
  for (const [name, c] of Object.entries(parsed ?? {})) {
    if (!c || typeof c !== "object") throw new Error(`connection "${name}" is not an object`);
    if (!c.host || !c.database || !c.username) {
      throw new Error(`connection "${name}" needs host, database and username`);
    }
    out[name] = {
      host: String(c.host),
      port: c.port ?? 5432,
      database: String(c.database),
      username: String(c.username),
      sslmode: c.sslmode ?? "require",
    };
  }
  if (Object.keys(out).length === 0) throw new Error("PG_CONNECTIONS defines no connections");
  return out;
}

const CONNECTIONS = loadConnections();

const CFG = {
  port: parseInt(process.env.PORT ?? "8080", 10),
  statementTimeoutMs: parseInt(process.env.STATEMENT_TIMEOUT_MS ?? "30000", 10),
  maxRows: parseInt(process.env.MAX_ROWS ?? "10000", 10),
  maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES ?? "1000000", 10),
};

function toJSONable(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString(); // int8 may exceed 2^53
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(toJSONable);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJSONable(v),
      ]),
    );
  }
  return String(value);
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleQuery(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^\s*Bearer\s+(.+?)\s*$/.exec(auth);
  if (!bearer) return jsonResponse({ error: "missing bearer token" }, 401);
  const password = bearer[1];

  const declared = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (declared > CFG.maxBodyBytes) {
    return jsonResponse({ error: "body too large" }, 413);
  }
  const bodyText = await req.text();
  if (Buffer.byteLength(bodyText) > CFG.maxBodyBytes) {
    return jsonResponse({ error: "body too large" }, 413);
  }

  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const connectionName = payload?.connection;
  const sqlText = payload?.sql;
  const params = payload?.params ?? [];
  const conn = typeof connectionName === "string" ? CONNECTIONS[connectionName] : undefined;
  if (!conn) {
    return jsonResponse(
      { error: `unknown connection (available: ${Object.keys(CONNECTIONS).join(", ")})` },
      400,
    );
  }
  if (typeof sqlText !== "string" || !sqlText.trim()) {
    return jsonResponse({ error: "body.sql must be a non-empty string" }, 400);
  }
  if (!Array.isArray(params)) {
    return jsonResponse({ error: "body.params must be a list" }, 400);
  }

  const sql = postgres({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    password,
    ssl: conn.sslmode === "disable" ? false : "require",
    max: 1,
    connect_timeout: 10,
  });
  try {
    await sql.unsafe(`SET statement_timeout = ${CFG.statementTimeoutMs}`);
    const rows = await sql.unsafe(sqlText, params);
    const sliced = rows.slice(0, CFG.maxRows);
    const first = sliced[0] as Record<string, unknown> | undefined;
    return jsonResponse({
      columns: first ? Object.keys(first) : [],
      rows: sliced.map((r) =>
        Object.values(r as Record<string, unknown>).map(toJSONable),
      ),
      rowCount: sliced.length,
      truncated: rows.length > CFG.maxRows,
    });
  } catch (e) {
    // postgres errors never contain the password; still keep it short and
    // never echo connection parameters.
    const msg =
      e instanceof Error ? e.message.split("\n")[0].slice(0, 500) : "query failed";
    console.warn("query failed:", msg);
    return jsonResponse({ error: msg || "query failed" }, 400);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Bun.serve({
  port: CFG.port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") {
      return jsonResponse({ ok: true });
    }
    if (req.method === "POST" && pathname === "/query") {
      return handleQuery(req);
    }
    return jsonResponse({ error: "not found" }, 404);
  },
});

// Deliberately minimal logging: never log headers (Authorization carries
// the database password), and log connection names only.
console.log(
  `pg-gateway listening on :${CFG.port} (connections: ${Object.keys(CONNECTIONS).join(", ")})`,
);
