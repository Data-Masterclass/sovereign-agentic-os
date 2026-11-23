/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The user's external (Notion) tools reach the chat's COMPACT tool set, and the confirm gate still holds
 * USER STORY: As a user with a Notion connection I want the chat to be able to use it in the same turn, even though a
 *             chat call now carries only a compact tool set; a Notion read runs, a Notion write waits for my confirmation.
 * ARCHITECTURE: the REAL `runOsAssistant` (compact loader, `closed` refusal, confirm gate, external wrapper); the model
 *   (scripted), the Connections source and OPA's answer are the only stand-ins. Twins: a user with no connection gets
 *   none of these tools; an OS write tool that was not loaded is still refused (the compact set is not widened).
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { __resetConfirmations } from '@core/policy/confirmations';

const realOpa = await import('@core/adapters/opa/client');
mock.module('@core/adapters/opa/client', {
  namedExports: {
    ...realOpa,
    opaDecide: async (path: string, input: Record<string, unknown>, ...rest: unknown[]) => {
      if (path !== 'os/external_mcp/decision') return (realOpa.opaDecide as (...a: unknown[]) => unknown)(path, input, ...rest);
      const i = input as { user: { id: string }; read_only: boolean; confirmed: boolean };
      if (i.user.id !== 'nora') return { ok: true, value: { defined: true, value: { effect: 'deny', reason: 'connection_not_visible' } } };
      const effect = i.read_only || i.confirmed ? 'allow' : 'requires_approval';
      return { ok: true, value: { defined: true, value: { effect, reason: 'test' } } };
    },
  },
});
const ext = await import('@core/runtime/external-mcp');
const { runOsAssistant } = await import('@core/runtime/agent-loop');

const nora: CurrentUser = { id: 'nora', name: 'Nora', domains: ['sales'], role: 'creator' };
const omar: CurrentUser = { id: 'omar', name: 'Omar', domains: ['sales'], role: 'creator' };

const sourceCalls: string[] = [];
const source: import('@core/runtime/external-mcp').ExternalMcpSource = {
  listConnections: async (u) => (u.id === 'nora' ? [{ id: 'c1', provider: 'notion', name: 'My Notion', owner: 'nora', domain: 'sales', visibility: 'private', auth: 'oauth', archived: false } as never] : []),
  listTools: async () => [
    { name: 'notion-search', description: 'Search', readOnly: true, inputSchema: { type: 'object', properties: {} } },
    { name: 'notion-create-pages', description: 'Create pages', readOnly: false, inputSchema: { type: 'object', properties: {} } },
  ],
  call: async (_u, _c, tool) => { sourceCalls.push(tool); return { text: '{"ok":true}', isError: false }; },
};
const READ = ext.wireName('notion', 'c1', 'notion-search');
const WRITE = ext.wireName('notion', 'c1', 'notion-create-pages');

beforeEach(() => { __resetConfirmations(); sourceCalls.length = 0; ext.registerExternalMcpSource(source); });

type Reply = { name: string; args: Record<string, unknown> }[];
function scripted(offered: string[][], acts: Reply[]): LlmCall {
  let a = 0;
  return async (req) => {
    if (!req.tools) return { content: '1. do it', toolCalls: [] };
    offered.push(req.tools.map((t) => t.function.name));
    const calls = acts[a++] ?? [];
    return { content: calls.length ? '' : 'done', toolCalls: calls.map((c, i) => ({ id: `t${a}-${i}`, name: c.name, args: c.args })) };
  };
}
const dispatchSpy: string[] = [];
const dispatch = async (_u: CurrentUser, req: { params?: unknown }) => {
  dispatchSpy.push(String((req.params as { name?: string }).name));
  return { jsonrpc: '2.0' as const, id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
};
const turn = (user: CurrentUser, llm: LlmCall) =>
  runOsAssistant({ user, tab: null, messages: [{ role: 'user', content: 'search my notion' }], llm, dispatch } as Parameters<typeof runOsAssistant>[0]);

test('the owner is OFFERED the Notion tools and the import tools in the compact set, next to the core read tools', async () => {
  const offered: string[][] = [];
  await turn(nora, scripted(offered, [[]]));
  const first = offered[0];
  for (const n of [READ, WRITE, ext.PREVIEW_TOOL, ext.IMPORT_TOOL, 'list_datasets', 'enable_tools']) assert.ok(first.includes(n), `${n} is offered: ${first.join(', ')}`);
  assert.ok(!first.includes('create_dataset'), 'the compact set is not widened: an OS write tool of an unloaded toolset is not offered');
});

test('TWIN: a user with no connection is offered none of them', async () => {
  const offered: string[][] = [];
  await turn(omar, scripted(offered, [[]]));
  for (const n of [READ, WRITE, ext.PREVIEW_TOOL, ext.IMPORT_TOOL]) assert.ok(!offered[0].includes(n), `${n} must not be offered`);
});

test('a Notion READ runs in the turn (not refused as not loaded) and reaches the connection once', async () => {
  const offered: string[][] = [];
  const r = await turn(nora, scripted(offered, [[{ name: READ, args: { query: 'plan' } }], []]));
  assert.deepEqual(sourceCalls, ['notion-search']);
  assert.ok(!JSON.stringify(r).includes('tool_not_loaded'), 'the external read is not refused by the compact-set rule');
});

test('a Notion WRITE parks behind the confirm card and the connection is not called', async () => {
  const r = await turn(nora, scripted([], [[{ name: WRITE, args: { pages: [] } }], []]));
  assert.deepEqual(sourceCalls, [], 'nothing was sent to Notion');
  assert.equal(r.pending?.length, 1);
  assert.equal(r.pending?.[0].tool, WRITE);
});

test('TWIN: an OS write tool that was not loaded is still refused before the gate (nothing parked, nothing dispatched)', async () => {
  const r = await turn(nora, scripted([], [[{ name: 'create_dataset', args: { name: 'X', domain: 'sales' } }], []]));
  assert.deepEqual(dispatchSpy.filter((n) => n === 'create_dataset'), []);
  assert.equal(r.pending?.length ?? 0, 0);
});
