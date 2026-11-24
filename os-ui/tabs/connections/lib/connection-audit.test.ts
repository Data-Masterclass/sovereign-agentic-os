/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connection audit — who acted, with whose credential
 * USER STORY: As an auditor I want every connection call and approval to name the OS user and the
 *             credential owner, and never to carry a secret.
 * ARCHITECTURE: the REAL connections store, offline (fetch stubbed); traces read from the ring.
 */
/**
 * Every connection tool call says WHO it ran for (`actingUser`) and WHOSE credential it used
 * (`credentialMode: 'shared'`, `credentialSubject`: the connection owner) — on the trace the
 * Governance/Monitoring views read AND in the Langfuse span metadata. Approvals name requester
 * and approver. Secret-named args never reach a trace. Exercised over the REAL store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline before importing the store (same pattern as airflow-store.test.ts).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, callConnectionTool, approveOnce, approveAndRemember, getConnectionForUser, __resetConnections } =
  await import('./store.ts');
const { recentTraces, attributionMetadata } = await import('@core/infra/agent-governed');
const { connectionAttribution, redactSecretArgs, REDACTED } = await import('./connection-audit.ts');

const owner = { id: 'olga', name: 'Olga', domains: ['ops'], role: 'builder' as const };
const colleague = { id: 'carl', name: 'Carl', domains: ['ops'], role: 'creator' as const };
const approver = { id: 'dana', name: 'Dana', domains: ['ops'], role: 'builder' as const };

async function sharedAirflow() {
  const c = await createConnection(owner, {
    name: 'Ops Airflow',
    template: 'airflow',
    endpoint: 'https://airflow.example.com',
    credential: 'the-token',
    airflow: { authType: 'basic', username: 'svc', dagAllowlist: ['etl'] },
  });
  // One credential (Olga's), used by everyone in the domain once shared.
  const live = await getConnectionForUser(c.id, owner);
  live.visibility = 'Shared';
  return live;
}

const lastTrace = (tool: string) => recentTraces(200).find((t) => t.tool === tool);

test('pure: connectionAttribution is shared + owner; absent extras are left out', () => {
  assert.deepEqual(connectionAttribution({ owner: 'olga' }, 'carl'), { actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga' });
  assert.deepEqual(connectionAttribution({ owner: 'olga' }, 'dana', { approvedBy: 'dana', requestedBy: undefined }), {
    actingUser: 'dana', credentialMode: 'shared', credentialSubject: 'olga', approvedBy: 'dana',
  });
  // Langfuse metadata carries the set fields only.
  assert.deepEqual(attributionMetadata({ actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga' }), {
    actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga',
  });
});

test('pure: redactSecretArgs replaces secret-named values at any depth and never mutates', () => {
  const args = { dagId: 'etl', password: 'p', conf: { api_key: 'k', nested: [{ accessToken: 't' }], note: 'keep' }, Authorization: 'Bearer x' };
  const out = redactSecretArgs(args);
  assert.deepEqual(out, { dagId: 'etl', password: REDACTED, conf: { api_key: REDACTED, nested: [{ accessToken: REDACTED }], note: 'keep' }, Authorization: REDACTED });
  assert.equal(args.password, 'p', 'the caller’s args are untouched');
});

test('a Read by a colleague on the owner’s shared credential names both (trace + result)', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const out = await callConnectionTool(c.id, colleague, { tool: 'list_dags', args: {} });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.attribution, { actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga' });
  const tr = recentTraces(200).find((t) => t.id === out.traceId)!;
  assert.equal(tr.actingUser, 'carl');
  assert.equal(tr.credentialMode, 'shared');
  assert.equal(tr.credentialSubject, 'olga');
  assert.equal(tr.principal, c.principal);
});

test('a held write and a denied call are attributed too, and secret-named args are redacted', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', conf: { password: 'hunter2' } } });
  assert.equal(held.decision, 'requires_approval');
  const tr = recentTraces(200).find((t) => t.id === held.traceId)!;
  assert.equal(tr.actingUser, 'carl');
  assert.equal(tr.credentialSubject, 'olga');
  assert.ok(!JSON.stringify(tr).includes('hunter2'), 'a secret-named arg never reaches the trace');
  assert.match(JSON.stringify(tr.input), /\[redacted\]/);

  const denied = await callConnectionTool(c.id, colleague, { tool: 'no_such_tool', args: {} });
  assert.equal(denied.decision, 'deny');
  const dt = recentTraces(200).find((t) => t.id === denied.traceId)!;
  assert.equal(dt.actingUser, 'carl');
  assert.equal(dt.credentialMode, 'shared');
});

test('approveOnce records who APPROVED and who REQUESTED (requester read from the held approval)', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.ok(held.approvalId);
  const out = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.attribution, {
    actingUser: 'dana', credentialMode: 'shared', credentialSubject: 'olga', requestedBy: 'carl', approvedBy: 'dana',
  });
  const tr = recentTraces(200).find((t) => t.id === out.traceId)!;
  assert.equal(tr.requestedBy, 'carl');
  assert.equal(tr.approvedBy, 'dana');
});

test('approveOnce ignores an approval id of another connection/tool (attributes nothing it cannot prove)', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'pause_dag', args: { dagId: 'etl' } });
  const out = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  assert.equal(out.attribution?.approvedBy, 'dana');
  assert.equal(out.attribution?.requestedBy, undefined, 'the approval was for pause_dag, not trigger_dag');
});

test('approveAndRemember records requester + approver on the executed call and on its policy trace', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'unpause_dag', args: { dagId: 'etl' } });
  const { result } = await approveAndRemember(c.id, approver, { tool: 'unpause_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  assert.equal(result.decision, 'allow');
  assert.equal(result.attribution?.requestedBy, 'carl');
  assert.equal(result.attribution?.approvedBy, 'dana');
  assert.equal(result.attribution?.actingUser, 'dana');
  const pol = lastTrace('generate')!;
  assert.equal((pol.input as { action?: string }).action, 'approve_and_remember');
  assert.equal(pol.requestedBy, 'carl');
  assert.equal(pol.approvedBy, 'dana');
  assert.equal(pol.credentialSubject, 'olga');
});

test('jira-push: the Design push’s governed jira_create_issue names the pusher and the credential owner', async () => {
  __resetConnections();
  const c = await createConnection(owner, {
    name: 'Jira', template: 'atlassian', endpoint: 'https://acme.atlassian.net', credential: 'tok',
    atlassian: { authKind: 'basic', email: 'svc@acme.com' },
  });
  (await getConnectionForUser(c.id, owner)).visibility = 'Shared';
  // Exactly the call `app/api/apps/[id]/jira-push/route.ts` makes for each EPIC/story.
  const out = await callConnectionTool(c.id, colleague, {
    tool: 'jira_create_issue',
    args: { projectKey: 'OPS', issueType: 'Epic', summary: 'Checkout', description: 'd' },
    reason: 'Design push · Shop',
  });
  assert.equal(out.decision, 'requires_approval', 'a Jira write is held, never silently run');
  assert.deepEqual(out.attribution, { actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga' });
  const tr = recentTraces(200).find((t) => t.id === out.traceId)!;
  assert.equal(tr.actingUser, 'carl');
  assert.equal(tr.credentialSubject, 'olga');
});
