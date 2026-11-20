# pg-boss

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** MIT (`gh api repos/timgit/pg-boss --jq .license.spdx_id` → `MIT`, 20 Nov 2026)
- **Source:** https://github.com/timgit/pg-boss
- **Pinned as:** npm `pg-boss@12.38.2` (exact, in `os-ui/package.json` and `os-ui/package-lock.json`). pg-boss schema version **46** (release notes 12.38.0–12.38.2).
- **Runtime:** Node ≥ 22.12 (package `engines`); driver `pg ^8.23.1` (the OS pins `pg@8.23.1`).
- **Docs used (fetched 20 Nov 2026 from the repo's `docs/` at the 12.38.2 tag line):**
  - Constructor, `schema`, `migrate`, `schedule`, `supervise`: https://github.com/timgit/pg-boss/blob/master/docs/api/constructor.md
  - `send(name, data, options)` with `db` (`executeSql(text, values)`), `singletonKey`, `retryLimit`, `retryDelay`, `retryBackoff`: https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md
  - Queue policies (`standard`, `short`, `singleton`, `stately`, …): https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md
  - `schedule(name, cron, data, { tz })`, `getSchedules()`: https://github.com/timgit/pg-boss/blob/master/docs/api/scheduling.md
  - `work(name, options, handler)`: https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md
- **Why this exact version:** 12.38.2 (10 Nov 2026) fixes "a job waiting for its retry could be deleted before the retry ran" and `publish()` with `{ db }` using pg-boss's own pool. Both touch behaviours the OS relies on (retry, the caller's transaction).

**Why the OS ships it:** the one job queue (design 10 F8). It is installed in its own Postgres
schema, `pgboss`, of the `os_governance` database, by pg-boss's own CLI (`pg-boss migrate`,
https://github.com/timgit/pg-boss/blob/12.38.2/docs/cli.md) run AS THE MIGRATION OWNER in the
migration step only, so the owner owns the schema and every object in it. Every runtime instance
starts with `migrate: false`, `createSchema: false` and `persistQueueStats: false` (no DDL at run
time); the queue login and the OS's runtime login have DML only, never TRIGGER, TRUNCATE or CREATE,
and no write at all to `bam` or to `version.version` (only the run-time claim columns `cron_on`,
`bam_on`, `flow_on`, `reindex_on`, `monitor_backoff_on`, read from 12.38.2 `dist/plans.js`). Own pool `max` 3; workers,
maintenance and cron only in the worker process. The OS does not write to that schema.
The behaviours the design relies on are proven against the real `postgres:17` image in
`os-ui/core/testing/postgres/pgboss.it.ts` and `install.it.ts`.

The glue that uses this pin lives in `os-ui/core/adapters/postgres/`; nothing we wrote belongs here.
