/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { __resetForTests as resetPillars } from '@/lib/strategy/pillars';
import { STUB_BET_CATALOGUE } from '@/lib/strategy/bets-bridge';

/**
 * STRATEGY SURFACE (mcp-v2 P2) — six THIN wrappers over lib/strategy/*, driven
 * over handleRpc exactly as an AI client would. Asserts identity is the CALLER,
 * the value roll-up is read back, and the builder floors + canView/canEdit lib
 * gates cannot be bypassed. Runs fully offline (in-process pillar store).
 */

const salesBuilder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const salesCreator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const financeBuilder: CurrentUser = { id: 'fin', name: 'Fin', domains: ['finance'], role: 'builder' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

// create_pillar floors at CREATOR: a personal (My) pillar is open to any member,
// and canCreatePillar re-gates per scope in-lib (My→any member, Domain→Builder+,
// Company→Admin). Every OTHER strategy write — including the lifecycle tools
// (archive/unarchive/delete/promote/restore) — floors at BUILDER.
const CREATOR_WRITE = ['create_pillar'];
const BUILDER_WRITE = [
  'update_pillar',
  'link_bet_to_pillar',
  'record_value_entry',
  'set_pillar_target',
  'archive_pillar',
  'unarchive_pillar',
  'delete_pillar',
  'promote_pillar',
  'demote_pillar',
  'restore_pillar_version',
];
const READ = ['list_pillars', 'get_pillar'];

test('STRATEGY registry: tools present, exampled, floored, and W-classified under the strategy tab', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  const tabNames = new Set(toolsForTab('strategy').map((t) => t.name));
  for (const n of READ) {
    const t = byName.get(n)!;
    assert.ok(t, `${n} registered`);
    assert.equal(t.minRole, 'creator', `${n} floors at creator`);
    assert.equal(t.tab, 'strategy');
    assert.ok(tabNames.has(n), `${n} surfaces on the strategy tab`);
    assert.ok(!writeNames.has(n), `${n} is read-only`);
    assert.ok((t.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
  }
  const assertWrite = (n: string, floor: 'creator' | 'builder') => {
    const t = byName.get(n)!;
    assert.ok(t, `${n} registered`);
    assert.equal(t.minRole, floor, `${n} floors at ${floor}`);
    assert.equal(t.tab, 'strategy', `${n} is on the strategy tab`);
    assert.ok(tabNames.has(n), `${n} surfaces on the strategy tab`);
    assert.ok(writeNames.has(n), `${n} in ALL_WRITE_TOOLS (W-classified)`);
    assert.ok((t.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
    assert.ok(t.description.length > 200, `${n} carries a rich description`);
  };
  for (const n of CREATOR_WRITE) assertWrite(n, 'creator');
  for (const n of BUILDER_WRITE) assertWrite(n, 'builder');
});

test('STRATEGY happy path: builder creates → creator reads the roll-up → value + bet recorded', async () => {
  resetPillars();
  // Owner is the CALLER (ben), never an arg value.
  const created = payload<{ id: string; owner: string; domain: string }>(
    await call(salesBuilder, 'create_pillar', { name: 'Grow NRR', scope: 'domain', domain: 'sales', owner: 'someone_else' }),
  );
  assert.equal(created.owner, 'ben', 'identity threaded = the caller, not the arg');
  assert.equal(created.domain, 'sales');

  // A creator in the same domain can SEE + READ it (creator-visible reads).
  const list = payload<{ id: string }[]>(await call(salesCreator, 'list_pillars'));
  assert.ok(list.some((p) => p.id === created.id), 'creator sees the domain pillar');

  const view = payload<{ pillar: { id: string }; rollup: unknown; history: unknown[]; canEdit: boolean }>(
    await call(salesCreator, 'get_pillar', { pillarId: created.id }),
  );
  assert.equal(view.pillar.id, created.id);
  assert.ok(view.rollup, 'the RLS-scoped roll-up is returned');
  assert.equal(view.canEdit, false, 'a creator cannot edit');

  // Record a manual value → it shows in the history.
  await call(salesBuilder, 'record_value_entry', { pillarId: created.id, value: 2_400_000, month: '2026-06' });
  const after = payload<{ history: { month: string; value: number }[] }>(await call(salesCreator, 'get_pillar', { pillarId: created.id }));
  assert.ok(after.history.some((h) => h.month === '2026-06' && h.value === 2_400_000), 'value entry recorded');

  // Link a real (stub-catalogue) bet.
  const betId = STUB_BET_CATALOGUE[0].id;
  const linked = payload<{ betIds: string[] }>(await call(salesBuilder, 'link_bet_to_pillar', { pillarId: created.id, betId }));
  assert.ok(linked.betIds.includes(betId), 'bet linked');
});

test('STRATEGY negative — creator write is forbidden at the floor', async () => {
  resetPillars();
  const err = errorOf(await call(salesCreator, 'create_pillar', { name: 'X', scope: 'domain', domain: 'sales' }));
  assert.equal(err.code, 'forbidden');
});

test('STRATEGY negative — an out-of-domain builder cannot create in another domain (lib gate)', async () => {
  resetPillars();
  // financeBuilder passes the builder FLOOR, but canCreatePillar re-gates on domain.
  const err = errorOf(await call(financeBuilder, 'create_pillar', { name: 'Intruder', scope: 'domain', domain: 'sales' }));
  assert.equal(err.code, 'forbidden');
});

test('STRATEGY negative — a creator cannot view another domain’s pillar (not_found/forbidden)', async () => {
  resetPillars();
  const finPillar = payload<{ id: string }>(await call(financeBuilder, 'create_pillar', { name: 'Finance value', scope: 'domain', domain: 'finance' }));
  const err = errorOf(await call(salesCreator, 'get_pillar', { pillarId: finPillar.id }));
  assert.ok(err.code === 'forbidden' || err.code === 'not_found', `no cross-domain leak (got ${err.code})`);
});

test('STRATEGY negative — linking an unknown bet is not_found', async () => {
  resetPillars();
  const p = payload<{ id: string }>(await call(salesBuilder, 'create_pillar', { name: 'P', scope: 'domain', domain: 'sales' }));
  const err = errorOf(await call(salesBuilder, 'link_bet_to_pillar', { pillarId: p.id, betId: 'bet_does_not_exist' }));
  assert.equal(err.code, 'not_found');
});

test('STRATEGY set_pillar_target: builder sets a year-end EBIT target → endDate = Dec 31 this year', async () => {
  resetPillars();
  const p = payload<{ id: string }>(await call(salesBuilder, 'create_pillar', { name: 'Grow EBIT', scope: 'domain', domain: 'sales' }));
  const updated = payload<{ headlineTarget: { value: number; metricType: string; horizon: string; endDate: string }; valueMetric: { metricType: string } }>(
    await call(salesBuilder, 'set_pillar_target', { pillarId: p.id, value: 2_500_000, metricType: 'ebit', horizon: 'year-end' }),
  );
  assert.equal(updated.headlineTarget.value, 2_500_000);
  assert.equal(updated.headlineTarget.metricType, 'ebit');
  assert.equal(updated.headlineTarget.horizon, 'year-end');
  assert.equal(updated.headlineTarget.endDate, `${new Date().getUTCFullYear()}-12-31`);
  // The metric type is stamped onto the value metric so the total formats to match.
  assert.equal(updated.valueMetric.metricType, 'ebit');
});

test('STRATEGY set_pillar_target: a 12-month hours target derives its own end date', async () => {
  resetPillars();
  const p = payload<{ id: string }>(await call(salesBuilder, 'create_pillar', { name: 'Time back', scope: 'domain', domain: 'sales' }));
  const updated = payload<{ headlineTarget: { metricType: string; horizon: string; endDate: string } }>(
    await call(salesBuilder, 'set_pillar_target', { pillarId: p.id, value: 1200, metricType: 'time-back-hours', horizon: '12-month' }),
  );
  assert.equal(updated.headlineTarget.metricType, 'time-back-hours');
  assert.equal(updated.headlineTarget.horizon, '12-month');
  // ~12 months out from today (not Dec 31): a real derived date, year advanced.
  assert.ok(updated.headlineTarget.endDate > new Date().toISOString().slice(0, 10), 'end date is in the future');
});

test('STRATEGY set_pillar_target: creator is forbidden at the builder floor', async () => {
  resetPillars();
  const p = payload<{ id: string }>(await call(salesBuilder, 'create_pillar', { name: 'P', scope: 'domain', domain: 'sales' }));
  const err = errorOf(await call(salesCreator, 'set_pillar_target', { pillarId: p.id, value: 100, metricType: 'ebit', horizon: 'year-end' }));
  assert.equal(err.code, 'forbidden');
});

test('STRATEGY update_pillar: metricType flows onto the value metric (custom unit + monetary)', async () => {
  resetPillars();
  const p = payload<{ id: string }>(await call(salesBuilder, 'create_pillar', { name: 'Support', scope: 'domain', domain: 'sales' }));
  const updated = payload<{ valueMetric: { metricType: string; customUnit: string; customMonetary: boolean } }>(
    await call(salesBuilder, 'update_pillar', { pillarId: p.id, valueMetric: { metricType: 'custom', customUnit: 'tickets', customMonetary: false } }),
  );
  assert.equal(updated.valueMetric.metricType, 'custom');
  assert.equal(updated.valueMetric.customUnit, 'tickets');
  assert.equal(updated.valueMetric.customMonetary, false);
});
