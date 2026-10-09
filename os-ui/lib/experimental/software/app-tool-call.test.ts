/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * callAppTool — the governed spine behind the apps/[id]/tool route, lifted out of
 * the route verbatim. These pin the three governed outcomes it maps to HTTP:
 *   • a WRITE tool → held for approval (202, enqueued, traced requires_approval),
 *   • a DENIED tool → 403 (traced deny, NOT executed),
 *   • an ALLOWED tool → 200 (executed via the shared executor, traced allow).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let AUTHZ_CONN: { effect: string; reason: string } = { effect: 'allow', reason: 'read' };
const enqueued: unknown[] = [];
const traced: { decision: string }[] = [];
let executed = false;

mock.module('@/lib/infra/agent-governed', {
  namedExports: {
    authorizeConnectionCall: () => AUTHZ_CONN,
    authorizeAppTool: async () => ({ effect: 'allow', policy: 'app-grant', reason: 'grant' }),
    trace: async (e: { decision: string }) => {
      traced.push(e);
      return { id: `tr_${traced.length}` };
    },
  },
});
mock.module('@/lib/governance/approvals', {
  namedExports: {
    enqueue: (x: unknown) => {
      enqueued.push(x);
    },
  },
});
mock.module('./app-records.ts', {
  namedExports: {
    executeAppTool: async () => {
      executed = true;
      return { ok: true, source: 'demo-seed' };
    },
  },
});

const { callAppTool } = await import('./app-tool-call.ts');

const app = {
  id: 'app_1',
  name: 'Demo',
  domain: 'eng',
  mcpPrincipal: 'app:app_1',
} as unknown as Parameters<typeof callAppTool>[0];

test('allowed read tool → 200, executed, traced allow', async () => {
  AUTHZ_CONN = { effect: 'allow', reason: 'read' };
  executed = false;
  const r = await callAppTool(app, 'list_records', { limit: 5 }, 'dan', { tool: 'list_records', args: { limit: 5 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, 'allow');
  assert.ok(executed, 'the shared executor ran');
  assert.equal(traced.at(-1)?.decision, 'allow');
});

test('write tool → 202, enqueued for approval, traced requires_approval, NOT executed', async () => {
  AUTHZ_CONN = { effect: 'requires_approval', reason: 'write held' };
  executed = false;
  enqueued.length = 0;
  const r = await callAppTool(app, 'add_record', { name: 'x' }, 'dan', { tool: 'add_record', args: { name: 'x' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.decision, 'requires_approval');
  assert.equal(r.body.held, true);
  assert.equal(enqueued.length, 1, 'one approval enqueued');
  assert.ok(!executed, 'a held write is never executed');
  assert.equal(traced.at(-1)?.decision, 'requires_approval');
});

test('denied tool → 403, traced deny, NOT executed', async () => {
  AUTHZ_CONN = { effect: 'deny', reason: 'not exposed' };
  executed = false;
  const r = await callAppTool(app, 'secret_tool', {}, 'dan', { tool: 'secret_tool' });
  assert.equal(r.status, 403);
  assert.equal(r.body.decision, 'deny');
  assert.ok(!executed, 'a denied tool is never executed');
  assert.equal(traced.at(-1)?.decision, 'deny');
});
