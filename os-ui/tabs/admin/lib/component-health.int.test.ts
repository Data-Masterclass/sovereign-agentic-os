/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The Platform page's rows, end to end, on real components (WP-05).
 * USER STORY: As a platform admin I want the Version column that the Platform routes return to be
 *             what each running component reports through its own API.
 * ARCHITECTURE:
 *   - The exact function both Platform routes call (`componentRows`) with the LIVE health table
 *     and config: the component URLs come from the same env vars the chart sets (TRINO_HOST,
 *     OPENSEARCH_URL, OPA_URL, AGENT_RUNS_DATABASE_URL, VICTORIA_*_URL, OTEL_COLLECTOR_*_URL),
 *     pointed at tests/observability/health-up.sh's containers by the CI step.
 *   - Each row's version must equal the chart's pin for that image (.health-it.json `expected`)
 *     and be labelled `component`.
 *   - Run: PLATFORM_IT=1 + the env above.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { componentRows } from '@tabs/admin/lib/component-health';
import { REGISTRY } from '@tabs/admin/lib/platform';

const FILE = join(process.cwd(), '..', 'tests', 'observability', '.health-it.json');
const on = process.env.PLATFORM_IT === '1';

test('the Platform rows carry the version each running component reports (live health table)', { skip: !on }, async () => {
  assert.ok(existsSync(FILE), 'run tests/observability/health-up.sh first');
  const expected: Record<string, { expected: string }> = JSON.parse(readFileSync(FILE, 'utf8'));
  const ids = Object.keys(expected);
  const views = REGISTRY.filter((c) => ids.includes(c.id)).map((c) => ({ ...c, ns: 'agentic-os', lport: c.port, status: 'running' }));
  assert.equal(views.length, ids.length, 'a tested component is missing from the registry');
  const rows = await componentRows(views);
  for (const r of rows) {
    assert.equal(r.version, expected[r.id].expected, `${r.id}: ${r.versionNote}`);
    assert.equal(r.versionSource, 'component', r.id);
  }
});
