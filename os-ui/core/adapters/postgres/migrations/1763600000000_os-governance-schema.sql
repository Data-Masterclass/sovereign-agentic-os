-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- AREA:       adapters/postgres (migration 1 of the os_governance schema)
-- FEATURE:    The `os_governance` schema: governance tables with row versions, and `grant_rev`
-- USER STORY: As an operator I want governance state (approvals, grants, run grants, settings,
--             status) in ONE transactional home that both os-ui processes share, so an edit can
--             never be lost to a stale copy in another process.
-- ARCHITECTURE:
--   - Design 00 §3.2 / §3.5 and Reconciliation #19 (commit checks); 10 F2, F3, F4, F12 (tier enum = `scope`). Plain SQL in node-pg-migrate's documented
--     single-file format (`-- Up Migration` / `-- Down Migration`); no ORM, no OS runner.
--   - Every table has `version bigint` and `updated_at`. A trigger bumps both on UPDATE, so a
--     writer only has to say `... WHERE version = $n`; 0 rows means conflict (409), never
--     last-writer-wins.
--   - `grant_rev` is the sequence grant revisions are drawn from (10 F3). Every insert or update
--     of a grant, run grant or approved write stamps the row with the next value, and every
--     statement that inserts, updates OR DELETES any of them moves `grant_revision.rev` (one row)
--     to a new value in the same transaction. The `os-grants` bundle reads `grant_revision.rev`
--     with its data in one snapshot, so a hard delete changes the ETag too, and a rolled-back
--     change never does (a bare sequence `last_value` is not transactional).
--   - `os_governance_app` is the NOLOGIN group role the runtime login is a member of. Roles are
--     cluster-wide, so the up step tolerates an existing role and the down step leaves it (a
--     role with no privileges grants nothing).
--   - No users table: users, groups and domain roles go to Keycloak (00 §3.2), not here.
--   - No cost caps table: model budgets and spend stay in LiteLLM (00 §3.2), the OS reads them
--     through LiteLLM's admin API and keeps no second copy.

-- Up Migration

-- An owner without CREATEROLE installs once an admin has created the role (the chart's
-- governance bootstrap Job does). The existence check comes BEFORE CREATE ROLE, because
-- CREATE ROLE without the privilege fails with 42501 before any duplicate check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'os_governance_app') THEN
    BEGIN
      CREATE ROLE os_governance_app NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- another database's migration created it concurrently
    END;
  END IF;
END
$$;

CREATE SCHEMA os_governance;

CREATE SEQUENCE os_governance.grant_rev AS bigint;

-- Bump version and updated_at on every UPDATE (optimistic concurrency, 00 §3.5 condition 2).
CREATE FUNCTION os_governance.bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

-- Take the next grant revision on every grant-bearing write (10 F3: the bundle ETag/revision).
CREATE FUNCTION os_governance.take_grant_rev() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.grant_rev := nextval('os_governance.grant_rev');
  RETURN NEW;
END
$$;

-- The bundle revision: one row, moved by every grant-bearing statement (see the header).
CREATE TABLE os_governance.grant_revision (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rev        bigint NOT NULL DEFAULT 0,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO os_governance.grant_revision (id) VALUES (1);

-- SECURITY DEFINER: the runtime role may not write the revision row itself; only this trigger
-- (running as the schema owner) moves it. search_path is pinned for a definer function.
CREATE FUNCTION os_governance.advance_grant_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE os_governance.grant_revision SET rev = nextval('os_governance.grant_rev') WHERE id = 1;
  RETURN NULL;
END
$$;

-- Scope ladder used by several tables (My → Domain → Company).
CREATE DOMAIN os_governance.scope AS text CHECK (VALUE IN ('my', 'domain', 'company'));

-- 1. Approvals: promotions, deploys, escalated writes. Four eyes: the requester never decides.
CREATE TABLE os_governance.approvals (
  id             text PRIMARY KEY,
  kind           text NOT NULL,
  subject_kind   text NOT NULL,
  subject_id     text NOT NULL,
  domain         text NOT NULL,
  requested_by   text NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  approver_uid   text,
  decided_at     timestamptz,
  decision_reason text,
  decision_id    text,
  policy_rev     text,
  payload        jsonb NOT NULL DEFAULT '{}',
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT approvals_decided CHECK (
    (status IN ('approved', 'rejected')) = (approver_uid IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT approvals_four_eyes CHECK (approver_uid IS DISTINCT FROM requested_by)
);
CREATE INDEX approvals_pending_idx ON os_governance.approvals (domain, status) WHERE status = 'pending';
CREATE INDEX approvals_subject_idx ON os_governance.approvals (subject_kind, subject_id);

-- 2. Confirmations: a user's explicit "yes, do it" for a destructive or costly action.
CREATE TABLE os_governance.confirmations (
  id             text PRIMARY KEY,
  principal_uid  text NOT NULL,
  action         text NOT NULL,
  subject_kind   text NOT NULL,
  subject_id     text NOT NULL,
  token_hash     text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  confirmed_at   timestamptz,
  payload        jsonb NOT NULL DEFAULT '{}',
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT confirmations_expiry CHECK (expires_at > created_at)
);
CREATE INDEX confirmations_principal_idx ON os_governance.confirmations (principal_uid, status);

-- 3. Grants: who may use which capability on which resource (compiled into OPA data, 04).
CREATE TABLE os_governance.grants (
  id             text PRIMARY KEY,
  subject_kind   text NOT NULL CHECK (subject_kind IN ('user', 'group', 'agent_system', 'app')),
  subject_id     text NOT NULL,
  resource_kind  text NOT NULL,
  resource_id    text NOT NULL,
  domain         text NOT NULL,
  capability     text NOT NULL,
  scope          os_governance.scope NOT NULL,
  granted_by     text NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  grant_rev      bigint NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT grants_unique UNIQUE (subject_kind, subject_id, resource_kind, resource_id, capability)
);
CREATE INDEX grants_resource_idx ON os_governance.grants (resource_kind, resource_id);

-- 4. Run grants: the bound on all headless work (00 Reconciliation #7; 10 F3, F4).
--    kind run → an agent run (svc-os-worker); standing / dataset → Dagster (svc-dagster-runner).
CREATE TABLE os_governance.run_grants (
  id             text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('run', 'standing', 'dataset')),
  principal_uid  text NOT NULL,
  domain         text NOT NULL,
  system_id      text,
  dataset        text,
  scopes         text[] NOT NULL DEFAULT '{}',
  selection_hash text,
  commit         text,
  issued_by      text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  active_run_id  text,
  grant_rev      bigint NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_grants_target CHECK ((system_id IS NULL) <> (dataset IS NULL)),
  CONSTRAINT run_grants_expiry CHECK (expires_at > issued_at)
);
CREATE INDEX run_grants_principal_idx ON os_governance.run_grants (principal_uid) WHERE revoked_at IS NULL;
CREATE INDEX run_grants_rev_idx ON os_governance.run_grants (grant_rev);

-- 5. Approved writes on a run grant (10 F2): the only way a held write reaches Trino.
CREATE TABLE os_governance.run_grant_approved_writes (
  grant_id       text NOT NULL REFERENCES os_governance.run_grants (id) ON DELETE CASCADE,
  table_fqn      text NOT NULL,
  op             text NOT NULL CHECK (op IN ('create', 'insert', 'merge', 'delete', 'drop')),
  approval_id    text NOT NULL REFERENCES os_governance.approvals (id),
  expires_at     timestamptz NOT NULL,
  grant_rev      bigint NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (grant_id, table_fqn, op)
);

-- 6. Notifications to a person.
CREATE TABLE os_governance.notifications (
  id             text PRIMARY KEY,
  recipient_uid  text NOT NULL,
  kind           text NOT NULL,
  title          text NOT NULL,
  body           text,
  link           text,
  payload        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at        timestamptz,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notifications_unread_idx ON os_governance.notifications (recipient_uid, created_at DESC) WHERE read_at IS NULL;

-- 7. Per-person preferences.
CREATE TABLE os_governance.prefs (
  principal_uid  text NOT NULL,
  key            text NOT NULL,
  value          jsonb NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_uid, key)
);

-- 8. Per-domain settings.
CREATE TABLE os_governance.domain_settings (
  domain         text NOT NULL,
  key            text NOT NULL,
  value          jsonb NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (domain, key)
);

-- 9. Commit checks: one verdict per (domain, sha, check): dbt parse, opa test, Trivy scans
--    (00 Reconciliation #19; 10 F10 for the dbt-parse verdict).
CREATE TABLE os_governance.commit_checks (
  domain         text NOT NULL,
  sha            text NOT NULL,
  check_name     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'passed', 'failed', 'error')),
  artifact_digest text,
  details        jsonb NOT NULL DEFAULT '{}',
  checked_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (domain, sha, check_name)
);

-- 10. Reconciler status, Kubernetes-style conditions (00 §3.4).
CREATE TABLE os_governance.object_status (
  kind                text NOT NULL,
  id                  text NOT NULL,
  generation          bigint NOT NULL DEFAULT 1,
  observed_generation bigint,
  conditions          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
  version             bigint NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, id)
);

-- 11. Catalog index of authored artifacts in git (00 §3.2: the file wins, the row is re-derived).
CREATE TABLE os_governance.catalog_entities (
  kind           text NOT NULL,
  id             text NOT NULL,
  domain         text NOT NULL,
  owner_uid      text NOT NULL,
  scope          os_governance.scope NOT NULL,
  sha            text NOT NULL,
  path           text NOT NULL,
  title          text,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX catalog_entities_domain_idx ON os_governance.catalog_entities (domain, kind);

-- 12. Lifecycle pins: which git ref is draft / testing / live for an artifact (00 §3.2).
CREATE TABLE os_governance.lifecycle_pins (
  kind           text NOT NULL,
  id             text NOT NULL,
  stage          text NOT NULL CHECK (stage IN ('draft', 'testing', 'live')),
  ref            text NOT NULL,
  sha            text NOT NULL,
  pinned_by      text NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, id, stage)
);

-- 13. Exposure sets: cross-domain table sharing (11 A11; compiled into OPA data).
CREATE TABLE os_governance.exposure_sets (
  id               text PRIMARY KEY,
  domain           text NOT NULL,
  owner_uid        text NOT NULL,
  tables           text[] NOT NULL DEFAULT '{}',
  consumer_domains text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'active', 'revoked')),
  approval_id      text REFERENCES os_governance.approvals (id),
  version          bigint NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Row-version triggers on every table above.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approvals', 'confirmations', 'grants', 'run_grants', 'run_grant_approved_writes',
    'notifications', 'prefs', 'domain_settings', 'commit_checks',
    'object_status', 'catalog_entities', 'lifecycle_pins', 'exposure_sets', 'grant_revision'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON os_governance.%I FOR EACH ROW EXECUTE FUNCTION os_governance.bump_row_version()',
      t || '_bump_version', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['grants', 'run_grants', 'run_grant_approved_writes'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON os_governance.%I FOR EACH ROW EXECUTE FUNCTION os_governance.take_grant_rev()',
      t || '_grant_rev', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON os_governance.%I FOR EACH STATEMENT EXECUTE FUNCTION os_governance.advance_grant_revision()',
      t || '_grant_revision', t);
  END LOOP;
END
$$;

-- The runtime role: read and write governance rows; nothing else.
GRANT USAGE ON SCHEMA os_governance TO os_governance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA os_governance TO os_governance_app;
GRANT USAGE ON SEQUENCE os_governance.grant_rev TO os_governance_app;
-- The revision row moves only through the triggers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON os_governance.grant_revision FROM os_governance_app;

-- Down Migration

DROP SCHEMA os_governance CASCADE;
