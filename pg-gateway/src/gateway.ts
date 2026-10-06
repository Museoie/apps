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
 * Protocol
 * --------
 * GET  /health   -> {"ok": true}                      (no auth, for probes)
 * POST /query
 *   Authorization: Bearer <db-password>
 *   {"sql": "select ...", "params": [...]}
 *   -> {"columns": [...], "rows": [[...]], "rowCount": n, "truncated": bool}
 *   -> {"error": "..."} with 4xx/5xx on failure
 *
 * Configuration (environment)
 * ---------------------------
 * PGHOST                Postgres host (required)
 * PGPORT                Postgres port (default 5432)
 * PGDATABASE            Database name (required)
 * PGUSER                Database user (required)
 * PGSSLMODE             "require" (default) or "disable"
 * PORT                  HTTP listen port (default 8080)
 * STATEMENT_TIMEOUT_MS  per-query timeout (default 30000)
 * MAX_ROWS              max rows returned per query (default 10000)
 *
 * Write protection is enforced by the database role's own grants (this
 * gateway is meant to be used with a read-only role). The gateway itself
 * does not try to parse or restrict SQL.
 */

import postgres from "postgres";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

const CFG = {
  pghost: requiredEnv("PGHOST"),
  pgport: parseInt(process.env.PGPORT ?? "5432", 10),
  pgdatabase: requiredEnv("PGDATABASE"),
  pguser: requiredEnv("PGUSER"),
  pgsslmode: process.env.PGSSLMODE ?? "require",
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
  const sqlText = payload?.sql;
  const params = payload?.params ?? [];
  if (typeof sqlText !== "string" || !sqlText.trim()) {
    return jsonResponse({ error: "body.sql must be a non-empty string" }, 400);
  }
  if (!Array.isArray(params)) {
    return jsonResponse({ error: "body.params must be a list" }, 400);
  }

  const sql = postgres({
    host: CFG.pghost,
    port: CFG.pgport,
    database: CFG.pgdatabase,
    username: CFG.pguser,
    password,
    ssl: CFG.pgsslmode === "disable" ? false : "require",
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
// the database password).
console.log(
  `pg-gateway listening on :${CFG.port} -> ${CFG.pghost}:${CFG.pgport}/${CFG.pgdatabase} as ${CFG.pguser}`,
);
