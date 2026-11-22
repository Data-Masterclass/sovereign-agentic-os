/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * workflow-write.int.test — the OPA rule `agentic.authz.workflow_write` against the REAL OPA container
 * started from the chart (tests/opa/run-chart-opa.py, the chart's pinned image and its rendered
 * policies), reached through the OS's real `authorize()` and the real MCP workflow tools.
 *
 *  1. The decision table (create / index / publish / retire × owner, builder, domain admin, admin,
 *     a user outside the domain) is asked of real OPA and must match the policy's intent.
 *  2. The tools: the owner authors and indexes in My scope; a creator cannot publish to Domain; a
 *     domain admin of ANOTHER domain cannot publish it; nothing is written by a refused call.
 *  3. Fail closed: with the OPA container STOPPED, authoring is refused and nothing is written.
 *
 * Run: OPA_IT_OPEN_URL=http://127.0.0.1:18182 OPA_IT_OPEN_CONTAINER=opa-it-open node \
 *   --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/workflow-write.int.test.ts
 *   (from os-ui/; the open instance has OPA's API protection off, the policies are the chart's)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const OPA = process.env.OPA_IT_OPEN_URL;
const CONTAINER = process.env.OPA_IT_OPEN_CONTAINER;
if (!OPA || !CONTAINER) throw new Error('workflow-write.int.test needs OPA_IT_OPEN_URL and OPA_IT_OPEN_CONTAINER (a real OPA container)');
process.env.OPA_URL = OPA;
// This suite is about the production path: no test gate.
delete (globalThis as Record<symbol, unknown>)[Symbol.for('soa.test.workflowWriteGate')];

const { authorize } = await import('@core/infra/governed');
const { handleRpc } = await import('@core/mcp/server');
const { __resetStore: resetWorkflows, listWorkflows } = await import('@tabs/knowledge/lib/store');

type U = { id: string; name: string; domains: string[]; role: 'creator' | 'builder' | 'domain_admin' | 'admin' };
const cara: U = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const ben: U = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const dana: U = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const ada: U = { id: 'ada', name: 'Ada', domains: [], role: 'admin' };
const fred: U = { id: 'fred', name: 'Fred', domains: ['finance'], role: 'creator' };
const fina: U = { id: 'fina', name: 'Fina', domains: ['finance'], role: 'domain_admin' };

const wfOf = (owner: string, tier: string, domain = 'sales') => ({ id: 'wf_1', tier, owner, domain });
async function decide(op: string, u: U, workflow: Record<string, unknown>): Promise<boolean> {
  const r = await authorize(`user:${u.id}`, 'workflow.write', {
    rule: 'workflow_write',
    input: { action: 'workflow.write', op, actor: { id: u.id, role: u.role, domains: u.domains }, workflow },
  });
  return r.allowed;
}

test('real OPA: the decision table', async () => {
  const table: [string, string, U, Record<string, unknown>, boolean][] = [
    ['create', 'owner, own domain', cara, { id: '', tier: 'personal', owner: 'cara', domain: 'sales' }, true],
    ['create', 'a domain the caller is not in', fred, { id: '', tier: 'personal', owner: 'fred', domain: 'sales' }, false],
    ['create', 'for someone else', cara, { id: '', tier: 'personal', owner: 'maya', domain: 'sales' }, false],
    ['index', 'owner', cara, wfOf('cara', 'personal'), true],
    ['index', 'builder of the domain', ben, wfOf('cara', 'personal'), true],
    ['index', 'outsider', fred, wfOf('cara', 'personal'), false],
    ['publish', 'domain admin of the domain', dana, wfOf('cara', 'personal'), true],
    ['publish', 'admin', ada, wfOf('cara', 'personal'), true],
    ['publish', 'creator who owns it (to Domain)', cara, wfOf('cara', 'personal'), false],
    ['publish', 'builder', ben, wfOf('cara', 'personal'), false],
    ['publish', 'domain admin of another domain', fina, wfOf('cara', 'personal'), false],
    ['retire', 'owner', cara, wfOf('cara', 'personal'), true],
    ['retire', 'builder on a shared one', ben, wfOf('maya', 'shared'), true],
    ['retire', 'builder on a private one', ben, wfOf('cara', 'personal'), false],
    ['retire', 'user outside the domain', fred, wfOf('maya', 'shared'), false],
  ];
  for (const [op, who, u, wf, want] of table) assert.equal(await decide(op, u, wf), want, `${op} — ${who}`);
});

test('real OPA, real tools: owner authors and indexes; a creator cannot publish; another domain’s admin cannot publish; a refused call writes nothing', async () => {
  resetWorkflows();
  const call = async (u: U, name: string, args: Record<string, unknown> = {}) => {
    const res = (await handleRpc(u, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: { error: { code: string } } } };
    return res.result;
  };
  const made = await call(cara, 'author_workflow', { title: 'Refund handling' });
  assert.notEqual(made.isError, true, made.content[0].text);
  const id = (JSON.parse(made.content[0].text) as { id: string }).id;
  assert.notEqual((await call(cara, 'index_workflow', { workflowId: id })).isError, true, 'the owner indexes in My scope');

  const creatorPublish = await call(cara, 'publish_workflow', { workflowId: id });
  assert.equal(creatorPublish.structuredContent?.error.code, 'forbidden');
  const otherDomain = await call(fina, 'publish_workflow', { workflowId: id });
  assert.equal(otherDomain.isError, true);
  const mine = listWorkflows({ id: 'cara', domains: ['sales'], role: 'creator' }).mine;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].visibility, 'Personal', 'nothing was published');
  assert.notEqual((await call(cara, 'request_promotion', { kind: 'workflow', id })).isError, true, 'the owner files the request');
  assert.notEqual((await call(dana, 'publish_workflow', { workflowId: id })).isError, true, 'the domain admin of the domain publishes');
});

test('real OPA STOPPED: authoring is refused (fail closed) and nothing is written', async () => {
  resetWorkflows();
  execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
  try {
    const res = (await handleRpc(cara, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'author_workflow', arguments: { title: 'Should not exist' } } })) as { result: { isError?: boolean; structuredContent?: { error: { code: string } } } };
    assert.equal(res.result.isError, true);
    assert.equal(res.result.structuredContent?.error.code, 'forbidden');
    assert.equal(listWorkflows({ id: 'cara', domains: ['sales'], role: 'creator' }).mine.length, 0);
  } finally {
    execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
  }
});

after(() => {
  try { execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' }); } catch { /* already running */ }
});
