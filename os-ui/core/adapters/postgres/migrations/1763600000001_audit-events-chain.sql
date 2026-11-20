-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- AREA:       adapters/postgres (migration 2 of the os_governance schema)
-- FEATURE:    `audit_events`: append-only, hash-chained, with `decision_id` and `policy_rev`
-- USER STORY: As an auditor I want every governance event kept in order and tamper-evident, and
--             the OS's own database role able to append but never rewrite history.
-- ARCHITECTURE:
--   - Design 00 §3.2 (Audit row): Postgres, append-only (INSERT-only role), hash-chained
--     (`prev_hash`). The governance subset of OPA decisions carries `decision_id` + `policy_rev`
--     (00 Reconciliation #5).
--   - The chain is computed IN the database by a BEFORE INSERT trigger, so no client can choose
--     its hash, its predecessor or its timestamp. The trigger serialises appends with a
--     transaction-scoped advisory lock and assigns the id AFTER taking the lock, so id order is
--     chain order even under concurrent writers (ids may have gaps from rolled-back appends; the
--     chain links by hash, not by id contiguity).
--   - hash = sha256(prev_hash || '|' || canonical row JSON), hex. The canonical JSON is a
--     `jsonb_build_object(...)::text` (Postgres's deterministic jsonb text form) with the
--     timestamp rendered in UTC, so the hash does not depend on the session TimeZone.
--   - `audit_verify()` walks the chain in id order and returns the first broken row: "content"
--     when a row's own hash no longer matches its content, "link" when a row's prev_hash is not
--     its predecessor's hash (a row removed, inserted or reordered).
--   - Append-only twice over: `os_governance_app` has INSERT + SELECT only (no UPDATE, DELETE,
--     TRUNCATE), and triggers reject UPDATE / DELETE / TRUNCATE for every role, the owner included.
--   - Appends are refused outside READ COMMITTED (SQLSTATE 0A000): a higher isolation level
--     would read a stale head and fork the chain.
--   - Any login can hold the same advisory lock at session level and so stall appends; the
--     separate `os_governance` database keeps the key space to this schema alone.
--   - Limit (documented, not hidden): removing the newest rows leaves a shorter valid chain.
--     `audit_verify()` returns the head hash and the count so an external anchor (the nightly
--     export of 00 §3.2) can detect that. The same anchor is needed against the schema owner or a
--     superuser, who can disable the triggers and re-hash every row from a tampered one onward.

-- Up Migration

CREATE SEQUENCE os_governance.audit_events_id_seq AS bigint;

CREATE TABLE os_governance.audit_events (
  id           bigint PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  actor_uid    text NOT NULL,
  actor_kind   text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'service', 'system')),
  action       text NOT NULL,
  object_kind  text,
  object_id    text,
  domain       text,
  outcome      text NOT NULL DEFAULT 'info' CHECK (outcome IN ('allow', 'deny', 'error', 'info')),
  decision_id  text,
  policy_rev   text,
  run_id       text,
  payload      jsonb NOT NULL DEFAULT '{}',
  prev_hash    text NOT NULL,
  hash         text NOT NULL UNIQUE
);
CREATE INDEX audit_events_object_idx ON os_governance.audit_events (object_kind, object_id);
CREATE INDEX audit_events_actor_idx ON os_governance.audit_events (actor_uid, occurred_at);
CREATE INDEX audit_events_decision_idx ON os_governance.audit_events (decision_id) WHERE decision_id IS NOT NULL;

-- The one definition of an event's hash, used by the append trigger AND by the verifier.
-- Every function below pins `search_path` and schema-qualifies its calls (PostgreSQL docs,
-- "Writing SECURITY DEFINER Functions Safely" applies equally to a trigger any login can fire):
-- a caller's own schema can then never shadow clock_timestamp, the lock or sha256.
CREATE FUNCTION os_governance.audit_event_hash(prev text, e os_governance.audit_events) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prev || '|' || pg_catalog.jsonb_build_object(
    'id',          e.id,
    'occurred_at', pg_catalog.to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_uid',   e.actor_uid,
    'actor_kind',  e.actor_kind,
    'action',      e.action,
    'object_kind', e.object_kind,
    'object_id',   e.object_id,
    'domain',      e.domain,
    'outcome',     e.outcome,
    'decision_id', e.decision_id,
    'policy_rev',  e.policy_rev,
    'run_id',      e.run_id,
    'payload',     e.payload
  )::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION os_governance.audit_genesis_hash() RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$ SELECT pg_catalog.repeat('0', 64) $$;

CREATE FUNCTION os_governance.audit_events_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head text;
BEGIN
  -- READ COMMITTED only. Under REPEATABLE READ or SERIALIZABLE the head below would be read from
  -- the transaction's snapshot, taken BEFORE the lock, so a concurrent append committed in
  -- between would be invisible and the chain would fork for good (the table is append-only).
  -- Refuse instead of forking.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'os_governance.audit_events: append only under READ COMMITTED (this transaction is %)',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = 'feature_not_supported',
            HINT = 'Record the audit event in a READ COMMITTED transaction.';
  END IF;
  -- One appender at a time, until this transaction ends. In READ COMMITTED the SELECT below
  -- takes a fresh snapshot after the lock, so it sees the last committed head.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('os_governance.audit_events'));
  SELECT a.hash INTO head FROM os_governance.audit_events a ORDER BY a.id DESC LIMIT 1;
  NEW.id := pg_catalog.nextval('os_governance.audit_events_id_seq');
  NEW.occurred_at := pg_catalog.clock_timestamp();
  NEW.prev_hash := coalesce(head, os_governance.audit_genesis_hash());
  NEW.hash := os_governance.audit_event_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END
$$;

CREATE FUNCTION os_governance.audit_events_reject() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'os_governance.audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON os_governance.audit_events
  FOR EACH ROW EXECUTE FUNCTION os_governance.audit_events_chain();
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON os_governance.audit_events
  FOR EACH ROW EXECUTE FUNCTION os_governance.audit_events_reject();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON os_governance.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION os_governance.audit_events_reject();

-- Walk the chain; the first broken row and why, or ok with the head hash and the count.
CREATE FUNCTION os_governance.audit_verify()
RETURNS TABLE (ok boolean, checked bigint, first_bad_id bigint, reason text, head_hash text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e os_governance.audit_events;
  expected text := os_governance.audit_genesis_hash();
  n bigint := 0;
BEGIN
  FOR e IN SELECT * FROM os_governance.audit_events ORDER BY id LOOP
    n := n + 1;
    IF e.prev_hash IS DISTINCT FROM expected THEN
      RETURN QUERY SELECT false, n, e.id, 'link: prev_hash is not the previous row''s hash (row removed, inserted or reordered)'::text, expected;
      RETURN;
    END IF;
    IF e.hash IS DISTINCT FROM os_governance.audit_event_hash(e.prev_hash, e) THEN
      RETURN QUERY SELECT false, n, e.id, 'content: the row no longer matches its hash'::text, expected;
      RETURN;
    END IF;
    expected := e.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint, NULL::text, CASE WHEN n = 0 THEN NULL ELSE expected END;
END
$$;

-- INSERT-only for the runtime: append and read, never rewrite.
GRANT SELECT, INSERT ON os_governance.audit_events TO os_governance_app;
GRANT USAGE ON SEQUENCE os_governance.audit_events_id_seq TO os_governance_app;
REVOKE UPDATE, DELETE, TRUNCATE ON os_governance.audit_events FROM os_governance_app;

-- Down Migration

DROP FUNCTION os_governance.audit_verify();
DROP FUNCTION os_governance.audit_event_hash(text, os_governance.audit_events);
DROP TABLE os_governance.audit_events;
DROP FUNCTION os_governance.audit_events_reject();
DROP FUNCTION os_governance.audit_events_chain();
DROP FUNCTION os_governance.audit_genesis_hash();
DROP SEQUENCE os_governance.audit_events_id_seq;
