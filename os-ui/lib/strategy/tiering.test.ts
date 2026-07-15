/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase-0 tiering gates (pure, from strategy/model.ts):
 *   • My / Domain / Company view + edit gating;
 *   • promote My→Domain→Company gating (Builder gate to Domain, Admin gate to
 *     Company; owner/Admin initiates);
 *   • a bet inheriting its parent pillar's tier by containment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canViewPillar,
  canEditPillar,
  canCreatePillar,
  canPromotePillar,
  nextPillarScope,
  betTier,
  groupBetsByTier,
  type Pillar,
  type PillarScope,
} from './model.ts';

const owner = { id: 'u-owner', domains: ['sales'], role: 'creator' as const };
const peer = { id: 'u-peer', domains: ['sales'], role: 'creator' as const };
const salesBuilder = { id: 'u-sb', domains: ['sales'], role: 'builder' as const };
const otherBuilder = { id: 'u-ob', domains: ['ops'], role: 'builder' as const };
const admin = { id: 'u-admin', domains: ['platform'], role: 'admin' as const };

function pillar(scope: PillarScope, over: Partial<Pillar> = {}): Pick<Pillar, 'scope' | 'domain' | 'owner'> {
  return { scope, domain: 'sales', owner: 'u-owner', ...over };
}

// ---------------------------------------------------------------- view ----

test('personal (My) pillar is visible + editable to its OWNER only', () => {
  const p = pillar('personal');
  assert.equal(canViewPillar(owner, p), true, 'owner views own My pillar');
  assert.equal(canEditPillar(owner, p), true, 'owner edits own My pillar (even as a creator)');
  assert.equal(canViewPillar(peer, p), false, 'a domain peer cannot see a My pillar');
  assert.equal(canViewPillar(salesBuilder, p), false, 'a domain builder cannot see a My pillar');
  assert.equal(canViewPillar(admin, p), false, 'even an admin cannot see someone else\'s My pillar');
});

test('domain pillar: members view; owner or in-domain Builder+ edit', () => {
  const p = pillar('domain');
  assert.equal(canViewPillar(peer, p), true, 'a domain member views a domain pillar');
  assert.equal(canViewPillar(otherBuilder, p), false, 'an out-of-domain user cannot view it');
  assert.equal(canViewPillar(admin, p), true, 'a platform admin is tenant-wide');
  // Edit: owner (Builder+) or an in-domain Builder+; a creator peer cannot edit.
  assert.equal(canEditPillar(peer, p), false, 'a plain creator member cannot edit');
  assert.equal(canEditPillar(salesBuilder, p), true, 'an in-domain Builder edits');
  assert.equal(canEditPillar(otherBuilder, p), false, 'an out-of-domain Builder cannot edit');
});

test('tenant (Company) pillar: everyone views; only Admin edits', () => {
  const p = pillar('tenant', { domain: 'tenant' });
  assert.equal(canViewPillar(peer, p), true, 'everyone views a Company pillar');
  assert.equal(canViewPillar(otherBuilder, p), true, 'even out-of-domain users view Company');
  assert.equal(canEditPillar(salesBuilder, p), false, 'a Builder cannot edit a Company pillar');
  assert.equal(canEditPillar(admin, p), true, 'an Admin edits a Company pillar');
});

// -------------------------------------------------------------- create ----

test('canCreatePillar per tier: My open to members, Domain Builder+, Company Admin', () => {
  // My — any member of a domain they belong to; a new pillar has no owner yet.
  assert.equal(canCreatePillar(peer, 'personal', 'sales'), true, 'a creator creates a My pillar');
  assert.equal(canCreatePillar(peer, 'personal', 'ops'), false, 'not in a domain they don\'t belong to');
  // Domain — Builder+ IN the domain (no owner shortcut for a new pillar).
  assert.equal(canCreatePillar(salesBuilder, 'domain', 'sales'), true);
  assert.equal(canCreatePillar(salesBuilder, 'domain', 'ops'), false, 'Builder cannot create in a foreign domain');
  assert.equal(canCreatePillar(peer, 'domain', 'sales'), false, 'a creator cannot create a Domain pillar');
  // Company — Admin only.
  assert.equal(canCreatePillar(admin, 'tenant', 'tenant'), true);
  assert.equal(canCreatePillar(salesBuilder, 'tenant', 'tenant'), false);
});

// ------------------------------------------------------------- promote ----

test('nextPillarScope walks personal → domain → tenant → (none)', () => {
  assert.equal(nextPillarScope('personal'), 'domain');
  assert.equal(nextPillarScope('domain'), 'tenant');
  assert.equal(nextPillarScope('tenant'), null);
});

test('promote My→Domain needs Builder+ in the owning domain (owner initiates)', () => {
  const p = pillar('personal');
  // Owner is a plain creator → cannot self-promote to Domain (Builder gate).
  assert.equal(canPromotePillar(owner, p), false, 'a creator owner cannot promote to Domain');
  // A Builder who OWNS it (and is in the domain) can.
  assert.equal(canPromotePillar({ ...salesBuilder, id: 'u-owner' }, p), true, 'owning in-domain Builder promotes');
  // A non-owner, non-admin Builder cannot initiate.
  assert.equal(canPromotePillar(salesBuilder, p), false, 'a non-owner Builder cannot initiate the promote');
  // Admin can always initiate.
  assert.equal(canPromotePillar(admin, p), true, 'an Admin promotes to Domain');
});

test('promote Domain→Company needs an Admin', () => {
  const p = pillar('domain');
  assert.equal(canPromotePillar({ ...salesBuilder, id: 'u-owner' }, p), false, 'an owning Builder cannot promote to Company');
  assert.equal(canPromotePillar(admin, p), true, 'only an Admin promotes to Company');
});

test('a Company (tenant) pillar cannot be promoted further', () => {
  assert.equal(canPromotePillar(admin, pillar('tenant', { domain: 'tenant' })), false);
});

// ------------------------------------------------ bet tier by containment --

test('a bet inherits its parent pillar\'s tier; unlinked/unknown → My (personal)', () => {
  const scopes = new Map<string, PillarScope>([
    ['p-my', 'personal'],
    ['p-dom', 'domain'],
    ['p-co', 'tenant'],
  ]);
  assert.equal(betTier('p-my', scopes), 'personal');
  assert.equal(betTier('p-dom', scopes), 'domain');
  assert.equal(betTier('p-co', scopes), 'tenant');
  assert.equal(betTier(undefined, scopes), 'personal', 'an unlinked bet defaults to My');
  assert.equal(betTier('p-ghost', scopes), 'personal', 'an unknown pillar defaults to My');

  const grouped = groupBetsByTier(
    [{ pillarId: 'p-co' }, { pillarId: 'p-dom' }, { pillarId: undefined }, { pillarId: 'p-my' }],
    scopes,
  );
  assert.deepEqual(grouped.tenant.map((b) => b.pillarId), ['p-co']);
  assert.deepEqual(grouped.domain.map((b) => b.pillarId), ['p-dom']);
  assert.equal(grouped.personal.length, 2, 'the unlinked + My-linked bets land in My');
});
