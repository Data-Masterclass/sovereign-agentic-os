/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Test — personal data before Company certification, per rule and per door
 * USER STORY: As a platform admin I set the rule (block / confirm / off) and no door to Company —
 *             the Data certify route, a Governance approval, the legacy approvals API, the MCP
 *             decide_approval tool or the generic transition — lets unmasked personal data through
 *             against it; every decision is audited and recorded on the certification.
 * ARCHITECTURE: the real store, gate, effects executor, MCP governance tool and routes. The rule is
 *             published straight into the kernel holder (`core/policy/personal-data-rule.ts`) — the
 *             settings store's own publishing is tested in tabs/admin. Routes get a stand-in session
 *             (`@core/kernel/auth`); they hydrate the settings store first (`hydrated()`), and the rule
 *             is published after that, so the published rule is the one read.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let ACTING: { id: string; name: string; domains: string[]; allDomains: string[]; activeDomain: null; role: string } | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => ACTING,
    currentUser: async () => ACTING,
    requireAdmin: async () => ACTING,
  },
});

const {
  __resetStore, createDataset, buildVersion, setDocs, requestPromotion, applyApprovedPromotion,
  certify, requestCertification, applyApprovedCertification, transition, getDataset, personalDataStatus,
} = await import('@tabs/data/lib/store');
const { personalDataCheck, decidePersonalData, PersonalDataGateError } = await import('@tabs/data/lib/personal-data-gate');
const { publishPersonalDataRule, __resetPersonalDataRule, effectivePersonalDataRule } = await import('@core/policy/personal-data-rule');
const { search, __resetAudit } = await import('@core/policy/audit');
const { applyEffect } = await import('@core/policy/effects');
const { __resetApprovals, enqueue, getApproval } = await import('@core/policy/approvals');
const { governanceTools } = await import('@core/mcp/governance-tools');
const { structuredError } = await import('@core/mcp/server');
import type { Principal } from '@tabs/data/lib/store';
import type { Grant } from '@tabs/data/lib/dataset-schema';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };

beforeEach(() => {
  __resetStore();
  __resetAudit();
  __resetApprovals();
  __resetPersonalDataRule();
});

type Cols = { name: string; description: string; personalData?: boolean }[];
const PII: Cols = [
  { name: 'order_id', description: 'Key.', personalData: false },
  { name: 'email', description: 'Customer e-mail.', personalData: true },
];
const CLEAN: Cols = [
  { name: 'order_id', description: 'Key.', personalData: false },
  { name: 'amount', description: 'EUR.', personalData: false },
];
const UNCLASSIFIED: Cols = [{ name: 'order_id', description: 'Key.' }];

/** A documented, promoted (Domain) asset in sales with these columns, ready to certify. */
function asset(columns: Cols, grants?: Grant[]): string {
  const d = createDataset(amir, { name: `Orders ${Math.random().toString(36).slice(2, 7)}` });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  setDocs(d.id, amir, { description: 'Sales orders.', columns });
  const req = requestPromotion(d.id, amir, { visibility: 'domain', ...(grants ? { grants } : {}) });
  applyApprovedPromotion(req, bea);
  return d.id;
}
const maskEmail: Grant[] = [{ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: ['email'], hide: [] } }, cardinality: 'low', action: 'read' }];
const hideEmail: Grant[] = [{ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [], hide: ['email'] } }, cardinality: 'low', action: 'read' }];
const rows = () => search({ action: 'certify.personal-data' });
const isGate = (code: string) => (e: unknown) => e instanceof PersonalDataGateError && e.code === code && e.status === 409;

// ------------------------------------------------------------------ the pure check --

test('check: personal columns masked OR hidden are protected; the rest are unprotected; missing booleans are unclassified', () => {
  const d = { columns: [...PII, { name: 'phone', description: '', personalData: true }, { name: 'note', description: '' }] };
  const c = personalDataCheck(d, maskEmail);
  assert.deepEqual(c.personalColumns, ['email', 'phone']);
  assert.deepEqual(c.protectedColumns, ['email']);
  assert.deepEqual(c.unprotected, ['phone']);
  assert.deepEqual(c.unclassifiedColumns, ['note']);
  assert.equal(c.classified, false);
  assert.deepEqual(personalDataCheck({ columns: PII }, hideEmail).unprotected, []);
  assert.equal(personalDataCheck({ columns: [] }, []).classified, false, 'no documented columns is not a classification');
});

test('decide: off never throws; a confirmation with an empty reason is refused (400)', () => {
  const c = personalDataCheck({ columns: PII }, []);
  assert.deepEqual(decidePersonalData(c, 'off'), { rule: 'off', outcome: 'not-checked' });
  assert.throws(() => decidePersonalData(c, 'confirm', { confirmed: true, reason: '   ' }), (e: { status?: number; code?: string }) => e.status === 400 && e.code === 'personal_data_reason_required');
});

// ------------------------------------------------------------------ rule: block (default) --

test('block (default): unmasked personal data is refused with the columns and the fix — a confirmation does not override it', () => {
  publishPersonalDataRule('block', true);
  const id = asset(PII);
  assert.throws(() => certify(id, sara), (e: unknown) => {
    assert.ok(isGate('personal_data_unprotected')(e));
    const g = e as InstanceType<typeof PersonalDataGateError>;
    assert.match(g.message, /email/);
    assert.match(g.message, /mask or hide/);
    assert.deepEqual(g.personalData.unprotected, ['email']);
    return true;
  });
  assert.throws(() => certify(id, sara, { personalData: { confirmed: true, reason: 'we accept' } }), isGate('personal_data_unprotected'));
  assert.equal(getDataset(id, sara).tier, 'asset', 'tier unchanged');
  const refused = rows();
  assert.equal(refused.length, 2);
  assert.equal(refused[0].detail.outcome, 'refused');
  assert.deepEqual(refused[0].detail.unprotected, ['email']);
});

test('block: masked or hidden personal data passes, and the badge + audit say so', () => {
  publishPersonalDataRule('block', true);
  for (const g of [maskEmail, hideEmail]) {
    __resetAudit();
    const id = asset(PII, g);
    const p = certify(id, sara);
    assert.equal(p.tier, 'product');
    assert.deepEqual(p.certification?.personalData, { rule: 'block', outcome: 'passed' });
    assert.equal(rows()[0].detail.outcome, 'passed');
  }
});

test('block: the grants passed WITH the certify count (adding a mask at certification fixes it)', () => {
  publishPersonalDataRule('block', true);
  const id = asset(PII);
  assert.equal(certify(id, sara, { grants: maskEmail }).tier, 'product');
});

test('block: no classification → refused unless the certifier classifies or confirms with a reason', () => {
  publishPersonalDataRule('block', true);
  const id = asset(UNCLASSIFIED);
  assert.throws(() => certify(id, sara), isGate('personal_data_unclassified'));
  const p = certify(id, sara, { personalData: { confirmed: true, reason: 'Order keys only — no personal data.' } });
  assert.equal(p.certification?.personalData?.outcome, 'confirmed');
  assert.equal(p.certification?.personalData?.unclassified, true);
  assert.equal(p.certification?.personalData?.reason, 'Order keys only — no personal data.');
  assert.match(rows()[0].reason, /CONFIRMED/);
});

test('block: a fully classified dataset with no personal data passes without any confirmation', () => {
  publishPersonalDataRule('block', true);
  assert.equal(certify(asset(CLEAN), sara).certification?.personalData?.outcome, 'passed');
});

test('fail-closed: until the saved rule is read, block applies — even when the held value is off', () => {
  publishPersonalDataRule('off', false);
  assert.equal(effectivePersonalDataRule().rule, 'block');
  assert.throws(() => certify(asset(PII), sara), isGate('personal_data_unprotected'));
});

// ------------------------------------------------------------------ rule: confirm --

test('confirm: unmasked personal data needs the certifier’s confirmation + reason; it is recorded and audited', () => {
  publishPersonalDataRule('confirm', true);
  const id = asset(PII);
  assert.throws(() => certify(id, sara), isGate('personal_data_confirmation_required'));
  assert.throws(() => certify(id, sara, { personalData: { confirmed: true, reason: '' } }), (e: { code?: string }) => e.code === 'personal_data_reason_required');
  const p = certify(id, sara, { personalData: { confirmed: true, reason: 'DPO approved, ticket 42' } });
  assert.equal(p.tier, 'product');
  assert.deepEqual(p.certification?.personalData, { rule: 'confirm', outcome: 'confirmed', unprotected: ['email'], reason: 'DPO approved, ticket 42' });
  const ok = rows().find((r) => r.detail.outcome === 'confirmed')!;
  assert.equal(ok.actor, 'sara');
  assert.match(ok.reason, /DPO approved, ticket 42/);
  // The confirmation survives a reload of the record (it is in dataset.yaml).
  assert.equal(getDataset(id, sara).certification?.personalData?.reason, 'DPO approved, ticket 42');
});

test('confirm: unclassified also needs a confirmation; protected/clean passes without one', () => {
  publishPersonalDataRule('confirm', true);
  assert.throws(() => certify(asset(UNCLASSIFIED), sara), isGate('personal_data_confirmation_required'));
  assert.equal(certify(asset(PII, maskEmail), sara).certification?.personalData?.outcome, 'passed');
});

// ------------------------------------------------------------------ rule: off --

test('off: not checked — certifies and records "not-checked" in the badge and the audit', () => {
  publishPersonalDataRule('off', true);
  const p = certify(asset(PII), sara);
  assert.deepEqual(p.certification?.personalData, { rule: 'off', outcome: 'not-checked' });
  assert.equal(rows()[0].detail.outcome, 'not-checked');
});

// ------------------------------------------------------------------ the doors --

test('door: applyApprovedCertification (legacy approvals) runs the rule and carries the confirmation', () => {
  publishPersonalDataRule('confirm', true);
  const id = asset(PII);
  const req = requestCertification(id, bea);
  assert.throws(() => applyApprovedCertification(req, sara), isGate('personal_data_confirmation_required'));
  assert.equal(applyApprovedCertification(req, sara, { confirmed: true, reason: 'accepted' }).tier, 'product');
});

test('door: transition("certify") cannot skip the rule', () => {
  publishPersonalDataRule('block', true);
  const id = asset(PII);
  assert.throws(() => transition(id, sara, 'certify'), isGate('personal_data_unprotected'));
  assert.equal(getDataset(id, sara).tier, 'asset');
  const ok = transition(asset(PII, maskEmail), sara, 'certify');
  assert.equal(ok.tier, 'product');
  assert.equal(ok.certification?.personalData?.outcome, 'passed');
});

function certifyApproval(id: string) {
  const req = requestCertification(id, bea);
  return enqueue({
    kind: 'dataset_certify', title: 'Certify', detail: 'certify', agent: 'bea', domain: 'sales', requestedBy: 'bea',
    tool: 'data_certify', payload: req as unknown as Record<string, unknown>, approverRole: 'admin', scope: 'tenant',
  });
}

test('door: the approval executor (Governance inbox / MCP) refuses, then applies with the decision’s confirmation', async () => {
  publishPersonalDataRule('confirm', true);
  const id = asset(PII);
  const a = certifyApproval(id);
  await assert.rejects(applyEffect(a, sara, {}), isGate('personal_data_confirmation_required'));
  const out = await applyEffect(a, sara, {}, { personalData: { confirmed: true, reason: 'accepted by DPO' } });
  assert.equal(out.ok, true);
  assert.equal(getDataset(id, sara).certification?.personalData?.reason, 'accepted by DPO');
});

const decideTool = governanceTools.find((t) => t.name === 'decide_approval')!;
const saraUser = { id: 'sara', name: 'sara', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'admin' as const };

test('door: MCP decide_approval — typed personal_data code + hint, request stays pending; personalDataConfirmed applies it', async () => {
  publishPersonalDataRule('confirm', true);
  const id = asset(PII);
  const a = certifyApproval(id);
  let err: unknown;
  try { await decideTool.call(saraUser, { requestId: a.id, decision: 'approve' }); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  const typed = structuredError(err);
  assert.equal(typed.code, 'personal_data_confirmation_required');
  assert.match(typed.reason, /email/);
  assert.equal(getApproval(a.id)?.status, 'pending');
  await decideTool.call(saraUser, { requestId: a.id, decision: 'approve', personalDataConfirmed: true, personalDataReason: 'DPO ok' });
  assert.equal(getApproval(a.id)?.status, 'approved');
  assert.equal(getDataset(id, sara).tier, 'product');
});

test('door: MCP decide_approval under block — unprotected is refused whatever is confirmed', async () => {
  publishPersonalDataRule('block', true);
  const a = certifyApproval(asset(PII));
  let err: unknown;
  try { await decideTool.call(saraUser, { requestId: a.id, decision: 'approve', personalDataConfirmed: true, personalDataReason: 'x' }); } catch (e) { err = e; }
  assert.equal(structuredError(err).code, 'personal_data_unprotected');
  assert.match(structuredError(err).hint, /mask or hide/);
});

/** Let the settings store finish its (cached) hydration — through a route that runs it — before a
 *  test publishes the rule, so a store answer can never overwrite the rule under test. */
async function hydrated(): Promise<void> {
  ACTING = { ...saraUser };
  const probe = createDataset(sara, { name: `Probe ${Math.random().toString(36).slice(2, 7)}` });
  const route = await import(`../../../app/api/data/datasets/[id]/certify/route.ts?${Math.random()}`);
  const res = await route.GET(new Request('http://x'), { params: Promise.resolve({ id: probe.id }) });
  assert.equal(res.status, 200, 'the probe read ran (and with it the settings hydration)');
}

const post = (body: unknown) => new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('door: the Data certify route answers 409 with code + columns; GET shows the check; the confirm box path certifies', async () => {
  ACTING = { ...saraUser };
  const id = asset(PII);
  const route = await import(`../../../app/api/data/datasets/[id]/certify/route.ts?${Math.random()}`);
  const ctx = { params: Promise.resolve({ id }) };
  await route.GET(new Request('http://x'), ctx); // the route hydrates the settings store first…
  publishPersonalDataRule('confirm', true); // …so the rule published after it is the one in force
  const status = await (await route.GET(new Request('http://x'), ctx)).json();
  assert.equal(status.personalData.rule, 'confirm');
  assert.deepEqual(status.personalData.unprotected, ['email']);
  const refused = await route.POST(post({ action: 'certify' }), ctx);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, 'personal_data_confirmation_required');
  assert.deepEqual(body.personalData.unprotected, ['email']);
  const ok = await route.POST(post({ action: 'certify', personalData: { confirmed: true, reason: 'accepted' } }), ctx);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dataset.tier, 'product');
});

test('door: the Governance approvals route keeps the request pending with code + detail, then approves with the confirmation', async () => {
  ACTING = { ...saraUser };
  const id = asset(PII);
  const a = certifyApproval(id);
  const route = await import(`../../../app/api/governance/approvals/route.ts?${Math.random()}`);
  await hydrated();
  publishPersonalDataRule('confirm', true);
  const refused = await route.POST(post({ id: a.id, decision: 'approve' }));
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, 'personal_data_confirmation_required');
  assert.deepEqual(body.personalData.unprotected, ['email']);
  assert.equal(getApproval(a.id)?.status, 'pending');
  const ok = await route.POST(post({ id: a.id, decision: 'approve', personalData: { confirmed: true, reason: 'accepted' } }));
  assert.equal(ok.status, 200);
  assert.equal(getDataset(id, sara).tier, 'product');
});

test('door: the legacy approvals route runs the rule too', async () => {
  ACTING = { ...saraUser };
  const id = asset(PII);
  const a = certifyApproval(id);
  const route = await import(`../../../app/api/agent/approvals/route.ts?${Math.random()}`);
  await hydrated();
  publishPersonalDataRule('block', true);
  const refused = await route.POST(post({ id: a.id, decision: 'approve' }));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /email/);
  assert.equal(getDataset(id, sara).tier, 'asset');
});

// ------------------------------------------------------------------ the classification source --

test('a docs write without personalData keeps the saved classification (AI auto-docs, git push); an explicit value changes it', () => {
  const id = asset(PII);
  setDocs(id, amir, { columns: [{ name: 'order_id', description: 'changed' }, { name: 'email', description: 'changed' }] }, { provenance: 'ai-auto' });
  assert.deepEqual(getDataset(id, amir).columns.map((c) => c.personalData), [false, true]);
  setDocs(id, amir, { columns: [{ name: 'order_id', description: '' , personalData: false }, { name: 'email', description: '', personalData: false }] });
  assert.deepEqual(getDataset(id, amir).columns.map((c) => c.personalData), [false, false]);
  assert.equal(personalDataStatus(id, amir).check.unprotected.length, 0);
});
