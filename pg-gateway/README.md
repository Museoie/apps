# pg-gateway

A tiny HTTP-to-Postgres proxy written in TypeScript for the [Bun](https://bun.sh)
runtime. It exists for one reason: to let a caller run SQL over HTTP while the
database password is injected by the caller's credential vault (as an
`Authorization: Bearer` header) instead of being handed to the caller
directly. The gateway uses the password once per request to open the
Postgres connection, then discards it. It never logs, stores, or echoes the
password.

## Protocol

```
GET  /health   -> {"ok": true}                      (no auth; for probes)

POST /query
  Authorization: Bearer <db-password>
  Content-Type: application/json

  {"connection": "budget", "sql": "select id, name from users where id = $1", "params": ["..."]}
```

Response `200`:

```json
{"columns": ["id", "name"], "rows": [["...", "..."]], "rowCount": 1, "truncated": false}
```

Errors come back as `{"error": "..."}` with a 4xx/5xx status. Queries are
parameterized server-side, and results are capped (`MAX_ROWS`) with a
per-query statement timeout.

## Configuration

All via environment. The gateway can serve any number of databases: each
gets a name in `PG_CONNECTIONS`, and requests pick one with
`"connection": "<name>"`. Connection destinations always come from this
server-side config — never from the request — so the gateway can't be
abused to probe arbitrary hosts (SSRF).

| Var                    | Required | Default     | Notes                                       |
|------------------------|----------|-------------|---------------------------------------------|
| `PG_CONNECTIONS`       | yes      | —           | JSON map: name → `{host, port?, database,   |
|                        |          |             | username, sslmode?}`. `port` defaults to   |
|                        |          |             | 5432, `sslmode` to `require`.               |
| `PORT`                 | no       | `8080`      | HTTP listen port                            |
| `STATEMENT_TIMEOUT_MS` | no       | `30000`     | Per-query timeout                           |
| `MAX_ROWS`             | no       | `10000`     | Max rows returned per query                 |

Example:

```bash
export PG_CONNECTIONS='{
  "budget": {"host": "postgres.hoie.kim", "database": "budget", "username": "museoie"},
  "inbox":  {"host": "postgres.hoie.kim", "database": "inbox",  "username": "museoie"}
}'
```

## Run it

```bash
# local
bun install
bun src/gateway.ts

# docker
docker build -t pg-gateway .
docker run -p 8080:8080 -e PG_CONNECTIONS="$PG_CONNECTIONS" pg-gateway
```

Test:

```bash
curl -s localhost:8080/health
curl -s -X POST localhost:8080/query \
  -H "Authorization: Bearer $DB_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"connection": "budget", "sql": "select current_user, current_database()"}'
```

## Deploy notes

- **Serve it over HTTPS.** The database password travels in the
  `Authorization` header; terminate TLS in front of the gateway (Caddy,
  Traefik, a cloud load balancer, etc.).
- **Restrict who can reach it.** Ideally allowlist the caller's egress IPs
  at the network layer. Anyone who can reach the gateway *and* knows a valid
  database password can run queries as that role.
- **Keep the database role least-privilege.** Write protection is enforced
  by the role's own grants, not by this gateway — pair it with a read-only
  role that only has the `SELECT` grants it needs.
- `/health` is unauthenticated on purpose (load-balancer probes). Everything
  else needs the bearer token.
