/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    One fresh Postgres database per agent-engine test file, so the files run in parallel
 * USER STORY: As an engineer I want the real-Postgres agent tests (`*.pg.test.ts`) to run side by
 *             side without racing each other's DDL (`PostgresSaver.setup()`, migrations, fixture
 *             tables) or reading each other's rows.
 * ARCHITECTURE:
 *   - `AGENT_RUNS_TEST_DATABASE_URL` names a server and a login that may CREATE DATABASE (CI: the
 *     postgres:17 service's superuser). `isolateAgentRunsDatabase(prefix)` creates
 *     `<prefix>_<pid>_<rand>` there and REWRITES the variable for this process and its children
 *     (the per-step fixture processes inherit it), before the test file reads it. `dropIsolated()`
 *     drops it at the end. The same pattern as WP-07's `core/testing/postgres/it-support.ts`.
 *   - Unset variable → nothing happens and the file skips (or fails under REQUIRE_PG_TESTS=1), as
 *     before.
 */
import pg from 'pg';

let created: { admin: string; name: string } | null = null;

export async function isolateAgentRunsDatabase(prefix: string): Promise<void> {
  const url = (process.env.AGENT_RUNS_TEST_DATABASE_URL ?? '').trim();
  if (!url || created) return;
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }
  const u = new URL(url);
  u.pathname = `/${name}`;
  created = { admin: url, name };
  process.env.AGENT_RUNS_TEST_DATABASE_URL = u.toString();
}

export async function dropIsolated(): Promise<void> {
  if (!created) return;
  const c = new pg.Client({ connectionString: created.admin });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${created.name} WITH (FORCE)`);
  } finally {
    await c.end();
    created = null;
  }
}
