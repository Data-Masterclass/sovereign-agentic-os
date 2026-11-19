/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An app starts the agent system it was granted through its tool door
 * USER STORY: As the owner of an app I grant it one agent system in Choose Context → Agents.
 *             The app's tool door then offers `run_agent_system` and `list_agent_systems`.
 *             Calling `run_agent_system` starts that agent as me, the signed-in user, and only
 *             that agent; `list_agent_systems` shows it by name. When I remove the grant, the
 *             next call is refused.
 * ARCHITECTURE:
 *   - Drives the REAL tool route (`POST /api/apps/[id]/tool`) over the REAL apps store, the REAL
 *     agents store and the REAL MCP door (`handleRpc`): the agent system is created with
 *     `create_agent_system` exactly as a client would. Only the session (auth seam) and the
 *     engine start (`__setStartQueuedRunForTests`, the hook the MCP's own tests use, so no live
 *     model is called) are stand-ins; the start hook records who started which system.
 *   - Before the fix the door held `run_agent_system` as an app write (202, an approval card)
 *     and no run was ever started; `list_agent_systems` went to the app's own runner.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const USER = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => USER, currentUser: async () => USER },
});

const { handleRpc } = await import('@core/mcp/server');
const { __setStartQueuedRunForTests } = await import('@core/mcp/write-tools');
const { __resetStore: resetAgents } = await import('@tabs/agents/lib/store');
const { __resetApprovals, listApprovals } = await import('@core/policy/approvals');
const { createApp, writeThroughApp, compileAppProfile, __resetAppsCache } = await import('./apps.ts');
const { POST } = await import('../../../app/api/apps/[id]/tool/route.ts');

async function createSystem(name: string): Promise<string> {
  const res = await handleRpc(USER as never, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_agent_system', arguments: { name, template: 'analyze' } } });
  const text = ((res as { result: { content: { text: string }[] } }).result.content[0]).text;
  return (JSON.parse(text) as { id: string }).id;
}

let started: { userId: string; systemId: string; messages: unknown }[] = [];
let appId = '';
let granted = '';
let other = '';

beforeEach(async () => {
  resetAgents();
  __resetApprovals();
  __resetAppsCache();
  started = [];
  __setStartQueuedRunForTests(async (input) => {
    started.push({ userId: input.user.id, systemId: input.systemId, messages: input.messages });
    return { runId: input.runId, body: { path: ['analyst'], finalText: 'Done.', reachedEnd: true, checkpointer: 'memory', nodes: [] } };
  });
  granted = await createSystem('Invoice triage');
  other = await createSystem('Board pack writer');
  const app = await createApp(USER as never, { name: 'Invoices', template: 'sovereign-app' });
  app.agents = [{ id: granted, access: 'read-only' }];
  compileAppProfile(app);
  writeThroughApp(app);
  appId = app.id;
});

function callTool(tool: string, args: Record<string, unknown>) {
  const req = new Request(`http://os.local/api/apps/${appId}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  return POST(req, { params: Promise.resolve({ id: appId }) });
}

test('run_agent_system starts the granted agent system as the signed-in user', async () => {
  const res = await callTool('run_agent_system', { systemId: granted, message: 'Triage the new invoices' });
  const body = (await res.json()) as { decision: string; result?: { runId?: string; finalText?: string } };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(started.map((s) => [s.userId, s.systemId]), [['ben', granted]]);
  assert.deepEqual(started[0].messages, [{ role: 'user', content: 'Triage the new invoices' }]);
  assert.equal(body.result?.finalText, 'Done.');
  assert.ok(body.result?.runId, 'the run id comes back so the app can follow the run');
  assert.equal(listApprovals().length, 0, 'starting a granted agent files no approval card');
});

test('run_agent_system refuses an agent system the app was not granted, even one the user may run', async () => {
  const res = await callTool('run_agent_system', { systemId: other, message: 'Write the board pack' });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { reason: string };
  assert.match(body.reason, /was not granted the agent system/);
  assert.match(body.reason, /Choose Context/);
  assert.deepEqual(started, []);
  assert.equal(listApprovals().length, 0);
});

test('list_agent_systems lists only the granted agent system, by name', async () => {
  const res = await callTool('list_agent_systems', {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { systems: { id: string; name: string; available: boolean }[] } };
  assert.deepEqual(body.result.systems.map((s) => [s.id, s.name, s.available]), [[granted, 'Invoice triage', true]]);
});

test('after the grant is removed, the app can no longer start the agent', async () => {
  const res1 = await callTool('run_agent_system', { systemId: granted, message: 'first' });
  assert.equal(res1.status, 200);
  const { getAppForUser } = await import('./apps.ts');
  const app = await getAppForUser(appId, USER as never);
  app.agents = [];
  compileAppProfile(app);
  writeThroughApp(app);
  const res2 = await callTool('run_agent_system', { systemId: granted, message: 'second' });
  assert.equal(res2.status, 403);
  assert.equal(started.length, 1, 'only the run made while it was granted was started');
});
