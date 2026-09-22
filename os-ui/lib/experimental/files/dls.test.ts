/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDls, evaluateDls, docMetaOf, canRead, type Reader } from './dls.ts';
import { emptyAsset, type FileAsset } from './asset-schema.ts';

function asset(over: Partial<FileAsset> = {}): FileAsset {
  return { ...emptyAsset({ id: 'as_x', name: 'x.pdf', owner: 'amir', domain: 'sales' }), ...over };
}
const amir: Reader = { id: 'amir', domains: ['sales'] };
const bea: Reader = { id: 'bea', domains: ['sales'] };       // amir's domain peer
const kenji: Reader = { id: 'kenji', domains: ['finance'] };  // outside the domain

test('the compiled filter is an OpenSearch bool/should with ≥1 match required', () => {
  const f = compileDls(amir);
  assert.equal(f.bool.minimum_should_match, 1);
  assert.ok(Array.isArray(f.bool.should) && f.bool.should.length >= 3, 'owner + product + domain/grant clauses');
  // it always allows the reader their own files
  assert.ok(JSON.stringify(f).includes('amir'));
});

test('owner can always read their own private file', () => {
  assert.equal(canRead(asset({ tier: 'dataset', owner: 'amir' }), amir), true);
});

test('a private file is invisible to everyone but the owner', () => {
  const priv = asset({ tier: 'dataset', owner: 'amir', domain: 'sales' });
  assert.equal(canRead(priv, bea), false);   // even a domain peer
  assert.equal(canRead(priv, kenji), false);
});

test('a domain ASSET is readable by domain peers, denied to outsiders (the gate)', () => {
  const dom = asset({ tier: 'asset', owner: 'amir', domain: 'sales', visibility: 'domain',
    grants: [{ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }] });
  assert.equal(canRead(dom, bea), true);    // a sales member finds it
  assert.equal(canRead(dom, kenji), false); // a NON-MEMBER is denied by the DLS filter
});

test('a named cross-domain individual grant is honoured', () => {
  const shared = asset({ tier: 'asset', owner: 'amir', domain: 'sales',
    grants: [{ grantee: { kind: 'user', id: 'kenji' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }] });
  assert.equal(canRead(shared, kenji), true);   // explicitly granted
  assert.equal(canRead(shared, { id: 'mara', domains: ['ops'] }), false); // others still denied
});

test('a marketplace PRODUCT is discoverable by anyone', () => {
  assert.equal(canRead(asset({ tier: 'product', owner: 'lena', domain: 'research' }), kenji), true);
});

test('the SAME compiled filter governs the live index and the in-process store', () => {
  // evaluateDls(filter, docMeta) is exactly what canRead uses, and what an
  // OpenSearch query would enforce — compile once, enforce everywhere.
  const dom = asset({ tier: 'asset', owner: 'amir', domain: 'sales',
    grants: [{ grantee: { kind: 'domain', id: 'sales' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }] });
  const filter = compileDls(kenji);
  assert.equal(evaluateDls(filter, docMetaOf(dom)), false);
  assert.equal(evaluateDls(compileDls(bea), docMetaOf(dom)), true);
});
