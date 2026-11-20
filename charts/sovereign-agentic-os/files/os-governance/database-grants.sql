-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- FEATURE:    Bootstrap step 3 (as a cluster superuser, after `CREATE DATABASE … OWNER <owner>`)
-- USER STORY: As an operator I want only the governance roles able to connect, and no OS login
--             able to create anything in the database.
-- ARCHITECTURE:
--   - Same parameters as roles.sql. Refuses a database that exists but is owned by someone else.
--   - PUBLIC loses CONNECT and TEMPORARY. os_governance_app and the queue role may CONNECT.
--   - Nobody but the owner may CREATE in the database: the runtime login can therefore never plant
--     a schema (and with it a function that shadows a built-in). The `pgboss` schema is created
--     by the owner's migrations, so pg-boss needs no database-level CREATE either.
DO $grants$
DECLARE
  db           text := pg_catalog.current_setting('os_bootstrap.database');
  owner_role   text := pg_catalog.current_setting('os_bootstrap.owner_role');
  runtime_role text := pg_catalog.current_setting('os_bootstrap.runtime_role');
  queue_role   text := pg_catalog.current_setting('os_bootstrap.queue_role');
  current_owner text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(datdba) INTO current_owner FROM pg_catalog.pg_database WHERE datname = db;
  IF current_owner IS DISTINCT FROM owner_role THEN
    RAISE EXCEPTION 'os-governance bootstrap: database % is owned by %, not %; refusing to touch it',
      db, current_owner, owner_role;
  END IF;
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  EXECUTE pg_catalog.format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I, %I', db, runtime_role, queue_role);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO os_governance_app', db);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO %I', db, queue_role);
END
$grants$;
