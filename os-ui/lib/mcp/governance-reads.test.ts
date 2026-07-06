/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';
import { __resetCost, setCap, addSpend } from '@/lib/governance/cost';
import { __resetPlane } from '@/lib/governance/policy-view';

/**
 * GOVERNANCE READS (mcp-v2 P1) — get_policy_view (policy plane, policy.view right,
 * scoped) + get_cost (caps + alerts, scoped). Thin wrappers over the SAME lib the
 * /api/governance routes call. Asserts the policy.view floor + per-scope
 * correctness (a Builder sees own-domain; a creator only their own cost).
 */

const salesCreator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const salesBuilder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

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

test('GOVERNANCE reads registry: get_policy_view builder-floored, get_cost creator, both on governance tab', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const tabNames = new Set(toolsForTab('governance').map((t) => t.name));
  const pv = byName.get('get_policy_view')!;
  const gc = byName.get('get_cost')!;
  assert.equal(pv.minRole, 'builder');
  assert.equal(gc.minRole, 'creator');
  assert.ok(tabNames.has('get_policy_view') && tabNames.has('get_cost'));
});

test('GOVERNANCE get_policy_view — a creator is forbidden; a builder sees a scoped plane; admin can override', async () => {
  __resetPlane();
  // Creator: below the builder floor → forbidden.
  assert.equal(errorOf(await call(salesCreator, 'get_policy_view')).code, 'forbidden');

  // Builder: has policy.view.domain → sees the plane, cannot override.
  const bview = payload<{ plane: unknown[]; sources: unknown[]; canOverride: boolean }>(await call(salesBuilder, 'get_policy_view'));
  assert.ok(Array.isArray(bview.plane) && Array.isArray(bview.sources), 'the consolidated plane + sources are returned');
  assert.equal(bview.canOverride, false, 'a builder cannot override policy');

  // Admin: tenant-wide + canOverride.
  const aview = payload<{ canOverride: boolean }>(await call(admin, 'get_policy_view'));
  assert.equal(aview.canOverride, true);
});

test('GOVERNANCE get_cost — scoped to the caller: a creator sees own-domain caps + alerts, not another domain’s', async () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'sales', limit: 100, createdBy: 'seed' });
  setCap({ scope: 'domain', subject: 'finance', limit: 100, createdBy: 'seed' });
  addSpend('domain', 'sales', 95); // 95% → 'near'

  const out = payload<{ canSetCap: boolean; caps: { subject: string; alert: string }[]; alerts: unknown[] }>(
    await call(salesCreator, 'get_cost'),
  );
  assert.equal(out.canSetCap, false, 'a creator cannot set caps');
  const subjects = out.caps.map((c) => c.subject);
  assert.ok(subjects.includes('sales'), 'own-domain cap present');
  assert.ok(!subjects.includes('finance'), 'another domain’s cap is not in scope');
  const salesCap = out.caps.find((c) => c.subject === 'sales')!;
  assert.equal(salesCap.alert, 'near', 'the near-cap alert is computed via checkCap');
  assert.ok(out.alerts.length >= 1, 'the near/over alert surfaces');
});

test('GOVERNANCE get_cost — an admin sees tenant-wide caps + canSetCap', async () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'sales', limit: 100, createdBy: 'seed' });
  setCap({ scope: 'domain', subject: 'finance', limit: 100, createdBy: 'seed' });
  const out = payload<{ canSetCap: boolean; caps: { subject: string }[] }>(await call(admin, 'get_cost'));
  assert.equal(out.canSetCap, true);
  const subjects = out.caps.map((c) => c.subject);
  assert.ok(subjects.includes('sales') && subjects.includes('finance'), 'admin sees every domain’s caps');
});
