/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for GRANTS → runtime data-plane tool mapping (Piece 2 of the grants wave). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataPlaneToolsFromGrants, agentToolsFromGrants } from './grant-tools.ts';
import { emptyContextGrants, type ContextGrants } from '@/lib/core/context-grants';

function grantsWith(patch: Partial<ContextGrants>): ContextGrants {
  return { ...emptyContextGrants(), ...patch };
}
const names = (g: ContextGrants) => dataPlaneToolsFromGrants(g).map((t) => t.name);

test('grant-tools: empty grants ⇒ no data-plane tools (fail-closed baseline)', () => {
  assert.deepEqual(dataPlaneToolsFromGrants(emptyContextGrants()), []);
});

test('grant-tools: a DATA grant enables query_data + its discovery companions', () => {
  const n = names(grantsWith({ data: [{ id: 'ds_1', access: 'read-only' }] }));
  assert.deepEqual(n, ['query_data', 'list_datasets', 'get_dataset', 'profile_dataset']);
});

test('grant-tools: a KNOWLEDGE grant enables search_knowledge + list_knowledge', () => {
  const n = names(grantsWith({ knowledge: [{ id: 'wf_1', access: 'read-only' }] }));
  assert.deepEqual(n, ['search_knowledge', 'list_knowledge']);
});

test('grant-tools: a FILES grant enables get_file + list/search companions', () => {
  const n = names(grantsWith({ files: [{ id: 'f_1', access: 'read-only' }] }));
  assert.deepEqual(n, ['get_file', 'list_files', 'search_files']);
});

test('grant-tools: a METRICS grant enables query_metric + list_metrics', () => {
  const n = names(grantsWith({ metrics: [{ id: 'ds.rev', access: 'read-only' }] }));
  assert.deepEqual(n, ['query_metric', 'list_metrics']);
});

test('grant-tools: a CONNECTIONS grant maps to connection_<id> per granted connection', () => {
  const n = names(
    grantsWith({ connections: [{ id: 'c_a', access: 'read-only' }, { id: 'c_b', access: 'read-write' }] }),
  );
  assert.deepEqual(n, ['connection_c_a', 'connection_c_b']);
});

test('grant-tools: mixed grants combine, deduped + stable order (data→knowledge→files→metrics→conns)', () => {
  const n = names(
    grantsWith({
      data: [{ id: 'ds_1', access: 'read-only' }, { id: 'ds_2', access: 'read-write' }],
      knowledge: [{ id: 'wf_1', access: 'read-only' }],
      metrics: [{ id: 'ds.rev', access: 'read-only' }],
      connections: [{ id: 'c_a', access: 'read-only' }],
    }),
  );
  assert.deepEqual(n, [
    'query_data', 'list_datasets', 'get_dataset', 'profile_dataset',
    'search_knowledge', 'list_knowledge',
    'query_metric', 'list_metrics',
    'connection_c_a',
  ]);
  // No duplicate tool names even with multiple grants in a kind.
  assert.equal(new Set(n).size, n.length);
});

test('grant-tools: data-plane grants are READ-ONLY (least privilege — no auto-write)', () => {
  const tools = dataPlaneToolsFromGrants(
    grantsWith({
      data: [{ id: 'ds_1', access: 'read-write' }],
      knowledge: [{ id: 'wf_1', access: 'read-propose' }],
      connections: [{ id: 'c_a', access: 'read-write' }],
    }),
  );
  assert.ok(tools.length > 0);
  assert.ok(tools.every((t) => t.write === false), 'no granted context kind auto-enables a write tool');
});

test('grant-tools: every derived tool carries a non-empty description', () => {
  const tools = dataPlaneToolsFromGrants(
    grantsWith({
      data: [{ id: 'ds_1', access: 'read-only' }],
      connections: [{ id: 'c_a', access: 'read-only' }],
    }),
  );
  assert.ok(tools.every((t) => typeof t.description === 'string' && t.description.length > 0));
});

test('agent-tools: empty agent grants ⇒ [] (fail-closed)', () => {
  assert.deepEqual(agentToolsFromGrants([]), []);
});

test('agent-tools: a granted agent enables run_agent_system + list_agent_systems (once)', () => {
  const tools = agentToolsFromGrants([
    { id: 'sys_1', access: 'read-only' },
    { id: 'sys_2', access: 'read-write' },
  ]);
  const n = tools.map((t) => t.name);
  assert.deepEqual(n, ['run_agent_system', 'list_agent_systems'], 'stable, deduped set regardless of grant count');
  const run = tools.find((t) => t.name === 'run_agent_system')!;
  assert.equal(run.write, true, 'running a governed agent is a write tool');
  assert.equal(tools.find((t) => t.name === 'list_agent_systems')!.write, false);
  assert.ok(tools.every((t) => t.description.length > 0));
});
