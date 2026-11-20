-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- FEATURE:    Bootstrap step 3 (as the cluster superuser, after `CREATE DATABASE … OWNER <owner>`)
-- USER STORY: As an operator I want only the governance roles able to connect to the database.
-- ARCHITECTURE:
--   - Same parameters as roles.sql, plus os_bootstrap.database.
--   - PUBLIC loses CONNECT and TEMPORARY; os_governance_app may CONNECT.
--   - The runtime login may CREATE schemas in this database because pg-boss installs and
--     migrates its own schema (`pgboss`) at start(), as the role that starts it. The runtime then
--     owns `pgboss` and nothing else; it cannot alter the owner's `os_governance` objects.
DO $grants$
DECLARE
  db           text := current_setting('os_bootstrap.database');
  owner_role   text := current_setting('os_bootstrap.owner_role');
  runtime_role text := current_setting('os_bootstrap.runtime_role');
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO %I', db, owner_role);
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO os_governance_app', db);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', db, runtime_role);
END
$grants$;
