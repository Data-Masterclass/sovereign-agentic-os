/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the store so getCache() initialises offline and the
// Airflow health probe fails fast (a genuine "unreachable" — not a stub ok).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, testConnection, callConnectionTool, getConnectionForUser, __resetConnections } =
  await import('./store.ts');

const builder = { id: 'ub', name: 'UB', domains: ['ops'], role: 'builder' as const };

async function makeAirflow(extra?: Record<string, unknown>) {
  return createConnection(builder, {
    name: 'Ops Airflow',
    template: 'airflow',
    endpoint: 'https://airflow.example.com',
    credential: 'the-token',
    airflow: { authType: 'basic', username: 'svc', dagAllowlist: ['etl'] },
    ...extra,
  });
}

test('create stamps the non-secret airflow config; the secret is only a ref', async () => {
  __resetConnections();
  const c = await makeAirflow();
  assert.equal(c.template, 'airflow');
  assert.deepEqual(c.airflow, { authType: 'basic', username: 'svc', dagAllowlist: ['etl'] });
  assert.equal(c.secretSet, true);
  // THE ONE RULE: the raw credential never lands on the record.
  assert.ok(!JSON.stringify(c).includes('the-token'), 'the credential must not appear on the record');
});

test('testConnection reflects REAL health (offline → honest unreachable, not a fake ok)', async () => {
  __resetConnections();
  const c = await makeAirflow();
  const r = await testConnection(c.id, builder);
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'offline');
  assert.match(r.detail, /unreachable/i);
});

test('trigger_dag is HELD for approval by default (never fires without the gate)', async () => {
  __resetConnections();
  const c = await makeAirflow();
  const out = await callConnectionTool(c.id, builder, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.equal(out.decision, 'requires_approval', 'the Write-approval mode holds the trigger');
  assert.ok(out.approvalId, 'a Governance approval was enqueued');
  assert.equal(out.result, undefined, 'nothing ran — no run was triggered');
});

test('list_dags is a Read — auto-allowed (it reaches execution, honest reason offline)', async () => {
  __resetConnections();
  const c = await makeAirflow();
  const out = await callConnectionTool(c.id, builder, { tool: 'list_dags', args: {} });
  assert.equal(out.decision, 'allow', 'reads auto-allow');
  // Offline fetch rejects → the real client degrades to an honest reason (no crash).
  const res = out.result as { ok?: boolean; reason?: string };
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unreachable');
});

// restore
test('cleanup', () => {
  globalThis.fetch = _realFetch;
});
