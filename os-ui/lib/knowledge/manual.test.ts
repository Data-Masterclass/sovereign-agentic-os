/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveManual, COMPANY_KEY, MY_KEY_PREFIX } from './manual.ts';
import {
  __resetStore,
  getManual,
  updateManual,
  listManualVersions,
  restoreManualVersion,
} from './store.ts';

const creator = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const creator2 = { id: 'nina', domains: ['sales'], role: 'creator' as const };
const builder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const dom = { id: 'dana', domains: ['sales'], role: 'domain_admin' as const };
const domFinance = { id: 'fred', domains: ['finance'], role: 'domain_admin' as const };
const admin = { id: 'sara', domains: ['sales', 'finance'], role: 'admin' as const };
const patch = (content: string) => ({ sections: [{ id: 'overview', content }] });

// ─────────────────────────────────────── resolveManual: keys + gating ───────

test('my scope keys to the user and is owner-only', () => {
  const r = resolveManual('my', creator);
  assert.equal(r.key, `${MY_KEY_PREFIX}amir`);
  assert.equal(r.canView, true);
  assert.equal(r.canEdit, true);
});

test('company scope keys to tenant; everyone reads, only admin edits', () => {
  assert.equal(resolveManual('company', creator).key, COMPANY_KEY);
  assert.equal(resolveManual('company', creator).canView, true);
  assert.equal(resolveManual('company', creator).canEdit, false);
  assert.equal(resolveManual('company', builder).canEdit, false);
  assert.equal(resolveManual('company', dom).canEdit, false);
  assert.equal(resolveManual('company', admin).canEdit, true);
});

test('domain scope: everyone in-domain reads, only domain_admin+ edits', () => {
  assert.equal(resolveManual('domain', creator).canView, true);
  assert.equal(resolveManual('domain', creator).canEdit, false);
  assert.equal(resolveManual('domain', builder).canEdit, false);
  assert.equal(resolveManual('domain', dom).canEdit, true);
  assert.equal(resolveManual('domain', admin).canEdit, true);
});

test('domain scope: a domain_admin of ANOTHER domain cannot edit', () => {
  // fred admins finance; resolving sales (his non-domain) → default is his own,
  // but if asked for sales explicitly he is not in it → falls back to finance.
  const r = resolveManual('domain', domFinance, 'sales');
  assert.equal(r.key, 'finance'); // not permitted into sales, resolves to own
  assert.equal(r.canEdit, true); // he can edit HIS OWN domain
});

// ─────────────────────────────────────── store enforcement (server-side) ────

test('My manual: owner edits + reads; another user gets their OWN card, not yours', () => {
  __resetStore();
  updateManual('my', creator, patch('my private notes'));
  assert.equal(getManual('my', creator).sections.find((s) => s.id === 'overview')?.content, 'my private notes');
  // A different user reading "my" gets THEIR own (empty) card — never amir's.
  assert.equal(getManual('my', creator2).sections.find((s) => s.id === 'overview')?.content, '');
});

test('Domain manual: creator + builder edits are rejected; domain_admin + admin succeed', () => {
  __resetStore();
  assert.throws(() => updateManual('domain', creator, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('domain', builder, patch('x')), /Not permitted/);
  updateManual('domain', dom, patch('domain manual by dana'));
  assert.equal(getManual('domain', creator).sections.find((s) => s.id === 'overview')?.content, 'domain manual by dana');
  // everyone in-domain can READ it
  assert.equal(getManual('domain', builder).sections.find((s) => s.id === 'overview')?.content, 'domain manual by dana');
  updateManual('domain', admin, patch('domain manual by admin'));
});

test('Company manual: only admin edits; everyone reads', () => {
  __resetStore();
  assert.throws(() => updateManual('company', creator, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('company', builder, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('company', dom, patch('x')), /Not permitted/);
  updateManual('company', admin, patch('company manual'));
  assert.equal(getManual('company', creator).sections.find((s) => s.id === 'overview')?.content, 'company manual');
});

test('scopes are stored independently (no cross-contamination)', () => {
  __resetStore();
  updateManual('my', creator, patch('MINE'));
  updateManual('domain', dom, patch('DOMAIN'));
  updateManual('company', admin, patch('COMPANY'));
  assert.equal(getManual('my', creator).sections.find((s) => s.id === 'overview')?.content, 'MINE');
  assert.equal(getManual('domain', creator).sections.find((s) => s.id === 'overview')?.content, 'DOMAIN');
  assert.equal(getManual('company', creator).sections.find((s) => s.id === 'overview')?.content, 'COMPANY');
});

test('version history: an edit creates a version; restore is edit-gated', () => {
  __resetStore();
  updateManual('company', admin, patch('v1'));
  updateManual('company', admin, patch('v2'));
  const versions = listManualVersions('company', admin); // newest first
  assert.ok(versions.length >= 2, 'each edit snapshotted the prior card');
  // a non-admin can VIEW company history but cannot restore
  assert.doesNotThrow(() => listManualVersions('company', creator));
  assert.throws(() => restoreManualVersion('company', creator, versions[0].version), /Not permitted/);
  // admin can restore the newest prior snapshot (the card as it was = 'v1')
  const restored = restoreManualVersion('company', admin, versions[0].version);
  assert.equal(restored.sections.find((s) => s.id === 'overview')?.content, 'v1');
});
