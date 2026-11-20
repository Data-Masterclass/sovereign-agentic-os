-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- FEATURE:    Bootstrap step 1 (as a cluster superuser): the roles of the `os_governance` database
-- USER STORY: As an operator I want the governance schema owned by a role that is NOT a superuser
--             and cannot create roles, the OS to run as a separate non-owner login, and the job
--             queue owned by a third role, so the audit log's append-only guarantee holds against
--             the OS's own credentials, and so the bootstrap can never touch another service's role.
-- ARCHITECTURE:
--   - Run by the chart Job `os-governance-bootstrap` (flag `postgres.governance.enabled`) and by
--     `install.it.ts`, from this same file. Idempotent. Parameters are session settings, set by the
--     caller with set_config():
--       os_bootstrap.database, os_bootstrap.owner_role, os_bootstrap.owner_password,
--       os_bootstrap.runtime_role, os_bootstrap.runtime_password,
--       os_bootstrap.queue_role, os_bootstrap.queue_password
--   - owner   : LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB. Owns the database and the
--               `os_governance` schema; runs the node-pg-migrate migrations, nothing else.
--   - runtime : the OS's login. Member of os_governance_app. Owns nothing; cannot create anything.
--   - queue   : pg-boss's login. Owns only the `pgboss` schema (pg-boss migrates it at start()).
--   - REFUSES (before changing anything) a reserved or other service's name, two equal names, a
--     role that is a superuser, and a role that owns any database other than the governance one.
DO $bootstrap$
DECLARE
  db           text := pg_catalog.current_setting('os_bootstrap.database');
  owner_role   text := pg_catalog.current_setting('os_bootstrap.owner_role');
  runtime_role text := pg_catalog.current_setting('os_bootstrap.runtime_role');
  queue_role   text := pg_catalog.current_setting('os_bootstrap.queue_role');
  pw           text;
  r            text;
  reserved     text[] := ARRAY['langfuse', 'postgres', 'litellm', 'dagster', 'polaris', 'agent_runs',
                               'os_governance_app', 'public', 'template0', 'template1'];
  attrs        text := 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS INHERIT';
BEGIN
  IF db = ANY (reserved) THEN
    RAISE EXCEPTION 'os-governance bootstrap: database name % is reserved', db;
  END IF;
  IF owner_role = runtime_role OR owner_role = queue_role OR runtime_role = queue_role THEN
    RAISE EXCEPTION 'os-governance bootstrap: owner, runtime and queue must be three different roles';
  END IF;
  FOREACH r IN ARRAY ARRAY[owner_role, runtime_role, queue_role] LOOP
    IF r = ANY (reserved) THEN
      RAISE EXCEPTION 'os-governance bootstrap: role name % is reserved', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r AND rolsuper) THEN
      RAISE EXCEPTION 'os-governance bootstrap: role % is a superuser; refusing to touch it', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_database d
                WHERE pg_catalog.pg_get_userbyid(d.datdba) = r AND d.datname <> db) THEN
      RAISE EXCEPTION 'os-governance bootstrap: role % owns another database; refusing to touch it', r;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'os_governance_app') THEN
    BEGIN
      CREATE ROLE os_governance_app NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- created concurrently
    END;
  END IF;

  FOREACH r IN ARRAY ARRAY['owner', 'runtime', 'queue'] LOOP
    pw := pg_catalog.current_setting('os_bootstrap.' || r || '_password');
    IF pw = '' THEN
      RAISE EXCEPTION 'os-governance bootstrap: empty % password', r;
    END IF;
    r := pg_catalog.current_setting('os_bootstrap.' || r || '_role');
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE pg_catalog.format('ALTER ROLE %I WITH %s PASSWORD %L', r, attrs, pw);
    ELSE
      EXECUTE pg_catalog.format('CREATE ROLE %I WITH %s PASSWORD %L', r, attrs, pw);
    END IF;
  END LOOP;
  EXECUTE pg_catalog.format('GRANT os_governance_app TO %I', runtime_role);
END
$bootstrap$;
