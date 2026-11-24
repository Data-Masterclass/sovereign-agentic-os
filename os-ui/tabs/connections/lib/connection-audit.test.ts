/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connection audit — who acted, with whose credential, and never a secret
 * USER STORY: As an auditor I want every connection call and approval to name the OS user and the
 *             credential owner, never to carry a secret, and a held write to run exactly once.
 * ARCHITECTURE: the REAL connections store, approval queue and effect seam, offline (fetch stubbed);
 *   traces read from the in-process ring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline before importing the store (same pattern as airflow-store.test.ts).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createConnection, callConnectionTool, approveOnce, approveAndRemember, getConnectionForUser, governedTrace, __resetConnections } =
  await import('./store.ts');
const { recentTraces } = await import('@core/infra/agent-governed');
const { connectionAttribution, attributionMetadata, effectiveCredentialMode } = await import('@core/infra/connection-attribution');
const { REDACTED } = await import('@core/infra/trace-masking');
const { getApproval } = await import('@core/policy/approvals');
const { applyEffect } = await import('@core/policy/effects');
const { buildEffectDeps } = await import('@core/policy/ladder');

const owner = { id: 'olga', name: 'Olga', domains: ['ops'], role: 'builder' as const };
const colleague = { id: 'carl', name: 'Carl', domains: ['ops'], role: 'creator' as const };
const approver = { id: 'dana', name: 'Dana', domains: ['ops'], role: 'builder' as const };

const SECRET = 'hunter2-very-secret';

async function sharedAirflow() {
  const c = await createConnection(owner, {
    name: 'Ops Airflow',
    template: 'airflow',
    endpoint: 'https://airflow.example.com',
    credential: 'the-token',
    airflow: { authType: 'basic', username: 'svc', dagAllowlist: ['etl'] },
  });
  // Visible to the domain; it still runs on Olga's own credential (legacy single credential → owner).
  const live = await getConnectionForUser(c.id, owner);
  live.visibility = 'Shared';
  return live;
}

const traceById = (id: string) => recentTraces(200).find((t) => t.id === id)!;
const ownerAttr = (connectionId: string, actingUser: string) => ({ actingUser, credentialMode: 'owner', credentialSubject: 'olga', connectionId });

// ------------------------------------------------------------------ pure ---

test('pure: credential modes — legacy → owner (owner’s credential), shared → owner, per_user → the user', () => {
  assert.equal(effectiveCredentialMode({}), 'owner');
  assert.deepEqual(connectionAttribution({ id: 'c1', owner: 'olga' }, 'carl'), ownerAttr('c1', 'carl'));
  assert.deepEqual(connectionAttribution({ id: 'c1', owner: 'olga', credentialMode: 'shared' }, 'carl'), { actingUser: 'carl', credentialMode: 'shared', credentialSubject: 'olga', connectionId: 'c1' });
  assert.equal(connectionAttribution({ id: 'c1', owner: 'olga', credentialMode: 'per_user' }, 'carl').credentialSubject, 'carl');
  assert.equal(connectionAttribution({ id: 'c1', owner: 'olga', credentialMode: 'per_user' }, 'carl', { subject: 'carl@acme' }).credentialSubject, 'carl@acme');
  assert.deepEqual(attributionMetadata({ ...ownerAttr('c1', 'carl'), requestedBy: '' }), ownerAttr('c1', 'carl'), 'empty fields are left out');
});

// ------------------------------------------------------------------ the store ---

test('a Read by a colleague names the acting user and the owner’s credential (trace + result)', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const out = await callConnectionTool(c.id, colleague, { tool: 'list_dags', args: {} });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.attribution, ownerAttr(c.id, 'carl'));
  const tr = traceById(out.traceId);
  assert.equal(tr.actingUser, 'carl');
  assert.equal(tr.credentialMode, 'owner');
  assert.equal(tr.credentialSubject, 'olga');
  assert.equal(tr.connectionId, c.id);
});

test('BLOCKER: a held write keeps NO secret in clear — not in the trace, the queued approval, its card or the response', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const args = { dagId: 'etl', conf: { password: SECRET, note: `token=${SECRET}`, dsn: `postgres://svc:${SECRET}@db/x` }, value: `Bearer ${SECRET}` };
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args });
  assert.equal(held.decision, 'requires_approval');
  assert.ok(!JSON.stringify(held).includes(SECRET), 'the response (and its preview) holds no secret');
  assert.ok(!JSON.stringify(traceById(held.traceId)).includes(SECRET), 'the trace holds no secret');
  const a = getApproval(held.approvalId!)!;
  assert.ok(!JSON.stringify(a).includes(SECRET), 'the approval record (payload.preview, value, detail) holds no secret');
  assert.match(JSON.stringify(a.payload), new RegExp(REDACTED.replace(/\*/g, '\\*')));
  assert.ok((a.payload as { argsRef?: unknown }).argsRef, 'the real arguments are vaulted, referenced only');
});

test('Governance inbox approval runs the held write with the REAL (vaulted) args and names requester + approver', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', conf: { password: SECRET } } });
  const a = getApproval(held.approvalId!)!;
  const before = recentTraces(200).length;
  const r = await applyEffect(a, { id: 'dana', role: 'builder', domains: ['ops'] }, buildEffectDeps());
  const ran = recentTraces(200).slice(0, recentTraces(200).length - before).find((t) => t.tool === 'trigger_dag' && t.decision === 'allow');
  assert.ok(ran, `the write ran (applied: ${r.applied})`);
  assert.equal(ran!.requestedBy, 'carl');
  assert.equal(ran!.approvedBy, 'dana');
  assert.equal(ran!.actingUser, 'dana');
  assert.ok(!JSON.stringify(ran).includes(SECRET), 'the executed call’s trace is redacted too');
  const detail = r.audit.detail as Record<string, unknown>;
  assert.equal(detail.requestedBy, 'carl');
  assert.equal(detail.credentialSubject, 'olga');
});

test('approveOnce: requester read from the PENDING held approval matching tool + exact args; the hold is CLOSED, never run twice', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const args = { dagId: 'etl' };
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args });
  const out = await approveOnce(c.id, approver, { tool: 'trigger_dag', args, approvalId: held.approvalId });
  assert.equal(out.decision, 'allow');
  assert.equal(out.attribution?.requestedBy, 'carl');
  assert.equal(out.attribution?.approvedBy, 'dana');
  assert.equal(getApproval(held.approvalId!)!.status, 'approved', 'the inbox no longer offers it');
  // A second inline approval (or the inbox) of the same hold does not run it again.
  const again = await approveOnce(c.id, approver, { tool: 'trigger_dag', args, approvalId: held.approvalId });
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /already approved/);
});

test('approveOnce TWIN: different args or another tool’s approval attribute nothing and close nothing', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  const other = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', conf: { x: 1 } }, approvalId: held.approvalId });
  assert.equal(other.attribution?.requestedBy, undefined, 'not the call that was held');
  assert.equal(getApproval(held.approvalId!)!.status, 'pending');
  const paused = await callConnectionTool(c.id, colleague, { tool: 'pause_dag', args: { dagId: 'etl' } });
  const wrongTool = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: paused.approvalId });
  assert.equal(wrongTool.attribution?.requestedBy, undefined);
  assert.equal(getApproval(paused.approvalId!)!.status, 'pending');
});

test('approveAndRemember: requester + approver on the run and the policy trace; the hold is closed', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'unpause_dag', args: { dagId: 'etl' } });
  const { result } = await approveAndRemember(c.id, approver, { tool: 'unpause_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  assert.equal(result.decision, 'allow');
  assert.equal(result.attribution?.requestedBy, 'carl');
  assert.equal(result.attribution?.approvedBy, 'dana');
  assert.equal(getApproval(held.approvalId!)!.status, 'approved');
  const pol = recentTraces(200).find((t) => t.tool === 'generate' && (t.input as { action?: string }).action === 'approve_and_remember')!;
  assert.equal(pol.requestedBy, 'carl');
  assert.equal(pol.credentialSubject, 'olga');
  await assert.rejects(
    approveAndRemember(c.id, approver, { tool: 'unpause_dag', args: { dagId: 'etl' }, approvalId: held.approvalId }),
    /already approved/,
  );
});

test('a denied call is attributed; secret-named args and secret-shaped values are redacted', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const denied = await callConnectionTool(c.id, colleague, { tool: 'no_such_tool', args: { api_key: SECRET, q: `ghp_${'a'.repeat(30)}` } });
  assert.equal(denied.decision, 'deny');
  const tr = traceById(denied.traceId);
  assert.equal(tr.actingUser, 'carl');
  assert.ok(!JSON.stringify(tr).includes(SECRET));
  assert.ok(!JSON.stringify(tr).includes('ghp_aaaa'));
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
  assert.deepEqual(out.attribution, ownerAttr(c.id, 'carl'));
  const tr = traceById(out.traceId);
  assert.equal(tr.actingUser, 'carl');
  assert.equal((tr.input as { args: { projectKey: string } }).args.projectKey, 'OPS', 'a project key is not a secret');
});

test('a trace store failure never fails the call: it is logged and the call keeps its outcome', async () => {
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => { warned.push(m); };
  try {
    const r = await governedTrace(
      { principal: 'conn-x', tool: 'list_dags', input: {}, output: {}, decision: 'allow' },
      async () => { throw new Error('ring down'); },
    );
    assert.match(r.id, /^untraced-/);
    assert.match(warned[0], /was not written: ring down/);
  } finally {
    console.warn = realWarn;
  }
});
