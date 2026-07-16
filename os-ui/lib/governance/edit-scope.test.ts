/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageArtifact, type ArtifactScope } from './edit-scope.ts';
import type { Role } from '../core/session.ts';

const user = (id: string, role: Role, domains: string[]) => ({ id, role, domains });
// The subject artifact: owned by sara in the sales domain.
const art = (scope: ArtifactScope) => ({ owner: 'sara', domain: 'sales', scope });

// ------------------------------------------------------------------ owner --

test('OWNER manages own PERSONAL — even as a bare Creator', () => {
  assert.equal(canManageArtifact(user('sara', 'creator', ['sales']), art('personal')), true);
});
test('OWNER manages own SHARED', () => {
  assert.equal(canManageArtifact(user('sara', 'creator', ['sales']), art('shared')), true);
});
test('OWNER manages own CERTIFIED', () => {
  assert.equal(canManageArtifact(user('sara', 'creator', ['sales']), art('certified')), true);
});

// --------------------------------------------------- PERSONAL is owner-only --

test('platform admin is DENIED another user PERSONAL artifact (privacy close)', () => {
  assert.equal(canManageArtifact(user('alex', 'admin', ['ops']), art('personal')), false);
});
test('in-domain domain_admin is DENIED another user PERSONAL artifact', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['sales']), art('personal')), false);
});
test('any domain_admin (not own) is DENIED a PERSONAL artifact', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['ops']), art('personal')), false);
});
test('a plain builder/creator is DENIED another user PERSONAL artifact', () => {
  assert.equal(canManageArtifact(user('bob', 'builder', ['sales']), art('personal')), false);
  assert.equal(canManageArtifact(user('cal', 'creator', ['sales']), art('personal')), false);
});

// --------------------------------------------------- SHARED (domain) tier --

test('platform admin manages ANY-domain SHARED artifact', () => {
  assert.equal(canManageArtifact(user('alex', 'admin', ['ops']), art('shared')), true);
});
test('in-domain domain_admin manages a SHARED artifact', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['sales']), art('shared')), true);
});
test('other-domain domain_admin is DENIED a SHARED artifact', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['ops']), art('shared')), false);
});
test('non-owner Builder is DENIED a SHARED artifact (fail-closed gap)', () => {
  assert.equal(canManageArtifact(user('bob', 'builder', ['sales']), art('shared')), false);
});
test('non-owner Creator is DENIED a SHARED artifact', () => {
  assert.equal(canManageArtifact(user('cal', 'creator', ['sales']), art('shared')), false);
});

// --------------------------------------------- CERTIFIED (company) tier --

test('platform admin manages ANY-domain CERTIFIED artifact', () => {
  assert.equal(canManageArtifact(user('alex', 'admin', ['ops']), art('certified')), true);
});
test('in-domain domain_admin still manages a CERTIFIED artifact of its domain', () => {
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['sales']), art('certified')), true);
});
test('non-owner Builder is DENIED a CERTIFIED artifact', () => {
  assert.equal(canManageArtifact(user('bob', 'builder', ['sales']), art('certified')), false);
});

// ----------------------------------------------- fail-closed / defaults --

test('an OMITTED scope collapses to the SHARED rule (never owner-only bypass, never open)', () => {
  const a = { owner: 'sara', domain: 'sales' };
  assert.equal(canManageArtifact(user('alex', 'admin', ['ops']), a), true);
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['sales']), a), true);
  assert.equal(canManageArtifact(user('dana', 'domain_admin', ['ops']), a), false);
  assert.equal(canManageArtifact(user('bob', 'builder', ['sales']), a), false);
});
