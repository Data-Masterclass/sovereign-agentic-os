/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An approved app write runs
 * USER STORY: As a user my app's write is held for approval; once approved it is written, as me.
 *             As the approver I see whether it ran, including when the app was deleted meanwhile.
 * ARCHITECTURE:
 *   - The real path end to end: the REAL `callAppTool` holds the write into the REAL approvals
 *     queue, and the REAL `applyEffect` decides it with the applier the boot registers. Only the
 *     app's governed authorisation (`@core/infra/agent-governed`), the app's committed tree and
 *     the executor that would reach the running app are mocked; the executor records what it was
 *     asked to write and as whom.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let AUTHZ: { effect: string; reason: string } = { effect: 'requires_approval', reason: 'writes are held' };
// The rest of the module stays real (the approvals and effects modules import more of it).
const realGoverned = await import('@core/infra/agent-governed');
mock.module('@core/infra/agent-governed', {
  namedExports: {
    ...realGoverned,
    authorizeConnectionCall: () => AUTHZ,
    authorizeAppTool: async () => ({ effect: 'allow', policy: 'app-grant', reason: 'grant' }),
    exposedConnectionTools: () => [],
    trace: async () => ({ id: 'tr_1' }),
  },
});
const realSnapshot = await import('./snapshot.ts');
mock.module('./snapshot.ts', { namedExports: { ...realSnapshot, getSnapshot: () => [], hydrateSnapshot: async () => [] } });
const realRecords = await import('./app-records.ts');

let writes: { tool: string; args: Record<string, unknown>; actor?: { id: string; domain: string } }[] = [];
let executorAnswer: Record<string, unknown> = { ok: true, id: 'rec_1' };
mock.module('./app-records.ts', {
  namedExports: {
    ...realRecords,
    executeAppTool: async (_app: unknown, tool: string, args: Record<string, unknown>, actor?: { id: string; domain: string }) => {
      writes.push({ tool, args, actor });
      return executorAnswer;
    },
  },
});

const { callAppTool } = await import('./app-tool-call.ts');
const { applyApprovedAppWrite } = await import('./app-write-approval.ts');
const { getApproval, __resetApprovals } = await import('@core/policy/approvals');
const { applyEffect } = await import('@core/policy/effects');

type TestApp = Parameters<typeof callAppTool>[0];
const app = { id: 'app_1', name: 'Expenses', domain: 'sales', mcpPrincipal: 'app:app_1', mcpTools: [] } as unknown as TestApp;
let APPS: Record<string, TestApp> = {};
const approver = { id: 'bea', role: 'builder' as const, domains: ['sales'] };
const deps = { applyAppWrite: (req: Parameters<typeof applyApprovedAppWrite>[0]) => applyApprovedAppWrite(req, { getApp: async (id) => APPS[id] ?? null }) };

async function holdOne() {
  const held = await callAppTool(app, 'add_record', { amount: 42 }, 'dan', { tool: 'add_record' }, { id: 'dan', domain: 'sales' });
  assert.equal(held.status, 202);
  assert.equal(writes.length, 0, 'held, not written');
  const approval = getApproval(String(held.body.approvalId));
  assert.ok(approval, 'the 202 names the approval in the queue');
  return approval!;
}

beforeEach(() => {
  __resetApprovals();
  writes = [];
  AUTHZ = { effect: 'requires_approval', reason: 'writes are held' };
  executorAnswer = { ok: true, id: 'rec_1' };
  APPS = { app_1: app };
});

test('approving a held app write runs it, with the requester as the record author', async () => {
  const out = await applyEffect(await holdOne(), approver, deps);
  assert.equal(out.ok, true, out.applied);
  assert.equal(out.live, true);
  assert.deepEqual(writes, [{ tool: 'add_record', args: { amount: 42 }, actor: { id: 'dan', domain: 'sales' } }]);
});

test('the app was deleted before the approval: the approval says so and nothing is written', async () => {
  const approval = await holdOne();
  delete APPS.app_1;
  const out = await applyEffect(approval, approver, deps);
  assert.equal(out.ok, false);
  assert.match(out.applied, /has been deleted\. Nothing was written/);
  assert.equal(writes.length, 0);
});

test('the app lost the right meanwhile: the approval fails with the gate’s reason', async () => {
  const approval = await holdOne();
  AUTHZ = { effect: 'deny', reason: 'add_record is no longer exposed' };
  const out = await applyEffect(approval, approver, deps);
  assert.equal(out.ok, false);
  assert.match(out.applied, /may no longer run add_record: add_record is no longer exposed/);
  assert.equal(writes.length, 0);
});

test('the app answered that the write failed: the approval is not reported as done', async () => {
  const approval = await holdOne();
  executorAnswer = { ok: false, reason: 'amount over the limit' };
  const out = await applyEffect(approval, approver, deps);
  assert.equal(out.ok, false);
  assert.match(out.applied, /amount over the limit/);
});

test('with no app-write runner in the process the approval says it did not run, never "applied (mock)"', async () => {
  const out = await applyEffect(await holdOne(), approver, {});
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.applied, /mock/);
  assert.equal(writes.length, 0);
});
