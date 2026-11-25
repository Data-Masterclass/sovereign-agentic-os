/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Unit contracts of the os-data bundle compiler.
 * USER STORY: As an operator I want a partial or empty compile to be refused and the bytes to be deterministic, proven fast in CI.
 * ARCHITECTURE:
 * Unit contracts of the os-data bundle compiler (the real-OPA proofs are tests/opa/bundle*.int.test.ts):
 * capture semantics, complete-or-nothing, never-zero, roots only, deterministic bytes, the
 * attribute allow-list, and bundle mode never sending a bundled PUT.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

process.env.OPA_URL = 'http://127.0.0.1:1'; // no OPA: the baseline is the last good bundle
process.env.OS_OPA_SEED = JSON.stringify({ seed_grants: { s: ['q'] }, requires_approval: ['x'], governance: { tables: {}, principals: { sales: { domains: ['sales'], clearances: ['pii'] } } } });

const { __resetOpaReconcile, registerOpaStateSource } = await import('@core/policy/opa-reconcile');
const { compileOsData, compileOsDataUsers, buildBundle, recompileOsData, osDataBundleStatus, __resetOsDataBundle, acknowledgeOsDataBundle, olderThanActive, onOsDataBundleEvent } = await import('@core/policy/bundle');
const { guardReasons, revisionSeq, diffStats, statsOf, DIFF_LIST_LIMIT } = await import('@core/policy/bundle-guards');
const { refusalAlert } = await import('@core/policy/bundle-alert');
type BundleEvent = import('@core/policy/bundle').OsDataBundleEvent;
const { publishOpa, readOpaData, ownedByOsDataBundle } = await import('@core/policy/opa-publish');
const { captureOpaWrites } = await import('@core/policy/opa-capture');

beforeEach(() => {
  __resetOpaReconcile();
  __resetOsDataBundle();
});

const grantsSource = (doc: Record<string, string[]>) => ({
  name: 'grants', bundled: true,
  restore: async () => {
    const r = await publishOpa({ kind: 'data', path: 'grants', value: doc });
    return { ok: r.ok, detail: 'g' };
  },
});

test('capture: PUT/DELETE/GET act on the tree with OPA path semantics (encoded segments)', async () => {
  const { tree } = await captureOpaWrites({ governance: { tables: {} } }, async () => {
    await publishOpa({ kind: 'data', path: `governance/tables/${encodeURIComponent('iceberg.s.t')}`, value: { domain: 's' } });
    await publishOpa({ kind: 'data', path: 'governance/principals/u1', value: { domains: ['s'] } });
    await publishOpa({ kind: 'delete', path: 'governance/principals/u1' });
    assert.deepEqual(await readOpaData('governance/tables/iceberg.s.t'), { reachable: true, defined: true, value: { domain: 's' } });
    assert.equal((await readOpaData('nope/x')).defined, false);
    const pol = await publishOpa({ kind: 'policy', id: 'k', rego: 'package k' });
    assert.equal(pol.ok, false, 'no policy modules in a data bundle');
  });
  assert.deepEqual(tree, { governance: { tables: { 'iceberg.s.t': { domain: 's' } }, principals: {} } });
});

test('complete or nothing: one failing source rejects the compile and keeps the last good bundle', async () => {
  registerOpaStateSource(grantsSource({ 'user:a': ['query'] }));
  const first = await recompileOsData('t');
  assert.equal(first.ok, true);
  const rev = osDataBundleStatus().revision;
  registerOpaStateSource({ name: 'governance', bundled: true, restore: async () => ({ ok: false, detail: 'dataset registry not hydrated yet (pending)' }) });
  const second = await recompileOsData('t');
  assert.equal(second.ok, false);
  assert.match(second.ok ? '' : second.detail, /governance: dataset registry not hydrated/);
  assert.equal(osDataBundleStatus().revision, rev, 'last good revision kept');
});

test('never zero: an empty grants document is refused', async () => {
  registerOpaStateSource(grantsSource({}));
  const r = await compileOsData();
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, /grants document is empty/);
});

test('roots only, deterministic: same content → same revision and bytes', async () => {
  registerOpaStateSource(grantsSource({ 'user:a': ['query'] }));
  const a = await compileOsData();
  const b = await compileOsData();
  assert.ok(a.ok && b.ok);
  assert.equal(a.bundle.revision, b.bundle.revision);
  assert.ok(a.bundle.bytes.equals(b.bundle.bytes));
  const tar = gunzipSync(a.bundle.bytes).toString('latin1');
  assert.ok(tar.includes('.manifest') && tar.includes('"roots":["grants","seed_grants"'));
  registerOpaStateSource({ name: 'stray', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'os_state/x', value: 1 })).ok, detail: '' }) });
  const c = await compileOsData();
  assert.equal(c.ok, false, 'a document outside the roots is an error, never silently dropped');
});

test('os_data.users: only allow-listed attributes pass (10 F7)', () => {
  const u = compileOsDataUsers([{ id: 'v', domains: ['sales'], role: 'creator', attrs: { region: 'DE', ssn: '123' } }], ['region']);
  assert.deepEqual(u.v, { domains: { sales: 'creator' }, tenant_role: 'creator', active: true, attrs: { region: 'DE' } });
});

test('bundle mode: a bundled PUT is not sent (202), a document outside the roots is', async () => {
  assert.equal(ownedByOsDataBundle('governance/tables/x'), true);
  assert.equal(ownedByOsDataBundle('governance/releases/x'), false);
  assert.equal(ownedByOsDataBundle('os_state/reconciled'), false);
  process.env.OS_OPA_DATA_BUNDLE = '1';
  process.env.OPA_URL = 'http://127.0.0.1:1'; // nothing listens: a real PUT would fail
  try {
    const r = await publishOpa({ kind: 'data', path: 'grants/u', value: ['q'] });
    assert.equal(r.status, 202);
  } finally {
    process.env.OS_OPA_DATA_BUNDLE = '';
  }
});

test('buildBundle: an explicit revision (grant_rev) is the manifest revision and the ETag', () => {
  const b = buildBundle('os-grants', { os_grants: { run_grants: {} } }, ['os_grants'], '42');
  assert.equal(b.etag, '"42"');
  assert.ok(gunzipSync(b.bytes).toString('latin1').includes('"revision":"42"'));
});

// ---------------------------------------------------------------- guards (WP-11 review) --

const users = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`user:u${i}`, ['query']]));
const tablesSource = (fqns: string[]) => ({
  name: 'governance', bundled: true,
  restore: async () => {
    for (const f of fqns) await publishOpa({ kind: 'data', path: `governance/tables/${encodeURIComponent(f)}`, value: { domain: 'sales' } });
    return { ok: true, detail: 't' };
  },
});

test('guard: empty → refused (no baseline needed)', () => {
  assert.match(guardReasons({ grants: 0, principals: 3, tables: [] }, null, 10).join(), /grants document is empty/);
  assert.match(guardReasons({ grants: 3, principals: 0, tables: [] }, null, 10).join(), /principals are empty/);
});

test('guard: a large drop is refused; at or under the bound passes', () => {
  const base = { grants: 100, principals: 100, tables: ['iceberg.s.a'] };
  assert.match(guardReasons({ ...base, grants: 89 }, base, 10).join(), /grant principals drop 11\.0 %/);
  assert.deepEqual(guardReasons({ ...base, grants: 90 }, base, 10), []);
  assert.match(guardReasons({ ...base, principals: 50 }, base, 10).join(), /governance principals drop/);
});

test('guard: fewer tables, or a missing internal table at the same count, is refused', () => {
  const base = { grants: 5, principals: 5, tables: ['iceberg.s.a', 'iceberg.s.b'] };
  assert.match(guardReasons({ ...base, tables: ['iceberg.s.a'] }, base, 10).join(), /fewer governance tables/);
  const swapped = guardReasons({ ...base, tables: ['iceberg.s.a', 'iceberg.s.c'] }, base, 10).join();
  assert.match(swapped, /internal table\(s\) missing from governance: iceberg\.s\.b/);
  assert.deepEqual(guardReasons({ ...base, tables: ['iceberg.s.a', 'iceberg.s.b', 'ext.x.y'] }, base, 10), [], 'growth passes');
});

test('recompile: a large drop is refused and the last good bundle kept, until an admin acknowledges that exact content', async () => {
  let n = 40;
  registerOpaStateSource({ name: 'grants', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'grants', value: users(n) })).ok, detail: 'g' }) });
  assert.equal((await recompileOsData('t')).ok, true);
  const good = osDataBundleStatus().revision!;
  n = 30; // -25 %
  const r = await recompileOsData('t');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, /grant principals drop 25\.0 %/);
  assert.equal(osDataBundleStatus().revision, good, 'last good kept');
  const refused = osDataBundleStatus().refused!;
  assert.equal(acknowledgeOsDataBundle('0000', 'admin', 'x').ok, false, 'only the refused content can be acknowledged');
  assert.equal(acknowledgeOsDataBundle(refused.hash, 'admin', 'cohort archived').ok, true);
  const after = await recompileOsData('t');
  assert.equal(after.ok, true, 'acknowledged content passes once');
  assert.ok(revisionSeq(after.ok ? after.bundle.revision : '')! > revisionSeq(good)!, 'sequence increases');
  n = 20;
  assert.equal((await recompileOsData('t')).ok, false, 'the acknowledgement was one-shot');
});

test('recompile: a missing internal table at the same count is refused', async () => {
  registerOpaStateSource(grantsSource({ 'user:a': ['query'] }));
  let fqns = ['iceberg.s.a', 'iceberg.s.b'];
  registerOpaStateSource({ ...tablesSource([]), restore: async () => tablesSource(fqns).restore() });
  assert.equal((await recompileOsData('t')).ok, true);
  fqns = ['iceberg.s.a', 'iceberg.s.c'];
  const r = await recompileOsData('t');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail, /internal table\(s\) missing.*iceberg\.s\.b/);
});

test('older: a bundle with a lower sequence than OPA\'s active one is never served; same content is a 304', () => {
  const b = buildBundle('os-data', { grants: { 'user:a': ['q'] } }, ['grants'], '3-abc');
  Object.assign(b, { seq: 3, hash: 'abc' });
  assert.equal(olderThanActive(b, '"7-def"'), true, 'older than active');
  assert.equal(olderThanActive(b, '"7-abc"'), false, 'same content: not served as older, answered 304');
  assert.equal(olderThanActive(b, '"2-def"'), false, 'newer than active');
  assert.equal(olderThanActive(b, null), false, 'first download');
});

// ---------------------------------------------------------------- refusal detail (Policy data card) --

test('diffStats: names exactly the removed and added ids per category, bounded, with exact totals', () => {
  const base = statsOf({ grants: { 'user:a': [], 'user:b': [], 'user:c': [] }, governance: { principals: { a: {}, b: {} }, tables: { 'iceberg.s.x': {}, 'iceberg.s.y': {} } } });
  const next = statsOf({ grants: { 'user:a': [], 'user:d': [] }, governance: { principals: { a: {} }, tables: { 'iceberg.s.x': {}, 'iceberg.s.z': {} } } });
  const d = diffStats(next, base)!;
  assert.deepEqual(d.grantPrincipals, { removed: ['user:b', 'user:c'], added: ['user:d'], removedTotal: 2, addedTotal: 1 });
  assert.deepEqual(d.governancePrincipals, { removed: ['b'], added: [], removedTotal: 1, addedTotal: 0 });
  assert.deepEqual(d.tables, { removed: ['iceberg.s.y'], added: ['iceberg.s.z'], removedTotal: 1, addedTotal: 1 });
  const many = statsOf({ grants: users(DIFF_LIST_LIMIT + 50), governance: { principals: { a: {} }, tables: {} } });
  const few = statsOf({ grants: users(10), governance: { principals: { a: {} }, tables: {} } });
  const big = diffStats(few, many)!;
  assert.equal(big.grantPrincipals.removed.length, DIFF_LIST_LIMIT, 'the list is bounded');
  assert.equal(big.grantPrincipals.removedTotal, DIFF_LIST_LIMIT + 40, 'the total stays exact');
  assert.equal(diffStats(next, null), null, 'no baseline → no list');
  assert.equal(diffStats(next, { grants: 3, principals: 2, tables: [] }), null, 'a baseline with counts only → no list');
});

test('refusal: carries the removed list, the threshold and an incident start that survives repeated refusals', async () => {
  let n = 40;
  registerOpaStateSource({ name: 'grants', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'grants', value: users(n) })).ok, detail: 'g' }) });
  assert.equal((await recompileOsData('t')).ok, true);
  n = 30;
  await recompileOsData('t');
  const first = osDataBundleStatus().refused!;
  assert.equal(first.maxDropPercent, 10);
  assert.deepEqual(first.stats, { grants: 30, principals: 1, tables: 0 });
  assert.deepEqual(first.baseStats, { grants: 40, principals: 1, tables: 0 });
  assert.equal(first.diff!.grantPrincipals.removedTotal, 10);
  assert.ok(first.diff!.grantPrincipals.removed.includes('user:u39'));
  assert.equal(first.diff!.grantPrincipals.removed.includes('user:u0'), false);
  await new Promise((r) => setTimeout(r, 5));
  n = 29; // other content, still refused: the same incident
  await recompileOsData('t');
  const second = osDataBundleStatus().refused!;
  assert.notEqual(second.hash, first.hash);
  assert.equal(second.since, first.since, 'the incident started at the first refusal');
  assert.ok(second.at > first.at);
  const st = osDataBundleStatus();
  assert.equal(typeof st.checkedAt, 'string');
  assert.equal(st.refusalAlertMinutes, 15);
});

test('events: a NEW refusal and its end are emitted once each; a repeated refusal of the same content is not', async () => {
  const seen: BundleEvent[] = [];
  onOsDataBundleEvent((e) => seen.push(e));
  let n = 40;
  registerOpaStateSource({ name: 'grants', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'grants', value: users(n) })).ok, detail: 'g' }) });
  await recompileOsData('t');
  n = 30;
  await recompileOsData('t');
  await recompileOsData('t'); // same content refused again
  assert.deepEqual(seen.map((e) => e.kind), ['refused']);
  const hash = osDataBundleStatus().refused!.hash;
  acknowledgeOsDataBundle(hash, 'admin', 'cohort archived');
  await recompileOsData('t');
  assert.deepEqual(seen.map((e) => e.kind), ['refused', 'recovered']);
  const rec = seen[1] as Extract<BundleEvent, { kind: 'recovered' }>;
  assert.equal(rec.acknowledged, true);
  assert.equal(rec.refusedHash, hash);
  assert.equal(osDataBundleStatus().refused, null);
});

test('events: a throwing listener never breaks the compile', async () => {
  onOsDataBundleEvent(() => { throw new Error('boom'); });
  let n = 40;
  registerOpaStateSource({ name: 'grants', bundled: true, restore: async () => ({ ok: (await publishOpa({ kind: 'data', path: 'grants', value: users(n) })).ok, detail: 'g' }) });
  await recompileOsData('t');
  n = 30;
  const r = await recompileOsData('t');
  assert.equal(r.ok, false);
  assert.ok(osDataBundleStatus().refused);
});

test('alert: a refusal is raised only after refusalAlertMinutes, and is gone without a refusal', () => {
  const since = '2026-11-25T10:00:00.000Z';
  const refused = { hash: 'abc', stats: { grants: 1, principals: 1, tables: 0 }, baseStats: null, reasons: ['grant principals drop 50.0 % (2 → 1), above 10 %'], at: since, since, maxDropPercent: 10, diff: null };
  const st = { refused, revision: '7-def', refusalAlertMinutes: 15 };
  const t0 = Date.parse(since);
  assert.equal(refusalAlert(st, t0 + 14 * 60_000), null);
  const a = refusalAlert(st, t0 + 16 * 60_000)!;
  assert.match(a.detail, /revision 7-def for 16 min/);
  assert.match(a.detail, /content abc/);
  assert.equal(refusalAlert({ ...st, refused: null }, t0 + 60 * 60_000), null);
});
