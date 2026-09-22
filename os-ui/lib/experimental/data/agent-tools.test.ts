/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTool, type Executors } from './agent-tools.ts';
import { claimsFromUser } from './identity.ts';

const amir = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'builder', attributes: { region: 'DE' } });

function spyExecutors(over: Partial<Executors> = {}): { ex: Executors; calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {};
  const ex: Executors = {
    async authorize() { return { allowed: true, policy: 'opa-allow' }; },
    async trinoQuery(_sql, principal) { calls.trinoPrincipal = principal; return { columns: ['x'], rows: [['1']] }; },
    async cubeQuery(_q, sc) { calls.cubeSecurityContext = sc; return { rows: [{ revenue: 100 }] }; },
    async trace(e) { calls.traced = e; return true; },
    ...over,
  };
  return { ex, calls };
}

test('personal scope runs through governed Trino AS the owner, never a governed mart', async () => {
  const { ex, calls } = spyExecutors();
  const r = await runAgentTool(amir, { scope: 'personal', kind: 'query', sql: 'select * from my_upload' }, ex);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'trino'); // single engine — no separate DuckDB source
  assert.equal(calls.trinoPrincipal, 'amir'); // run AS the owner so OPA governs personal_<uid>
});

test('personal scope REFUSES a query that reaches into a governed catalog', async () => {
  const { ex } = spyExecutors();
  await assert.rejects(
    runAgentTool(amir, { scope: 'personal', kind: 'query', sql: 'select * from iceberg.sales.orders' }, ex),
    /governed/i,
  );
});

test('domain query forwards the user as the Trino principal (OPA RLS, R3)', async () => {
  const { ex, calls } = spyExecutors();
  const r = await runAgentTool(amir, { scope: 'domain', kind: 'query', sql: 'select 1' }, ex);
  assert.equal(r.source, 'trino');
  assert.equal(calls.trinoPrincipal, 'amir'); // the user, not a service account
});

test('metrics resolve under the per-user Cube securityContext (R3)', async () => {
  const { ex, calls } = spyExecutors();
  await runAgentTool(amir, { scope: 'domain', kind: 'metrics', query: { measures: ['Orders.revenue'] } }, ex);
  const sc = calls.cubeSecurityContext as Record<string, unknown>;
  assert.equal(sc.sub, 'amir');
  assert.equal(sc.region, 'DE'); // full claims propagate to Cube
});

test('R2: a service-account identity cannot run the tool (delegation refuses it)', async () => {
  const { ex } = spyExecutors();
  const svc = claimsFromUser({ id: 'svc-reader', domains: ['sales'], role: 'admin' });
  await assert.rejects(runAgentTool(svc, { scope: 'domain', kind: 'query', sql: 'select 1' }, ex), /service account/i);
});

test('a tool denied by OPA returns a denial, not data', async () => {
  const { ex } = spyExecutors({ async authorize() { return { allowed: false, policy: 'opa-deny' }; } });
  const r = await runAgentTool(amir, { scope: 'domain', kind: 'query', sql: 'select 1' }, ex);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /denied/);
});

test('marketplace scope uses the governed Trino path (imports enforced by OPA grants)', async () => {
  const { ex, calls } = spyExecutors();
  const r = await runAgentTool(amir, { scope: 'marketplace', kind: 'query', sql: 'select 1' }, ex);
  assert.equal(r.source, 'trino');
  assert.equal(calls.trinoPrincipal, 'amir');
});
