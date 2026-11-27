/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    i18n wave 4 — Monitoring's coded alerts keep their English title and detail byte-for-byte
 * USER STORY: As a German operator I read platform alerts in German, while every other reader keeps the English.
 * ARCHITECTURE: The derivers set `Alert.i18n` (code + params) beside the English title/detail; the test renders each
 *   through the catalogs with `assertServerEnglish`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertServerEnglish } from '@core/testing/server-message';
import { deriveAlerts } from '@tabs/monitoring/lib/alerts-derive';
import { accessDriftAlerts } from '@tabs/monitoring/lib/access-drift-core';
import { dagsterStateAlerts } from '@tabs/monitoring/lib/dagster-state-core';
import { dbtVerdictAlerts } from '@tabs/monitoring/lib/dbt-verdict-alerts-core';
import type { Alert, Scope } from '@tabs/monitoring/lib/types';

/** An alert's coded title / detail render to exactly its English, in every language. */
function assertAlertEnglish(a: Alert): void {
  for (const f of ['title', 'detail'] as const) {
    const m = a.i18n?.[f];
    assert.ok(m, `${a.id}: ${f} has no code`);
    assertServerEnglish({ error: a[f], code: m.code, params: m.params });
  }
}

test('monitoring alerts carry codes whose English equals their title and detail', () => {
  const admin = { level: 'admin', userId: 'ops', domains: ['sales'], role: 'admin' } as unknown as Scope;
  const derived = deriveAlerts(
    [
      { id: 'r1', principal: 'sales', tool: 'query', decision: 'deny', output: {} },
      { id: 'r2', principal: 'sales', tool: 'query', decision: 'allow', output: { error: 'boom' } },
    ] as never,
    [
      { id: 'c1', scope: 'domain', subject: 'sales', limit: 100, spent: 150, period: 'month', createdBy: 'ops' },
      { id: 'c2', scope: 'domain', subject: 'ops', limit: 100, spent: 95, period: 'day', createdBy: 'ops' },
    ] as never,
    admin,
    { state: 'not-restored', detail: 'OPA lost its grants.', at: '2026-11-27T10:00:00Z', lastRestoredAt: '2026-11-26T10:00:00Z' },
  );
  assert.ok(derived.length >= 3, 'policy + cap alerts were derived');
  derived.forEach(assertAlertEnglish);
  for (const ps of [{ state: 'not-restored' as const, detail: 'x.' }, { state: 'not-restored' as const, detail: 'x.', at: '2026-11-27T10:00:00Z' }]) {
    deriveAlerts([], [], admin, ps).forEach(assertAlertEnglish);
  }
  const now = Date.parse('2026-11-27T12:00:00Z');
  accessDriftAlerts({ at: now - 1000, restored: false, reason: 'write refused' }, now).forEach(assertAlertEnglish);
  accessDriftAlerts({ at: now - 1000, restored: false }, now).forEach(assertAlertEnglish);
  accessDriftAlerts({ at: now - 1000, restored: true }, now).forEach(assertAlertEnglish);
  dagsterStateAlerts(null, 'timeout').forEach(assertAlertEnglish);
  dagsterStateAlerts([{ kind: 'sensor', name: 'os_quarantine', status: 'STOPPED' }] as never).forEach(assertAlertEnglish);
  dbtVerdictAlerts(null, 'index missing').forEach(assertAlertEnglish);
  const row = (details: Record<string, unknown>) => ({ domain: 'sales', sha: 'abcdef123', status: 'failed' as const, checkedAt: '2026-11-27T10:00:00Z', details });
  dbtVerdictAlerts([row({ errorSummary: 'Compilation Error in model x' })]).forEach(assertAlertEnglish);
  dbtVerdictAlerts([row({})]).forEach(assertAlertEnglish);
});

