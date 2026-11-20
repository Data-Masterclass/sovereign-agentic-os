# node-pg-migrate

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (`gh api repos/salsita/node-pg-migrate --jq .license.spdx_id` → `MIT`, 20 Nov 2026)
- **Source:** https://github.com/salsita/node-pg-migrate
- **Pinned as:** npm `node-pg-migrate@9.0.0` (exact, in `os-ui/package.json` and `os-ui/package-lock.json`; released 17 Jul 2026). Peer `pg >=4.3.0 <9.0.0`.
- **Docs used (tag `v9.0.0`, fetched 20 Nov 2026):**
  - Programmatic API, `runner({ databaseUrl, dir, direction, count, migrationsSchema, migrationsTable, createMigrationsSchema, singleTransaction })`: https://github.com/salsita/node-pg-migrate/blob/v9.0.0/docs/src/api.md
  - CLI: https://github.com/salsita/node-pg-migrate/blob/v9.0.0/docs/src/cli.md
  - SQL migration files (default `legacySql` loader: one `.sql` file with `-- Up Migration` and `-- Down Migration` sections): https://github.com/salsita/node-pg-migrate/blob/v9.0.0/docs/src/migration-loading-strategies.md

**Why the OS ships it:** the migration tool for the Postgres `os_governance` schema (design 00 §3.5:
"plain SQL migrations … or `node-pg-migrate` (MIT). Do not add an ORM."). Migrations are plain SQL
files in `os-ui/core/adapters/postgres/migrations/`. The OS does not have its own migration runner:
`migrate.ts` only passes fixed options to node-pg-migrate's documented `runner()`. The same files run
with the upstream CLI and no OS code:

```bash
DATABASE_URL=postgres://… npx node-pg-migrate up \
  -m os-ui/core/adapters/postgres/migrations \
  --migrations-schema os_migrations --create-migrations-schema \
  --migrations-table governance_migrations
```

The glue that uses this pin lives in `os-ui/core/adapters/postgres/`; nothing we wrote belongs here.
