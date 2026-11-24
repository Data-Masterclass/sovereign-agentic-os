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
const { getApproval, decide, beginApply, endApply } = await import('@core/policy/approvals');
const { _clearStandingPolicies } = await import('@core/policy/governance');
const { deleteSecret, getSecretServerSide } = await import('@core/infra/secrets');
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
  // As the inbox route does: CLAIM, run the effect, then decide.
  assert.equal(beginApply(a.id), true);
  let r;
  try {
    r = await applyEffect(a, { id: 'dana', role: 'builder', domains: ['ops'] }, buildEffectDeps());
  } finally {
    endApply(a.id);
  }
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
  const a = getApproval(held.approvalId!)!;
  assert.equal(a.status, 'approved', 'the inbox no longer offers it');
  assert.equal(a.decidedBy, 'dana');
  // A second inline approval does not run it again (409), and the inbox cannot decide or claim it.
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409 && /already approved/.test(e.message));
  assert.equal(decide(a.id, 'approve', 'eve'), null, 'inbox decide refused');
  assert.equal(beginApply(a.id), false, 'inbox claim refused');
});

test('S2: an approvalId whose args do not match (e.g. the redacted card args echoed back) is REFUSED — nothing runs, the hold stays pending', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', conf: { password: SECRET } } });
  const redactedArgs = (getApproval(held.approvalId!)!.payload as { preview: { args: Record<string, unknown> } }).preview.args;
  const before = recentTraces(500).length;
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: redactedArgs, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  const ran = recentTraces(500).slice(0, recentTraces(500).length - before).filter((t) => t.tool === 'trigger_dag' && t.decision === 'allow');
  assert.equal(ran.length, 0, 'nothing ran');
  assert.equal(getApproval(held.approvalId!)!.status, 'pending');
  // Another tool's approval id is refused too.
  const paused = await callConnectionTool(c.id, colleague, { tool: 'pause_dag', args: { dagId: 'etl' } });
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: paused.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(getApproval(paused.approvalId!)!.status, 'pending');
});

test('B1: the inline door needs canApprove on the held item — a creator OWNER cannot close a colleague’s item; a requester never approves their own (four eyes)', async () => {
  __resetConnections();
  // Cora created the connection as a Builder and is now a Creator (demoted): still its OWNER.
  const coraBuilder = { id: 'cora', name: 'Cora', domains: ['ops'], role: 'builder' as const };
  const cora = { ...coraBuilder, role: 'creator' as const };
  const created = await createConnection(coraBuilder, {
    name: 'Cora Airflow', template: 'airflow', endpoint: 'https://airflow.example.com', credential: 't',
    airflow: { authType: 'basic', username: 'svc', dagAllowlist: ['etl'] },
  });
  (await getConnectionForUser(created.id, cora)).visibility = 'Shared';
  const held = await callConnectionTool(created.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  await assert.rejects(approveOnce(created.id, cora, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(getApproval(held.approvalId!)!.status, 'pending', 'not decided by the creator');
  // The requester themselves (even a builder) cannot approve their own held write.
  const c = await sharedAirflow();
  const own = await callConnectionTool(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: own.approvalId }), (e: Error & { status?: number }) => e.status === 403 && /four eyes/.test(e.message));
  assert.equal(getApproval(own.approvalId!)!.status, 'pending');
});

test('S1: while another door holds the apply claim (the inbox awaiting its remote write), an inline approval is refused — never a second run', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.equal(beginApply(held.approvalId!), true, 'the inbox claimed it (before running its effect)');
  try {
    await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409 && /being applied/.test(e.message));
    await assert.rejects(approveAndRemember(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  } finally {
    endApply(held.approvalId!);
  }
  assert.equal(getApproval(held.approvalId!)!.status, 'pending');
});

test('approveAndRemember: requester + approver on the run and the policy trace; the hold is closed', async () => {
  __resetConnections();
  _clearStandingPolicies();
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

test('S3: a refused approve-&-remember installs NO standing policy (the next identical call is still held)', async () => {
  __resetConnections();
  _clearStandingPolicies();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'unpause_dag', args: { dagId: 'etl' } });
  await approveOnce(c.id, approver, { tool: 'unpause_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  await assert.rejects(approveAndRemember(c.id, approver, { tool: 'unpause_dag', args: { dagId: 'etl' }, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  const again = await callConnectionTool(c.id, colleague, { tool: 'unpause_dag', args: { dagId: 'etl' } });
  assert.equal(again.decision, 'requires_approval', 'no policy was remembered by the refused call');
});

test('probe: inline approve then inbox / remember — no second run, vault cleared', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const args = { dagId: 'etl', conf: { password: SECRET } };
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args });
  const ref = (getApproval(held.approvalId!)!.payload as { argsRef: { name: string; key: string } }).argsRef;
  const out = await approveOnce(c.id, approver, { tool: 'trigger_dag', args, approvalId: held.approvalId });
  assert.equal(out.decision, 'allow');
  assert.equal(getSecretServerSide(ref), null, 'the vaulted args are dropped once decided');
  assert.equal(decide(held.approvalId!, 'approve', 'eve'), null);
  await assert.rejects(approveAndRemember(c.id, approver, { tool: 'trigger_dag', args, approvalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409);
});

test('probe: inbox approval with the vaulted args GONE → ok:false, nothing runs with redacted values', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', conf: { password: SECRET } } });
  const a = getApproval(held.approvalId!)!;
  deleteSecret((a.payload as { argsRef: { name: string; key: string } }).argsRef);
  const before = recentTraces(500).length;
  const r = await applyEffect(a, { id: 'dana', role: 'builder', domains: ['ops'] }, buildEffectDeps());
  assert.equal(r.ok, false);
  const ran = recentTraces(500).slice(0, recentTraces(500).length - before).filter((t) => t.tool === 'trigger_dag' && t.decision === 'allow');
  assert.equal(ran.length, 0, 'nothing ran');
});

test('nit: an approved hold whose write then did NOT run is recorded live:false with the reason', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  // The approver resumes it, but the executor reports failure (offline Airflow → ok:false).
  await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: held.approvalId });
  const eff = getApproval(held.approvalId!)!.effect!;
  assert.equal(eff.live, false, 'never "executed, live" when the write did not land');
  assert.match(eff.applied, /did not execute/);
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

// ---- re-verify 2: an inline approval ALWAYS answers a queued hold -------------------------------------

test('S-1: WITHOUT an approvalId the pending hold for the exact call is used — claimed, canApprove’d, closed', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', n: 1 } });
  const out = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', n: 1 } });
  assert.equal(out.attribution?.requestedBy, 'carl');
  assert.equal(getApproval(held.approvalId!)!.status, 'approved', 'the inbox can no longer run it a second time');
});

test('S-1 TWIN: the requester cannot approve their own hold by leaving out the id — once or & remember (no policy)', async () => {
  __resetConnections();
  _clearStandingPolicies();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.equal(held.decision, 'requires_approval');
  await assert.rejects(approveOnce(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } }), (e: Error & { status?: number }) => e.status === 403 && /four eyes/.test(e.message));
  await assert.rejects(approveAndRemember(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } }), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(getApproval(held.approvalId!)!.status, 'pending');
  const again = await callConnectionTool(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.equal(again.decision, 'requires_approval', 'no standing policy was installed by the refused remember');
});

test('S-1: nothing held for this exact call → the inline approval is refused (nothing to approve), nothing runs', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const before = recentTraces(500).length;
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' } }), (e: Error & { status?: number }) => e.status === 409 && /Nothing is held/.test(e.message));
  await assert.rejects(approveAndRemember(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' } }), (e: Error & { status?: number }) => e.status === 409);
  const ran = recentTraces(500).slice(0, recentTraces(500).length - before).filter((t) => t.tool === 'trigger_dag' && t.decision === 'allow');
  assert.equal(ran.length, 0);
});

test('probe 2: unknown approvalId → 404; self → 403; a claimed hold → 409 for once AND remember; released → runs', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: 'apr_nope' }), (e: Error & { status?: number }) => e.status === 404);
  const own = await callConnectionTool(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  await assert.rejects(approveOnce(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' }, approvalId: own.approvalId }), (e: Error & { status?: number }) => e.status === 403);
  const h2 = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', n: 2 } });
  assert.ok(beginApply(h2.approvalId!));
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', n: 2 }, approvalId: h2.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  await assert.rejects(approveAndRemember(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', n: 2 }, approvalId: h2.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  endApply(h2.approvalId!);
  const ok = await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', n: 2 }, approvalId: h2.approvalId });
  assert.equal(ok.decision, 'allow');
  assert.equal(getApproval(h2.approvalId!)!.status, 'approved');
});

test('the Governance door path runs only under ITS claim: an unclaimed approval id is refused, nothing runs', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  await assert.rejects(approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl' }, governanceApprovalId: held.approvalId }), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(getApproval(held.approvalId!)!.status, 'pending');
});

test('probe 3: two identical holds — an id-less approval answers the OLDEST; the other stays pending for its own approval', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const h1 = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', n: 7 } });
  const h2 = await callConnectionTool(c.id, colleague, { tool: 'trigger_dag', args: { dagId: 'etl', n: 7 } });
  assert.notEqual(h1.approvalId, h2.approvalId);
  await approveOnce(c.id, approver, { tool: 'trigger_dag', args: { dagId: 'etl', n: 7 } });
  assert.equal(getApproval(h1.approvalId!)!.status, 'approved', 'first requested, first decided');
  assert.equal(getApproval(h2.approvalId!)!.status, 'pending');
});

test('probe 3: the Governance-door path re-checks canApprove — the requester cannot run their own hold through it even under a claim', async () => {
  __resetConnections();
  const c = await sharedAirflow();
  const held = await callConnectionTool(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' } });
  assert.ok(beginApply(held.approvalId!));
  try {
    await assert.rejects(
      approveOnce(c.id, owner, { tool: 'trigger_dag', args: { dagId: 'etl' }, governanceApprovalId: held.approvalId }),
      (e: Error & { status?: number }) => e.status === 403,
    );
  } finally {
    endApply(held.approvalId!);
  }
  // And an effect applied WITHOUT a door claim is refused, nothing runs.
  const before = recentTraces(500).length;
  await assert.rejects(applyEffect(getApproval(held.approvalId!)!, { id: 'dana', role: 'builder', domains: ['ops'] }, buildEffectDeps()));
  const ran = recentTraces(500).slice(0, recentTraces(500).length - before).filter((t) => t.tool === 'trigger_dag' && t.decision === 'allow');
  assert.equal(ran.length, 0);
});
