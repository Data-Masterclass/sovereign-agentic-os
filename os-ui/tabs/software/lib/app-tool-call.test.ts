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

mock.module('@core/infra/agent-governed', {
  namedExports: {
    authorizeConnectionCall: () => AUTHZ_CONN,
    authorizeAppTool: async () => ({ effect: 'allow', policy: 'app-grant', reason: 'grant' }),
    // The app's compiled capability profile exposes both declared actions (layer 1).
    exposedConnectionTools: () => ['list_invoices', 'approve_invoice'],
    trace: async (e: { decision: string }) => {
      traced.push(e);
      return { id: `tr_${traced.length}` };
    },
  },
});
mock.module('@core/policy/approvals', {
  namedExports: {
    enqueue: (x: unknown) => {
      enqueued.push(x);
    },
  },
});
// The committed tree the declared-action gate reads `actions.yml` from (review H-2).
let TREE: { path: string; content: string }[] = [];
mock.module('./snapshot.ts', {
  namedExports: {
    getSnapshot: () => TREE,
    hydrateSnapshot: async () => TREE,
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
  // Layer 4 (grant): both declared actions are granted to this run.
  mcpTools: [
    { name: 'list_invoices', description: '', write: false },
    { name: 'approve_invoice', description: '', write: true },
  ],
} as unknown as Parameters<typeof callAppTool>[0];

const ACTIONS_YML = {
  path: 'actions.yml',
  content:
    'actions:\n  - name: list_invoices\n    scopes: [records]\n  - name: approve_invoice\n    write: true\n    scopes: [records]\n',
};

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


// ───────────────── DECLARED ACTIONS: the four-layer intersection, ENFORCED (review H-2) ──────

test('a DECLARED action with NO adoption port is DENIED at the adoption layer — fail-closed', async () => {
  TREE = [ACTIONS_YML];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' }; // the LEGACY path would have allowed it
  executed = false;
  const r = await callAppTool(app, 'list_invoices', {}, 'dan', { tool: 'list_invoices' });
  assert.equal(r.status, 403, 'the declared-action gate runs BEFORE the adoption-free legacy path');
  assert.equal(r.body.decision, 'deny');
  assert.equal(r.body.layer, 'adoption');
  assert.match(String(r.body.reason), /domain administrator must adopt/);
  assert.ok(!executed, 'never executed');
  assert.equal(traced.at(-1)?.decision, 'deny');
  TREE = [];
});

test('a DECLARED read action WITH the domain’s adoption is allowed and executes', async () => {
  TREE = [ACTIONS_YML];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' };
  executed = false;
  const asked: string[] = [];
  const adoption = {
    adopted: (exposure: string, domain: string, action: string) => {
      asked.push(`${exposure}|${domain}|${action}`);
      return true;
    },
  };
  const r = await callAppTool(app, 'list_invoices', {}, 'dan', { tool: 'list_invoices' }, undefined, adoption);
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, 'allow');
  assert.ok(executed);
  assert.deepEqual(asked, ['app:app_1|eng|list_invoices'], 'the port is asked with exposure + domain + action');
  TREE = [];
});

test('a DECLARED WRITE action is HELD even when adopted — the read-only preset is not bypassed', async () => {
  TREE = [ACTIONS_YML];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' }; // the legacy path would have ALLOWED this write
  executed = false;
  enqueued.length = 0;
  const r = await callAppTool(app, 'approve_invoice', { id: 'i1' }, 'dan', { tool: 'approve_invoice' }, undefined, { adopted: () => true });
  assert.equal(r.status, 202);
  assert.equal(r.body.decision, 'requires_approval');
  assert.equal(r.body.held, true);
  assert.equal(enqueued.length, 1);
  assert.ok(!executed, 'a declared write is never auto-executed');
  TREE = [];
});

test('a DECLARED action the app’s grant does not include is denied at the grant layer', async () => {
  TREE = [ACTIONS_YML];
  const ungranted = { ...(app as object), mcpTools: [] } as unknown as Parameters<typeof callAppTool>[0];
  const r = await callAppTool(ungranted, 'list_invoices', {}, 'dan', { tool: 'list_invoices' }, undefined, { adopted: () => true });
  assert.equal(r.status, 403);
  assert.equal(r.body.layer, 'grant');
  TREE = [];
});

test('an UNDECLARED tool keeps EXACTLY its previous behaviour — the gate arrives with its surface', async () => {
  TREE = [ACTIONS_YML];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' };
  executed = false;
  const r = await callAppTool(app, 'list_records', {}, 'dan', { tool: 'list_records' });
  assert.equal(r.status, 200, 'the legacy auto-MCP surface is untouched — no app regresses overnight');
  assert.ok(executed);
  TREE = [];
});

// ---- AGENT_FORBIDDEN_TOOLS at the app door (the deferred guard, 2026-11-19) -----------------
//
// This door executes an APP's own tools, so the OS's `decide_deploy` / `promote` /
// `reindex_corpus` are not behind it. What IS reachable (POST /api/apps/<id>/tool takes any tool
// string from any signed-in user who can see the app): an `actions.yml` declaring an action with
// one of those NAMES. A write action is held, so it would file "Approval needed: promote" into the
// same Governance inbox, under an app principal — reading exactly like the platform approval while
// doing something else. The name is refused before any authorization, declared or not.

test('a tool NAMED like an agent-forbidden OS write is refused at the app door — never held, never executed', async () => {
  for (const name of ['promote', 'decide_deploy', 'reindex_corpus', 'decide_approval', 'promote_connection']) {
    // The worst case on purpose: declared as a WRITE action, exposed, adopted and granted — every
    // one of the four layers would pass, and without the guard this is a 202 hold in the inbox.
    TREE = [{ path: 'actions.yml', content: `actions:\n  - name: ${name}\n    write: true\n    scopes: [records]\n` }];
    AUTHZ_CONN = { effect: 'allow', reason: 'read' };
    enqueued.length = 0;
    traced.length = 0;
    executed = false;
    const granted = { ...app, mcpTools: [{ name, description: '', write: true }] } as typeof app;
    const r = await callAppTool(granted, name, { id: 'x' }, 'dan', { tool: name }, undefined, { adopted: () => true });
    assert.equal(r.status, 403, `${name} must be refused`);
    assert.equal(r.body.decision, 'deny');
    assert.equal(r.body.layer, 'agent-forbidden');
    assert.match(String(r.body.reason), /cannot be called through an app/);
    // The name is in the app's GRANT (`mcpTools`) and `parseAppActions` dropped the action, so the
    // only way it can be a tool is an OpenAPI operationId — and the message says to fix THAT.
    assert.match(String(r.body.reason), /reserved name/);
    assert.match(String(r.body.reason), /rename the operationId in the app's OpenAPI spec/);
    assert.equal(enqueued.length, 0, 'not held: a hold could be approved and would then read as the real thing');
    assert.equal(executed, false);
    assert.deepEqual(traced.map((t) => t.decision), ['deny'], 'the refusal is traced');
  }
  TREE = [];
});

test('the guard is by exact name: an app action that merely CONTAINS a forbidden name is untouched', async () => {
  TREE = [{ path: 'actions.yml', content: 'actions:\n  - name: promote_lead\n    scopes: [records]\n' }];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' };
  executed = false;
  const granted = { ...app, mcpTools: [{ name: 'promote_lead', description: '', write: false }] } as typeof app;
  // `exposedConnectionTools` (layer 1) does not list it, so the declared-action gate answers for
  // itself — at the CAPABILITY layer, not the forbidden one.
  const r = await callAppTool(granted, 'promote_lead', {}, 'dan', { tool: 'promote_lead' }, undefined, { adopted: () => true });
  assert.notEqual(r.body.layer, 'agent-forbidden');
  TREE = [];
});

test('a reserved name with NO grant behind it: the message names both places it could have come from', async () => {
  TREE = [];
  traced.length = 0;
  const r = await callAppTool(app, 'promote', {}, 'dan', { tool: 'promote' });
  assert.equal(r.status, 403);
  assert.equal(r.body.layer, 'agent-forbidden');
  assert.match(String(r.body.reason), /the action in actions\.yml, or the operationId in the app's OpenAPI spec/);
});

test('prototype names are NOT reserved: `constructor` falls through to the ordinary gate', async () => {
  // Review L1: a bare table lookup made `constructor` / `toString` / `__proto__` look forbidden.
  TREE = [];
  AUTHZ_CONN = { effect: 'allow', reason: 'read' };
  for (const name of ['constructor', 'toString', '__proto__']) {
    const r = await callAppTool(app, name, {}, 'dan', { tool: name });
    assert.notEqual(r.body.layer, 'agent-forbidden', `${name} must not be treated as a reserved name`);
  }
});
