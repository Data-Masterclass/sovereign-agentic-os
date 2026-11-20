-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- AREA:       adapters/postgres (agent_runs database, migration 1)
-- FEATURE:    The OS's own tables for runs of native LangGraph agent modules (WP-53)
-- USER STORY: As an operator I want these tables created ONCE, by the migration step, under
--             node-pg-migrate's advisory lock — never by a run racing another process.
-- ARCHITECTURE:
--   - node-pg-migrate's documented single-file SQL format, applied to the `agent_runs` database
--     (the checkpointer's) by `migrateAgentRuns` (core/adapters/postgres/migrate.ts).
--   - `agent_module_runs`: one row per module run (owner, module digest, commit), written once at
--     start; a resume reads it. `agent_hold_decisions`: the once-per-call hold decision keyed
--     `<thread>:<toolCallId>`, first write wins. Both are deleted with the run's checkpoint thread
--     by the retention sweep (`thread_id`).
--   - IF NOT EXISTS: a database where the run path of WP-53 already created them migrates cleanly.

-- Up Migration

CREATE TABLE IF NOT EXISTS agent_module_runs (
  thread_id  TEXT PRIMARY KEY,
  system_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  domain     TEXT NOT NULL,
  digest     TEXT NOT NULL,
  commit_sha TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_hold_decisions (
  call_key      TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  held          BOOLEAN NOT NULL,
  approver_role TEXT,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_hold_decisions_thread ON agent_hold_decisions (thread_id);

-- Down Migration

DROP TABLE IF EXISTS agent_hold_decisions;
DROP TABLE IF EXISTS agent_module_runs;
