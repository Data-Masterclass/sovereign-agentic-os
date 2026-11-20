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

process.env.OS_OPA_SEED = JSON.stringify({ seed_grants: { s: ['q'] }, requires_approval: ['x'], governance: { tables: {}, principals: { sales: { domains: ['sales'], clearances: ['pii'] } } } });

const { __resetOpaReconcile, registerOpaStateSource } = await import('@core/policy/opa-reconcile');
const { compileOsData, compileOsDataUsers, buildBundle, recompileOsData, osDataBundleStatus, __resetOsDataBundle } = await import('@core/policy/bundle');
const { publishOpa, readOpaData, ownedByOsDataBundle, captureOpaWrites } = await import('@core/policy/opa-publish');

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
