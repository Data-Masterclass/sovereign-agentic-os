/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, ALL_MCP_TOOLS, toolsForTab, type JsonRpcResponse, type ToolError } from './server.ts';

/**
 * MCP PARITY for the DQ remediation surface (house rule): propose_quality_fixes +
 * apply_quality_fixes mirror the /dq/propose and /dq/apply routes — same lib calls,
 * same gates. These tests pin the REGISTRY contract and the argument/scope guards
 * that must hold before any governed work runs (offline, no cluster).
 */

const admin: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' } as CurrentUser;

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

test('DQ-fix registry: both tools on the data tab, creator floor, worked examples, propose→apply guidance', () => {
  const byName = new Map(ALL_MCP_TOOLS.map((t) => [t.name, t]));
  const tabNames = new Set(toolsForTab('data').map((t) => t.name));
  for (const n of ['propose_quality_fixes', 'apply_quality_fixes']) {
    const t = byName.get(n)!;
    assert.ok(t, `${n} registered`);
    assert.equal(t.tab, 'data', `${n} on the data tab`);
    assert.equal(t.minRole, 'creator', `${n} floors at creator (governed fns re-gate)`);
    assert.ok(tabNames.has(n), `${n} surfaced on the data tab view`);
    assert.ok((t.inputSchema.examples ?? []).length >= 1, `${n} carries a worked example`);
  }
  assert.match(byName.get('propose_quality_fixes')!.description, /READ-ONLY/, 'propose documents that it never writes');
  assert.match(byName.get('apply_quality_fixes')!.description, /edit/i, 'apply documents the edit gate');
  assert.match(byName.get('run_quality_checks')!.description, /propose_quality_fixes/, 'the golden path chains run → propose');
});

test('propose_quality_fixes: argument guards fire before any governed work', async () => {
  const noDs = errorOf(await call(admin, 'propose_quality_fixes', { checkId: 'c1' }));
  assert.match(noDs.reason, /datasetId/);
  const noChk = errorOf(await call(admin, 'propose_quality_fixes', { datasetId: 'ds_x' }));
  assert.match(noChk.reason, /checkId/);
});

test('propose_quality_fixes: an id you cannot see is a typed not-found (no existence leak)', async () => {
  const err = errorOf(await call(admin, 'propose_quality_fixes', { datasetId: 'ds_does_not_exist', checkId: 'c1' }));
  assert.match(err.reason, /not found|Not permitted/i);
});

test('apply_quality_fixes: the edit gate runs BEFORE mode/payload validation (no leak through errors)', async () => {
  const err = errorOf(await call(admin, 'apply_quality_fixes', { datasetId: 'ds_does_not_exist', checkId: 'c1', mode: 'weird' }));
  assert.match(err.reason, /not found|Not permitted/i, 'the scope answer, not a payload hint');
  const noArgs = errorOf(await call(admin, 'apply_quality_fixes', { checkId: 'c1', mode: 'batch' }));
  assert.match(noArgs.reason, /datasetId/);
});
