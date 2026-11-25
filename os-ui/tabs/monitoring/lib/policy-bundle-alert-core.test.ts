/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring raises a lasting policy-data refusal and clears it when a compile passes
 * USER STORY: As a platform admin I want Monitoring to show that OPA is held on an old policy revision
 *             once it lasts longer than the configured minutes, and stop showing it once it is over.
 * ARCHITECTURE: `policyBundleAlerts` over a status shaped like `osDataBundleStatus()`, plus a source
 *   check that the overview aggregation includes it (aggregate.ts is server-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyBundleAlerts } from '@tabs/monitoring/lib/policy-bundle-alert-core';

const since = '2026-11-25T08:00:00.000Z';
const t0 = Date.parse(since);
const diff = {
  grantPrincipals: { removed: ['user:a'], added: [], removedTotal: 12, addedTotal: 0 },
  governancePrincipals: { removed: [], added: [], removedTotal: 3, addedTotal: 0 },
  tables: { removed: [], added: [], removedTotal: 0, addedTotal: 0 },
};
const refused = { hash: 'abc123', stats: { grants: 8, principals: 5, tables: 4 }, baseStats: { grants: 20, principals: 8, tables: 4 }, reasons: ['grant principals drop 60.0 % (20 → 8), above 10 %'], at: since, since, maxDropPercent: 10, diff };

test('raised after the threshold (admin-only, critical), not before', () => {
  const st = { refused, revision: '41-ffff', refusalAlertMinutes: 15 };
  assert.deepEqual(policyBundleAlerts(st, t0 + 10 * 60_000), []);
  const [a] = policyBundleAlerts(st, t0 + 15 * 60_000);
  assert.equal(a.id, 'al-policy-data-refused');
  assert.equal(a.severity, 'critical');
  assert.equal(a.cluster, true, 'admin scope only');
  assert.match(a.detail, /revision 41-ffff/);
  assert.match(a.detail, /remove 12 grant principal\(s\), 3 governance principal\(s\)/);
});

test('the threshold is configurable', () => {
  assert.equal(policyBundleAlerts({ refused, revision: 'r', refusalAlertMinutes: 60 }, t0 + 30 * 60_000).length, 0);
  assert.equal(policyBundleAlerts({ refused, revision: 'r', refusalAlertMinutes: 0 }, t0).length, 1);
});

test('cleared once a compile passes (no refusal in the status)', () => {
  assert.deepEqual(policyBundleAlerts({ refused: null, revision: '42-aaaa', refusalAlertMinutes: 15 }, t0 + 99 * 60_000), []);
});

test('the Monitoring overview includes it', () => {
  const src = readFileSync(join(process.cwd(), 'tabs/monitoring/lib/aggregate.ts'), 'utf8');
  assert.match(src, /policyBundleAlerts\(osDataBundleStatus\(\), Date\.now\(\)\)/);
});
