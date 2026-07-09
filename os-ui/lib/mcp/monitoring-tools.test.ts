/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';
import { ALL_WRITE_TOOLS } from './write-tools.ts';
import { SALES_OWNER, OTHER_OWNER } from '@/lib/monitoring/mock';

/**
 * MONITORING SURFACE (mcp-v2 P4) — READ-ONLY + HARD-SCOPED. The security heart:
 * a creator sees ONLY their own runs, and `get_run_trace` throws BEFORE any step
 * is returned for a trace outside scope. Driven over handleRpc, offline against
 * the mock lenses (owners `u_sales_rep` vs `u_other`).
 */

// The creator's id MATCHES the mock run owner, so scope=own resolves to real items.
const salesRep: CurrentUser = { id: SALES_OWNER, name: 'Rep', domains: ['sales'], role: 'creator' };
const salesAdmin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };

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

test('MONITORING registry: three read-only tools under the monitoring tab, none a write', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const writeNames = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  const tabNames = new Set(toolsForTab('monitoring').map((t) => t.name));
  for (const n of ['get_monitoring_overview', 'list_runs', 'get_run_trace']) {
    const t = byName.get(n)!;
    assert.ok(t, `${n} registered`);
    assert.equal(t.minRole, 'creator', `${n} floors at creator`);
    assert.equal(t.tab, 'monitoring');
    assert.ok(tabNames.has(n), `${n} on the monitoring tab`);
    assert.ok(!writeNames.has(n), `${n} is read-only (Monitoring has NO writes)`);
    assert.ok((t.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
  }
});

test('MONITORING list_runs — a creator sees ONLY their own runs (filterScope)', async () => {
  const out = payload<{ scope: { level: string }; runs: { owner: string; id: string }[] }>(
    await call(salesRep, 'list_runs', {}),
  );
  assert.equal(out.scope.level, 'user', 'a creator resolves to user scope');
  assert.ok(out.runs.length > 0, 'the creator has runs (their own)');
  for (const r of out.runs) assert.equal(r.owner, SALES_OWNER, 'every visible run is owned by the caller');
  assert.ok(!out.runs.some((r) => r.owner === OTHER_OWNER), 'another user’s run never appears');
});

test('MONITORING get_run_trace — HARD gate: own trace ok, another user’s → forbidden, missing → not_found', async () => {
  // Own trace (run-2002, owner u_sales_rep) → returned.
  const trace = payload<{ id: string; owner: string; steps: unknown[] }>(await call(salesRep, 'get_run_trace', { runId: 'run-2002' }));
  assert.equal(trace.owner, SALES_OWNER);
  assert.ok(Array.isArray(trace.steps), 'the trace steps are returned for the owner');

  // Another user's trace (run-2050, owner u_other/finance) → forbidden BEFORE any step.
  const denied = errorOf(await call(salesRep, 'get_run_trace', { runId: 'run-2050' }));
  assert.equal(denied.code, 'forbidden', 'a creator cannot open another user’s trace by guessing its id');

  // A missing id → not_found (indistinguishable from denied).
  const missing = errorOf(await call(salesRep, 'get_run_trace', { runId: 'no-such-run' }));
  assert.equal(missing.code, 'not_found');
});

test('MONITORING get_run_trace — an admin CAN open a cross-domain trace (tenant scope)', async () => {
  const trace = payload<{ id: string; owner: string }>(await call(salesAdmin, 'get_run_trace', { runId: 'run-2050' }));
  assert.equal(trace.owner, OTHER_OWNER, 'admin scope reaches the tenant');
});

test('MONITORING get_monitoring_overview — scoped, and no out-of-scope owner leaks', async () => {
  const ov = payload<{ scope: { level: string }; lenses: { items: { owner: string }[] }[]; attention: { owner: string }[] }>(
    await call(salesRep, 'get_monitoring_overview', {}),
  );
  assert.equal(ov.scope.level, 'user');
  const owners = [...ov.attention.map((a) => a.owner), ...ov.lenses.flatMap((l) => l.items.map((i) => i.owner))];
  assert.ok(!owners.includes(OTHER_OWNER), 'no other-user signal in a creator’s overview');
});
