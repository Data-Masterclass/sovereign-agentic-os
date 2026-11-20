-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- FEATURE:    Bootstrap step 1 (as the cluster superuser): the roles of the `os_governance` database
-- USER STORY: As an operator I want the governance schema owned by a role that is NOT a superuser
--             and cannot create roles, and the OS to run as a third, non-owner login, so the
--             audit log's append-only guarantee holds against the OS's own credentials.
-- ARCHITECTURE:
--   - Run by the chart Job `os-governance-bootstrap` (flag `postgres.governance.enabled`) and by
--     `install.it.ts`, from this same file. Idempotent: re-running only resets passwords and
--     attributes. Parameters come from session settings, set by the caller with set_config():
--       os_bootstrap.owner_role, os_bootstrap.owner_password,
--       os_bootstrap.runtime_role, os_bootstrap.runtime_password
--   - owner   : LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB. Owns the database and runs the
--               node-pg-migrate migrations, nothing else.
--   - os_governance_app : NOLOGIN group role; the migrations grant it its table privileges.
--   - runtime : LOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, member of os_governance_app. Never
--               the owner of anything in `os_governance`.
DO $bootstrap$
DECLARE
  owner_role   text := current_setting('os_bootstrap.owner_role');
  owner_pw     text := current_setting('os_bootstrap.owner_password');
  runtime_role text := current_setting('os_bootstrap.runtime_role');
  runtime_pw   text := current_setting('os_bootstrap.runtime_password');
  attrs        text := 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS';
BEGIN
  IF owner_role = runtime_role THEN
    RAISE EXCEPTION 'os-governance bootstrap: the owner and the runtime login must be different roles';
  END IF;
  IF owner_pw = '' OR runtime_pw = '' THEN
    RAISE EXCEPTION 'os-governance bootstrap: empty password';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'os_governance_app') THEN
    BEGIN
      CREATE ROLE os_governance_app NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- created concurrently
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
    EXECUTE format('ALTER ROLE %I WITH %s PASSWORD %L', owner_role, attrs, owner_pw);
  ELSE
    EXECUTE format('CREATE ROLE %I WITH %s PASSWORD %L', owner_role, attrs, owner_pw);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    EXECUTE format('ALTER ROLE %I WITH %s INHERIT PASSWORD %L', runtime_role, attrs, runtime_pw);
  ELSE
    EXECUTE format('CREATE ROLE %I WITH %s INHERIT PASSWORD %L', runtime_role, attrs, runtime_pw);
  END IF;
  EXECUTE format('GRANT os_governance_app TO %I', runtime_role);
END
$bootstrap$;
