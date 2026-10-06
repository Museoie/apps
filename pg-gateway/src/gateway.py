"""pg-gateway: minimal HTTP -> Postgres proxy.

Lets a caller run parameterized SQL over HTTP without ever handling the
database password itself. The password arrives in the Authorization header
(in our setup it is injected by the credential vault's egress proxy, which
replaces a placeholder with the real secret on the way out); this server
uses it once to open the Postgres connection, then discards it. The
password is never logged, never stored, and never appears in responses.

Protocol
--------
GET  /health   -> {"ok": true}                      (no auth, for probes)
POST /query
  Authorization: Bearer <db-password>
  {"sql": "select ...", "params": [...]}
  -> {"columns": [...], "rows": [[...]], "rowCount": n, "truncated": bool}
  -> {"error": "..."} with 4xx/5xx on failure

Configuration (environment)
---------------------------
PGHOST                Postgres host (required)
PGPORT                Postgres port (default 5432)
PGDATABASE            Database name (required)
PGUSER                Database user (required)
PGSSLMODE             libpq sslmode (default "require")
PORT                  HTTP listen port (default 8080)
STATEMENT_TIMEOUT_MS  per-query timeout (default 30000)
MAX_ROWS              max rows returned per query (default 10000)

Write protection is enforced by the database role's own grants (this
gateway is meant to be used with a read-only role). The gateway itself
does not try to parse or restrict SQL.
"""

import json
import logging
import os
import urllib.parse
from datetime import date, datetime, time
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID

import psycopg


class Config:
    def __init__(self) -> None:
        self.pghost = os.environ["PGHOST"]
        self.pgport = int(os.environ.get("PGPORT", "5432"))
        self.pgdatabase = os.environ["PGDATABASE"]
        self.pguser = os.environ["PGUSER"]
        self.pgsslmode = os.environ.get("PGSSLMODE", "require")
        self.port = int(os.environ.get("PORT", "8080"))
        self.statement_timeout_ms = int(os.environ.get("STATEMENT_TIMEOUT_MS", "30000"))
        self.max_rows = int(os.environ.get("MAX_ROWS", "10000"))
        self.max_body_bytes = int(os.environ.get("MAX_BODY_BYTES", "1000000"))


CFG = Config()


def to_jsonable(value):
    """Convert Postgres driver types into JSON-serializable values."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    return str(value)


def run_query(password: str, query: str, params: list):
    conn = psycopg.connect(
        host=CFG.pghost,
        port=CFG.pgport,
        dbname=CFG.pgdatabase,
        user=CFG.pguser,
        password=password,
        sslmode=CFG.pgsslmode,
        connect_timeout=10,
        options=f"-c statement_timeout={CFG.statement_timeout_ms}",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            columns = [d.name for d in cur.description] if cur.description else []
            rows = cur.fetchmany(CFG.max_rows + 1)
            truncated = len(rows) > CFG.max_rows
            rows = rows[: CFG.max_rows]
            return {
                "columns": columns,
                "rows": [[to_jsonable(v) for v in row] for row in rows],
                "rowCount": len(rows),
                "truncated": truncated,
            }
    finally:
        conn.close()


def error_message(exc: Exception) -> str:
    # psycopg messages never contain the password; still, keep it short
    # and never echo connection parameters.
    return str(exc).splitlines()[0][:500] if str(exc) else type(exc).__name__


class Handler(BaseHTTPRequestHandler):
    server_version = "pg-gateway/1.0"

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    def do_GET(self) -> None:  # noqa: N802
        if self._path() == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self._path() != "/query":
            self._send(404, {"error": "not found"})
            return

        auth = self.headers.get("Authorization", "")
        scheme, _, token = auth.partition(" ")
        password = token.strip()
        if scheme.lower() != "bearer" or not password:
            self._send(401, {"error": "missing bearer token"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "invalid content-length"})
            return
        if length <= 0 or length > CFG.max_body_bytes:
            self._send(400 if length <= 0 else 413, {"error": "invalid body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._send(400, {"error": "invalid JSON body"})
            return

        query = payload.get("sql")
        params = payload.get("params", [])
        if not isinstance(query, str) or not query.strip():
            self._send(400, {"error": "body.sql must be a non-empty string"})
            return
        if not isinstance(params, list):
            self._send(400, {"error": "body.params must be a list"})
            return

        try:
            result = run_query(password, query, params)
        except psycopg.Error as exc:
            logging.warning("query failed: %s", error_message(exc))
            self._send(400, {"error": error_message(exc)})
            return
        except Exception:  # defensive: never leak internals
            logging.exception("unexpected error")
            self._send(500, {"error": "internal error"})
            return
        self._send(200, result)

    def log_message(self, fmt, *args) -> None:
        # Deliberately minimal: never log headers (Authorization carries
        # the database password).
        logging.info("%s %s -> handled", self.command, self._path())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = ThreadingHTTPServer(("0.0.0.0", CFG.port), Handler)
    logging.info(
        "pg-gateway listening on :%d -> %s:%d/%s as %s",
        CFG.port, CFG.pghost, CFG.pgport, CFG.pgdatabase, CFG.pguser,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
