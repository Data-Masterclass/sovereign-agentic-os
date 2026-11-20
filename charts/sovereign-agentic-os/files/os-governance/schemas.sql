-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- FEATURE:    Bootstrap step 4 (as a cluster superuser, CONNECTED TO the governance database)
-- USER STORY: As an operator I want the job queue's schema owned by its own role, with the OS
--             login able to use the queue (send inside its own transaction) but not change it.
-- ARCHITECTURE:
--   - `pgboss` is created here, owned by the queue role; pg-boss then installs and migrates its own
--     objects in it at start() with `createSchema: false` (docs/api/constructor.md `createSchema`).
--   - The runtime (os_governance_app) gets USAGE on the schema and, through default privileges for
--     everything the queue role creates there, DML on pg-boss's tables and USAGE on its sequences:
--     what `send(…, { db })` from the caller's transaction needs. It never gets CREATE there.
--   - PUBLIC loses CREATE on `public` (already the PostgreSQL ≥ 15 default; explicit here).
DO $schemas$
DECLARE
  queue_role text := pg_catalog.current_setting('os_bootstrap.queue_role');
BEGIN
  IF pg_catalog.current_database() <> pg_catalog.current_setting('os_bootstrap.database') THEN
    RAISE EXCEPTION 'os-governance bootstrap: schemas.sql must run connected to %',
      pg_catalog.current_setting('os_bootstrap.database');
  END IF;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgboss') THEN
    EXECUTE pg_catalog.format('CREATE SCHEMA pgboss AUTHORIZATION %I', queue_role);
  ELSIF (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = 'pgboss') <> queue_role THEN
    RAISE EXCEPTION 'os-governance bootstrap: schema pgboss is not owned by %', queue_role;
  END IF;
  GRANT USAGE ON SCHEMA pgboss TO os_governance_app;
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO os_governance_app', queue_role);
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO os_governance_app', queue_role);
  -- Objects pg-boss already created (a re-run after it started).
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO os_governance_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO os_governance_app;
END
$schemas$;
