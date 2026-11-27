# The app's own database, migrations, env and secrets

This page wins over `AGENTS.md` on these topics. The platform gates (policy `policy/app-rules.rego`) enforce the
rules marked **(policy)**.

## Two kinds of data

- **Governed shared data** (datasets, metrics, knowledge, files, records, agents): only through the OS SDK in
  `src/lib/os` (`os.datasets.query`, `os.metrics.query`, `os.knowledge.search`, `os.files.*`, `os.records.*`,
  `os.agents.run`). Never connect to Trino, OpenSearch, MinIO or the platform's Postgres. **(policy)**
- **The app's own database**: one Postgres database and one role that belong to this app alone, in Dev and in Prod
  (created in the App Builder: Code and runs, Database). Use it for the app's own state (its orders, notes, settings).
  No other app can connect to it, and this app cannot connect to any other.

## Using the app's database

- Only `src/lib/db/` talks to the database, and it is the only place that may import `pg`. **(policy)**
- `pg` reads the standard variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, which the
  platform sets. Never compose a connection URL, never read a password, never read `process.env.PG*`,
  `DATABASE_*` or `POSTGRES_*` anywhere else. **(policy)**
- Always pass values as query parameters (`query('select … where id = $1', [id])`), never inside the SQL text.
- The connection is TLS-encrypted inside the cluster.

## Migrations (schema changes)

- Every schema change is a file in `db/migrations/`, named `NNNN_<what>.sql` with the next number
  (`0002_orders.sql`), in node-pg-migrate's SQL format: a `-- Up Migration` section and a `-- Down Migration` section.
- Keep at least one migration file: the image build copies `db/migrations/`.
- The platform runs `up` before every rollout, from the release image, in one transaction, with a fixed command. A
  failing migration stops the release; the previous release keeps running. You never run migrations against Dev or
  Prod yourself.
- **Forward-only.** A rollback deploys the previous image but never runs `down`: the older code then runs against the
  newer schema. So change the schema in two steps (expand, then contract):
  1. expand: add the new column or table (nullable or with a default) and ship code that works with both shapes;
  2. contract: in a LATER release, once nothing reads the old shape, remove it.
  Never rename or drop something the running code still uses in the same release.
- Previews share the Dev database: the same rule keeps them working.
- `migrate/` is platform-owned (the migration tool, its lockfile and `isolate.mjs`, which closes the database to other roles before the first migration); do not edit it.

## Env and secrets

- The only configuration the app reads is set by the platform: `OS_BASE_URL`, `OS_PUBLIC_URL`, `APP_SLUG`,
  `APP_DOMAIN`, `APP_ENV` (`dev` or `prod`), the `PG*` variables above, and the env variables and secrets the app's
  owner sets in the App Builder (Code and runs, Env) for Dev and Prod separately.
- Ask the owner to set a secret (an API key of a service the app calls through the OS, for example); read it from
  `process.env.<NAME>` in `src/lib`. Names are upper case, digits and `_`; names starting with `PG`, `OS_`, `APP_`
  are the platform's.
- Never write a value into git, a test, a fixture or a log. No `.env` files in git. **(policy)**
- A secret is never shown again after it is saved; to change it, set it again. Changing Prod needs the right to take
  the app live in Prod.

## Backups

Backups of app databases are not set up yet: the Prod database panel says "no backup configured". Do not keep data
in the app database that exists nowhere else until it does.
