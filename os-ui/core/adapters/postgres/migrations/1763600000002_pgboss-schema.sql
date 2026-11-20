-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- AREA:       adapters/postgres (migration 3 of the os_governance database)
-- FEATURE:    The `pgboss` schema, owned by the migration owner, with DML-only access for the OS
-- USER STORY: As an auditor I want no OS login able to attach code (a trigger, a function, a
--             column default) to the job queue's tables, because such code would run inside the
--             OS's governance transactions with the OS's privileges.
-- ARCHITECTURE:
--   - The migration owner owns `pgboss` and, because pg-boss's own install/migrate runs as the
--     owner right after these migrations (`installQueueSchema` in migrate.ts, the migration Job
--     only), every object pg-boss creates in it.
--   - Every RUNTIME pg-boss instance starts with `migrate: false` and `createSchema: false`
--     (docs/api/constructor.md) and `persistQueueStats: false` (the default; when on, maintenance
--     would create daily partitions, which is DDL). So pg-boss needs only DML at run time.
--   - Default privileges: whatever the owner (i.e. pg-boss's migration) creates in `pgboss` grants
--     SELECT / INSERT / UPDATE / DELETE on tables and USAGE / SELECT on sequences to
--     `os_governance_app` (the runtime, which sends inside its own transaction) and
--     `os_governance_jobs` (the queue login's group). Never TRIGGER, TRUNCATE, REFERENCES or
--     CREATE, and neither role owns anything, so neither can plant a trigger.
--   - `os_governance_jobs` is created by the chart bootstrap (roles.sql); like `os_governance_app`
--     in migration 1, the existence check comes first so an owner without CREATEROLE installs.

-- Up Migration

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'os_governance_jobs') THEN
    BEGIN
      CREATE ROLE os_governance_jobs NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- another database's migration created it concurrently
    END;
  END IF;
END
$$;

CREATE SCHEMA pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO os_governance_app, os_governance_jobs;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO os_governance_app, os_governance_jobs;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO os_governance_app, os_governance_jobs;

-- Down Migration

ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  REVOKE ALL ON TABLES FROM os_governance_app, os_governance_jobs;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
  REVOKE ALL ON SEQUENCES FROM os_governance_app, os_governance_jobs;
DROP SCHEMA pgboss CASCADE;
