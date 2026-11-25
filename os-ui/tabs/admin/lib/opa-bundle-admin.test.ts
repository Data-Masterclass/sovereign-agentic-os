/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Policy data: the GET/POST logic, the annotations, the history and the bell alert
 * USER STORY: As an admin I want to see exactly what a refused policy-data update removes and why each
 *             user is gone, to acknowledge only what I reviewed, with a reason kept in the audit trail,
 *             and to be alerted when a refusal lasts; as a non-admin I must get nothing.
 * ARCHITECTURE:
 *   - The handlers of tabs/admin/lib/opa-bundle-admin.ts over the REAL bundle compiler
 *     (core/policy/bundle.ts, OPA unreachable → the baseline is the last good bundle), with the
 *     directory, OPA decision and audit store injected. The route itself is thin and cannot be
 *     imported by a test; a source check pins it to these handlers.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.OPA_URL = 'http://127.0.0.1:1';
process.env.OS_OPA_SEED = JSON.stringify({ seed_grants: { s: ['q'] }, requires_approval: ['x'], governance: { tables: {}, principals: { sales: { domains: ['sales'] } } } });

const { __resetOpaReconcile, registerOpaStateSource } = await import('@core/policy/opa-reconcile');
const bundle = await import('@core/policy/bundle');
const { publishOpa } = await import('@core/policy/opa-publish');
const admin = await import('@tabs/admin/lib/opa-bundle-admin');
const view = await import('@tabs/admin/lib/policy-data-view');
type AuditEntry = import('@tabs/admin/lib/audit').AuditEntry;
type Deps = import('@tabs/admin/lib/opa-bundle-admin').BundleAdminDeps;

const ADMIN = { user: { id: 'root', role: 'admin' }, tenant: { id: 't1' } };

let grants: Record<string, string[]> = {};
function harness(over: Partial<Deps> = {}) {
  const rows: AuditEntry[] = [];
  const write = (e: Parameters<Deps['audit']>[0]) => { rows.unshift({ id: `a${rows.length}`, ts: new Date().toISOString(), result: 'ok', ...e } as AuditEntry); };
  const deps: Deps = {
    authorize: async () => ({ allowed: true, policy: 'opa-allow' }),
    status: bundle.osDataBundleStatus,
    acknowledge: bundle.acknowledgeOsDataBundle,
    recompile: bundle.recompileOsData,
    directory: async () => [
      { id: 'u1', domains: [], status: 'deactivated' },
      { id: 'u2', domains: ['sales'], disabled: true, active: false, status: 'active' },
      { id: 'u3', domains: [] },
      { id: 'u4', domains: ['sales'] },
    ],
    auditFeed: async () => rows,
    audit: write,
    auditConfirmed: async (e) => { write(e); },
    ...over,
  };
  return { deps, rows };
}

beforeEach(async () => {
  __resetOpaReconcile();
  bundle.__resetOsDataBundle();
  grants = Object.fromEntries(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'].map((u) => [`user:${u}`, ['query']]));
  registerOpaStateSource({ name: 'grants', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'grants', value: grants })).ok, detail: 'g' }) });
  assert.equal((await bundle.recompileOsData('t')).ok, true);
});

async function refuse(): Promise<string> {
  for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) delete grants[`user:${u}`]; // -50 %
  grants['user:new'] = ['query'];
  assert.equal((await bundle.recompileOsData('t')).ok, false);
  return bundle.osDataBundleStatus().refused!.hash;
}

test('annotations: deactivated / disabled / no domain / still active / unknown, read from the directory', () => {
  const dir = [
    { id: 'a', domains: ['s'], status: 'deactivated' as const },
    { id: 'b', domains: ['s'], disabled: true },
    { id: 'c', domains: [] },
    { id: 'd', domains: ['s'] },
  ];
  const diff = {
    grantPrincipals: { removed: ['user:a', 'user:b', 'user:c', 'user:d', 'user:gone', 'svc-x'], added: [], removedTotal: 6, addedTotal: 0 },
    governancePrincipals: { removed: ['a', 'sales'], added: [], removedTotal: 2, addedTotal: 0 },
    tables: { removed: [], added: [], removedTotal: 0, addedTotal: 0 },
  };
  assert.deepEqual(admin.annotateRemoved(diff, dir), {
    'user:a': 'deactivated', 'user:b': 'disabled', 'user:c': 'no-domain', 'user:d': 'active', 'user:gone': 'unknown', a: 'deactivated',
  });
  assert.deepEqual(admin.annotateRemoved(diff, null), {}, 'a directory that is not authoritative annotates nothing');
});

test('GET: the refused status names the removed and added principals, annotated, plus threshold and history', async () => {
  const h = harness();
  bundle.onOsDataBundleEvent(admin.bundleEventRecorder('t1', h.deps.audit));
  const hash = await refuse();
  const r = await admin.handleBundleGet(ADMIN, h.deps);
  assert.equal(r.status, 200);
  const b = r.body as unknown as import('@tabs/admin/lib/opa-bundle-admin').BundleView;
  assert.equal(b.refused!.hash, hash);
  assert.equal(b.maxDropPercent, 10);
  assert.deepEqual(b.refused!.diff!.grantPrincipals.removed, ['user:u1', 'user:u2', 'user:u3', 'user:u4', 'user:u5']);
  assert.deepEqual(b.refused!.diff!.grantPrincipals.added, ['user:new']);
  assert.deepEqual(b.annotations, { 'user:u1': 'deactivated', 'user:u2': 'disabled', 'user:u3': 'no-domain', 'user:u4': 'active', 'user:u5': 'unknown' });
  assert.equal(b.directoryAuthoritative, true);
  assert.equal(b.history[0].kind, 'refused', 'the refusal is in the history');
  assert.equal(b.history[0].hash, hash);
  assert.equal(b.alert, null, 'not yet past the alert threshold');
});

test('non-admin → 403 before anything is read; OPA deny → 403 and audited', async () => {
  const h = harness({ status: () => { throw new Error('must not be read'); } });
  const creator = { user: { id: 'eve', role: 'builder' }, tenant: { id: 't1' } };
  assert.equal((await admin.handleBundleGet(creator, h.deps)).status, 403);
  assert.equal((await admin.handleBundleAcknowledge(creator, { hash: 'x', reason: 'long enough reason' }, h.deps)).status, 403);
  const d = harness({ authorize: async () => ({ allowed: false, policy: 'opa-deny' }) });
  const g = await admin.handleBundleGet(ADMIN, d.deps);
  assert.equal(g.status, 403);
  assert.equal(g.body.code, 'opa-denied');
  const p = await admin.handleBundleAcknowledge(ADMIN, { hash: 'x', reason: 'long enough reason' }, d.deps);
  assert.equal(p.status, 403);
  assert.deepEqual(d.rows.map((e) => [e.action, e.result]), [['opa-bundle.denied', 'denied'], ['opa-bundle.denied', 'denied']]);
});

test('POST: a reason under the minimum is refused (400) and nothing is acknowledged', async () => {
  const h = harness();
  const hash = await refuse();
  const r = await admin.handleBundleAcknowledge(ADMIN, { hash, reason: 'too short' }, h.deps);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'reason-too-short');
  assert.equal(bundle.osDataBundleStatus().refused!.hash, hash, 'still refused');
  assert.equal(admin.MIN_REASON_LENGTH, view.MIN_REASON_LENGTH, 'the card and the server use one minimum');
});

test('POST: the hash shown, if the content changed since → 409 content-changed, nothing acknowledged', async () => {
  const h = harness();
  const shown = await refuse();
  delete grants['user:u6']; // new content, still refused
  await bundle.recompileOsData('t');
  const now = bundle.osDataBundleStatus().refused!.hash;
  assert.notEqual(now, shown);
  const r = await admin.handleBundleAcknowledge(ADMIN, { hash: shown, reason: 'cohort archived on purpose' }, h.deps);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'content-changed');
  assert.equal(r.body.current, now);
  assert.equal(h.rows.filter((e) => e.action === 'opa-bundle.acknowledged').length, 0, 'nothing audited as acknowledged');
  assert.equal((await bundle.recompileOsData('t')).ok, false, 'still refused: no acknowledgement was stored');
});

test('POST: no audit trail → 503 and NOT acknowledged', async () => {
  const h = harness({ auditConfirmed: async () => { throw new Error('the shared store (OpenSearch) is unreachable'); } });
  const hash = await refuse();
  const r = await admin.handleBundleAcknowledge(ADMIN, { hash, reason: 'cohort archived on purpose' }, h.deps);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'audit-unavailable');
  assert.equal((await bundle.recompileOsData('t')).ok, false, 'still refused');
});

test('POST: the exact hash with a reason → audited first, acknowledged once, recompiled, history shows it', async () => {
  const h = harness();
  bundle.onOsDataBundleEvent(admin.bundleEventRecorder('t1', h.deps.audit));
  const hash = await refuse();
  const r = await admin.handleBundleAcknowledge(ADMIN, { hash, reason: 'cohort archived on purpose' }, h.deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.compiled, true);
  assert.equal(bundle.osDataBundleStatus().refused, null);
  const ack = h.rows.find((e) => e.action === 'opa-bundle.acknowledged')!;
  assert.equal(ack.actor, 'root');
  assert.equal(ack.data!.hash, hash);
  assert.equal(ack.data!.reason, 'cohort archived on purpose');
  assert.deepEqual(ack.data!.removed, { grantPrincipals: 5, governancePrincipals: 0, tables: 0 });
  const hist = (await admin.handleBundleGet(ADMIN, h.deps)).body.history as import('@tabs/admin/lib/opa-bundle-admin').HistoryRow[];
  assert.deepEqual(hist.map((x) => x.kind), ['recovered', 'acknowledged', 'ack-requested', 'refused']);
  assert.equal(hist[1].reason, 'cohort archived on purpose');
  // One-shot: a second POST of the same hash finds nothing refused.
  const again = await admin.handleBundleAcknowledge(ADMIN, { hash, reason: 'cohort archived on purpose' }, h.deps);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'not-refused');
});

test('POST: content changes DURING the audit write → 409, the trail says requested + failed, never acknowledged', async () => {
  let h: ReturnType<typeof harness>;
  h = harness({
    auditConfirmed: async (e) => {
      h.deps.audit(e);
      delete grants['user:u6']; // a resync lands while the row is being written: other content is refused now
      await bundle.recompileOsData('resync');
    },
  });
  const hash = await refuse();
  const r = await admin.handleBundleAcknowledge(ADMIN, { hash, reason: 'cohort archived on purpose' }, h.deps);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'content-changed');
  const actions = h.rows.map((e) => e.action).reverse();
  assert.deepEqual(actions, ['opa-bundle.ack-requested', 'opa-bundle.ack-failed']);
  assert.equal(h.rows.some((e) => e.action === 'opa-bundle.acknowledged'), false, 'no row claims an acknowledgement');
  assert.equal(h.rows[0].result, 'error');
  assert.equal(h.rows[0].data!.hash, hash);
});

test('history: one "refused" row per incident, changed content at most every interval, skipped ones counted', async () => {
  const rows: { action: string; detail: string; data?: Record<string, unknown> }[] = [];
  let t = 0;
  const rec = admin.bundleEventRecorder('t1', (e) => rows.push(e), { changeIntervalMs: 10 * 60_000, now: () => t });
  const refusal = (hash: string, since: string) => ({ kind: 'refused' as const, refusal: { hash, stats: { grants: 1, principals: 1, tables: 0 }, baseStats: null, reasons: ['x'], at: since, since, maxDropPercent: 10, diff: null } });
  rec(refusal('h1', 'S1'));
  for (let i = 2; i <= 30; i++) { t += 60_000; rec(refusal(`h${i}`, 'S1')); } // a new hash every minute for 29 min
  rec({ kind: 'recovered', revision: '9-x', refusedSince: 'S1', refusedHash: 'h30', acknowledged: false });
  rec(refusal('k1', 'S2')); // a new incident
  assert.deepEqual(rows.map((r) => r.action), [
    'opa-bundle.refused', 'opa-bundle.refusal-changed', 'opa-bundle.refusal-changed', 'opa-bundle.recovered', 'opa-bundle.refused',
  ]);
  assert.equal(rows[1].data!.skipped, 9);
  assert.match(rows[3].detail, /refused content\(s\) not recorded separately/);
});

test('bell: raised to every admin once after the threshold, marked read when a compile passes', async () => {
  await refuse();
  const since = Date.parse(bundle.osDataBundleStatus().refused!.since);
  const sent: { userId: string; title: string; body: string }[] = [];
  const read: string[] = [];
  const deps = (nowMs: number) => ({
    status: bundle.osDataBundleStatus,
    admins: async () => ['root', 'ops'],
    notify: (n: { userId: string; title: string; body: string }) => { sent.push(n); return { id: `n-${n.userId}` }; },
    markRead: (_u: string, ids: string[]) => { read.push(...ids); },
    nowMs,
  });
  let inc = await admin.evaluateRefusalBell(null, deps(since + 5 * 60_000));
  assert.equal(inc, null);
  assert.equal(sent.length, 0, 'not before the threshold');
  inc = await admin.evaluateRefusalBell(inc, deps(since + 16 * 60_000));
  assert.deepEqual(sent.map((n) => n.userId), ['root', 'ops']);
  assert.match(sent[0].title, /Policy data update refused/);
  assert.match(sent[0].body, /Platform → Policy data/);
  inc = await admin.evaluateRefusalBell(inc, deps(since + 30 * 60_000));
  assert.equal(sent.length, 2, 'once per incident');
  const hash = bundle.osDataBundleStatus().refused!.hash;
  bundle.acknowledgeOsDataBundle(hash, 'root', 'cohort archived on purpose');
  assert.equal((await bundle.recompileOsData('t')).ok, true);
  inc = await admin.evaluateRefusalBell(inc, deps(since + 31 * 60_000));
  assert.equal(inc, null);
  assert.deepEqual(read.sort(), ['n-ops', 'n-root'], 'cleared when the compile passed');
});

test('bell: no admin found → nothing raised, and it tries again', async () => {
  await refuse();
  const since = Date.parse(bundle.osDataBundleStatus().refused!.since);
  const inc = await admin.evaluateRefusalBell(null, { status: bundle.osDataBundleStatus, admins: async () => [], notify: () => ({ id: 'x' }), markRead: () => {}, nowMs: since + 20 * 60_000 });
  assert.equal(inc, null);
});

test('route: thin, admin-gated, uses these handlers, confirmed audit, no personal data in its log lines', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/platform-admin/opa-bundle/route.ts'), 'utf8');
  assert.match(src, /requireAdmin\(\)/);
  assert.match(src, /handleBundleGet/);
  assert.match(src, /handleBundleAcknowledge/);
  assert.match(src, /auditConfirmed/);
  assert.doesNotMatch(src, /console\./);
});
