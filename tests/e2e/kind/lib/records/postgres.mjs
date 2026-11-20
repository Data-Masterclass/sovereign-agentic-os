/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read OS-layer rows in Postgres (approvals, run grants, audit chain, run jobs)
 * USER STORY: As AT-c/AT-e I want to read the OS's own governance rows — but only ever beside a
 *             component record, never as the proof on their own (09 §5 rule).
 * ARCHITECTURE:
 *   - psql inside the chart's Postgres pod (plain engine: StatefulSet `pg`, pod `pg-0`), as the
 *     database's owner, JSON out (`json_agg`). Database and schema names are 00 §3.2's
 *     (os_governance, os_grants), created by WP-07; until then the hop is red.
 */
import { execIn } from '../kube.mjs';
import { HopError } from '../hop.mjs';

export async function rows(database, sql, { user = process.env.E2E_PG_USER ?? 'postgres' } = {}) {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`;
  let out;
  try {
    out = await execIn(process.env.E2E_PG_POD ?? 'pg-0', ['psql', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', wrapped]);
  } catch (err) {
    throw new HopError({ component: 'postgres', hop: database, reason: err.reason ?? err.message, wp: 'WP-07' });
  }
  return JSON.parse(out.trim() || '[]');
}
