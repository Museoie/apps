# apps

A monorepo of small apps — tiny tools and services, each in its own
directory. Built for things that are too small for their own repo but too
useful to leave as a gist.

## Apps

| App          | What it does                                                        |
|--------------|---------------------------------------------------------------------|
| `pg-gateway` | Minimal HTTP-to-Postgres proxy; runs SQL from HTTP with the DB      |
|              | password supplied per-request in the `Authorization` header. Lets a  |
|              | caller query Postgres without ever holding the password itself.     |

## Conventions

Each app lives in `<app-name>/` and brings:

- `README.md` — what it does, its protocol/API, how to run and deploy it.
- `Dockerfile` — so it can be deployed the same way everywhere.
- `src/` — the code. Keep dependencies minimal and the security surface
  small; these apps often handle credentials.

Keep apps independent: no cross-app imports, no shared build. If something
grows up, graduate it to its own repository.
