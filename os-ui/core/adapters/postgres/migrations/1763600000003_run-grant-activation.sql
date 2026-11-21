-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
--
-- AREA:       adapters/postgres (migration 4 of the os_governance database)
-- FEATURE:    The activation window of a Dagster run grant (WP-15; 10 F4)
-- USER STORY: As a data owner I want my scheduled sync's standing grant to let Dagster act as me
--             only while one of my runs is in progress, and never for longer than a few hours if
--             the run's end is missed.
-- ARCHITECTURE:
--   - `active_run_id` (WP-07) names the run between /start and /finish. `active_until` is the
--     backstop: /start sets it to at most 6 h ahead, /finish clears both. The os-grants bundle
--     carries it and the Trino OPA rule compares it with `time.now_ns()`, so a missed /finish
--     closes itself in OPA without any OS process running.
--   - Nullable, no default: existing rows and agent run grants (kind = run) never set it. The
--     Trino rule treats a Dagster grant with an active run but no `active_until` as not active.

-- Up Migration

ALTER TABLE os_governance.run_grants ADD COLUMN active_until timestamptz;

-- Down Migration

ALTER TABLE os_governance.run_grants DROP COLUMN active_until;
