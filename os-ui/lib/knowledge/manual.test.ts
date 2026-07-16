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
import { reconcileSections, DOMAIN_SECTION_IDS } from './schema.ts';

const creator = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const creator2 = { id: 'nina', domains: ['sales'], role: 'creator' as const };
const builder = { id: 'bea', domains: ['sales'], role: 'builder' as const };
const dom = { id: 'dana', domains: ['sales'], role: 'domain_admin' as const };
const domFinance = { id: 'fred', domains: ['finance'], role: 'domain_admin' as const };
const admin = { id: 'sara', domains: ['sales', 'finance'], role: 'admin' as const };
const patch = (content: string) => ({ sections: [{ id: 'general', content }] });

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
  assert.equal(getManual('my', creator).sections.find((s) => s.id === 'general')?.content, 'my private notes');
  // A different user reading "my" gets THEIR own (empty) card — never amir's.
  assert.equal(getManual('my', creator2).sections.find((s) => s.id === 'general')?.content, '');
});

test('Domain manual: creator + builder edits are rejected; domain_admin + admin succeed', () => {
  __resetStore();
  assert.throws(() => updateManual('domain', creator, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('domain', builder, patch('x')), /Not permitted/);
  updateManual('domain', dom, patch('domain manual by dana'));
  assert.equal(getManual('domain', creator).sections.find((s) => s.id === 'general')?.content, 'domain manual by dana');
  // everyone in-domain can READ it
  assert.equal(getManual('domain', builder).sections.find((s) => s.id === 'general')?.content, 'domain manual by dana');
  updateManual('domain', admin, patch('domain manual by admin'));
});

test('Company manual: only admin edits; everyone reads', () => {
  __resetStore();
  assert.throws(() => updateManual('company', creator, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('company', builder, patch('x')), /Not permitted/);
  assert.throws(() => updateManual('company', dom, patch('x')), /Not permitted/);
  updateManual('company', admin, patch('company manual'));
  assert.equal(getManual('company', creator).sections.find((s) => s.id === 'general')?.content, 'company manual');
});

test('scopes are stored independently (no cross-contamination)', () => {
  __resetStore();
  updateManual('my', creator, patch('MINE'));
  updateManual('domain', dom, patch('DOMAIN'));
  updateManual('company', admin, patch('COMPANY'));
  assert.equal(getManual('my', creator).sections.find((s) => s.id === 'general')?.content, 'MINE');
  assert.equal(getManual('domain', creator).sections.find((s) => s.id === 'general')?.content, 'DOMAIN');
  assert.equal(getManual('company', creator).sections.find((s) => s.id === 'general')?.content, 'COMPANY');
});

// ─────────────────────────────────────── section migration (4→7 shape) ─────

test('reconcileSections: a fresh empty card has all 7 canonical sections', () => {
  const empty = { domain: 'test', sections: [], updatedAt: new Date().toISOString() };
  const result = reconcileSections(empty);
  assert.deepEqual(result.sections.map((s) => s.id), [...DOMAIN_SECTION_IDS]);
  assert.ok(result.sections.every((s) => s.content === ''), 'all sections empty');
});

test('reconcileSections: old 4-section card maps overview→general, goals→strategy, context→business, glossary→glossary', () => {
  const old = {
    domain: 'test',
    updatedAt: new Date().toISOString(),
    sections: [
      { id: 'overview' as const, title: 'Overview', content: 'OV' },
      { id: 'glossary' as const, title: 'Glossary', content: 'GL' },
      { id: 'goals' as const, title: 'Goals', content: 'GO' },
      { id: 'context' as const, title: 'Key Context', content: 'CTX' },
    ],
  };
  const result = reconcileSections(old);
  assert.deepEqual(result.sections.map((s) => s.id), [...DOMAIN_SECTION_IDS]);
  assert.equal(result.sections.find((s) => s.id === 'general')?.content, 'OV');
  assert.equal(result.sections.find((s) => s.id === 'strategy')?.content, 'GO');
  assert.equal(result.sections.find((s) => s.id === 'business')?.content, 'CTX');
  assert.equal(result.sections.find((s) => s.id === 'glossary')?.content, 'GL');
  assert.equal(result.sections.find((s) => s.id === 'organization')?.content, '');
  assert.equal(result.sections.find((s) => s.id === 'architecture')?.content, '');
  assert.equal(result.sections.find((s) => s.id === 'data')?.content, '');
});

test('reconcileSections: existing new-shape content is preserved (no overwrite)', () => {
  const already = {
    domain: 'test',
    updatedAt: new Date().toISOString(),
    sections: [
      { id: 'general' as const, title: 'General', content: 'already set' },
      { id: 'overview' as const, title: 'Overview', content: 'OLD' },
    ],
  };
  const result = reconcileSections(already);
  // general already has content → overview should NOT overwrite it
  assert.equal(result.sections.find((s) => s.id === 'general')?.content, 'already set');
});

test('getManual returns 7-section shape even for an old 4-section stored card', () => {
  __resetStore();
  // Write an old-shaped patch via the raw domain store (simulate legacy stored data).
  // We use updateManual with old ids — the store applies sections that match by id.
  // First, write with new id to establish the card, then check shape.
  updateManual('company', admin, { sections: [{ id: 'overview', content: 'LEGACY' }] });
  const card = getManual('company', creator);
  // Must have exactly 7 canonical sections
  assert.deepEqual(card.sections.map((s) => s.id), [...DOMAIN_SECTION_IDS]);
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
  assert.equal(restored.sections.find((s) => s.id === 'general')?.content, 'v1');
});
