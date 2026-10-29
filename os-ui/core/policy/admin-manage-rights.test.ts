/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Cross-tab enforcement of the tenant-admin manage-rights rule:
 *   • PERSONAL ("My") artifact  → owner ONLY (no domain_admin, no platform admin).
 *   • DOMAIN (Shared) artifact   → owner, in-domain domain_admin, or platform admin (any domain).
 *   • COMPANY (Certified) artifact → owner, source-domain domain_admin, or platform admin.
 *
 * Asserted through the CENTRAL function plus a representative tab: Folders
 * (`createFolder` + the manage gate on rename).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canManageArtifact } from '@core/policy/edit-scope';
import {
  createFolder,
  renameFolder,
  __resetStore,
} from '@core/folders/folder-store';
import type { Role } from '@core/kernel/session';

const u = (id: string, role: Role, domains: string[]) => ({ id, role, domains });

// Actors used across the matrix.
const owner = u('sara', 'creator', ['sales']); // owns the sales artifacts below
const inDomainAdmin = u('dana', 'domain_admin', ['sales']);
const otherDomainAdmin = u('otto', 'domain_admin', ['ops']);
const platformAdmin = u('alex', 'admin', ['platform']); // NOT in sales
const plainCreator = u('cal', 'creator', ['sales']);
const plainBuilder = u('bob', 'builder', ['sales']);

// ============================================================ central rule ==

test('central: admin manages a DOMAIN artifact of another domain', () => {
  assert.equal(canManageArtifact(platformAdmin, { owner: 'sara', domain: 'sales', scope: 'shared' }), true);
});
test('central: admin manages a COMPANY (certified) artifact', () => {
  assert.equal(canManageArtifact(platformAdmin, { owner: 'sara', domain: 'sales', scope: 'certified' }), true);
});
test('central: admin may NOT manage another user PERSONAL artifact', () => {
  assert.equal(canManageArtifact(platformAdmin, { owner: 'sara', domain: 'sales', scope: 'personal' }), false);
});
test('central: owner manages own PERSONAL artifact', () => {
  assert.equal(canManageArtifact(owner, { owner: 'sara', domain: 'sales', scope: 'personal' }), true);
});
test('central: in-domain domain_admin manages a DOMAIN artifact', () => {
  assert.equal(canManageArtifact(inDomainAdmin, { owner: 'sara', domain: 'sales', scope: 'shared' }), true);
});
test('central: other-domain domain_admin is DENIED a DOMAIN artifact', () => {
  assert.equal(canManageArtifact(otherDomainAdmin, { owner: 'sara', domain: 'sales', scope: 'shared' }), false);
});
test('central: domain_admin is DENIED any (not-own) PERSONAL artifact', () => {
  assert.equal(canManageArtifact(inDomainAdmin, { owner: 'sara', domain: 'sales', scope: 'personal' }), false);
});
test('central: a plain creator manages only own (DENIED a peer DOMAIN artifact)', () => {
  assert.equal(canManageArtifact(plainCreator, { owner: 'sara', domain: 'sales', scope: 'shared' }), false);
  assert.equal(canManageArtifact(plainBuilder, { owner: 'sara', domain: 'sales', scope: 'shared' }), false);
});

// ============================================================== Folders tab ==

test('folders: admin may NOT manage another user PERSONAL folder', () => {
  __resetStore();
  const f = createFolder(owner, { tab: 'files', scope: 'personal', path: '/private' });
  assert.throws(() => renameFolder(platformAdmin, f.id, '/seized'), /permission/i);
  assert.throws(() => renameFolder(inDomainAdmin, f.id, '/seized'), /permission/i);
});
test('folders: owner manages own PERSONAL folder', () => {
  __resetStore();
  const f = createFolder(owner, { tab: 'files', scope: 'personal', path: '/mine' });
  const renamed = renameFolder(owner, f.id, '/renamed');
  assert.equal(renamed.path, '/renamed');
});
test('folders: admin + in-domain domain_admin manage a DOMAIN folder', () => {
  __resetStore();
  const f = createFolder(inDomainAdmin, { tab: 'files', scope: 'domain', domain: 'sales', path: '/shared' });
  assert.equal(renameFolder(platformAdmin, f.id, '/shared2').path, '/shared2');
  assert.equal(renameFolder(inDomainAdmin, f.id, '/shared3').path, '/shared3');
});

// --- domain-folder CREATION gate (builder/creator must NOT create one) ------

test('folders: a builder/creator may create a PERSONAL folder', () => {
  __resetStore();
  assert.ok(createFolder(plainBuilder, { tab: 'files', scope: 'personal', path: '/b' }));
  assert.ok(createFolder(plainCreator, { tab: 'files', scope: 'personal', path: '/c' }));
});
test('folders: a builder may NOT create a DOMAIN folder (403)', () => {
  __resetStore();
  assert.throws(
    () => createFolder(plainBuilder, { tab: 'files', scope: 'domain', domain: 'sales', path: '/d' }),
    /domain admin|platform admin/i,
  );
});
test('folders: a creator may NOT create a DOMAIN folder (403)', () => {
  __resetStore();
  assert.throws(
    () => createFolder(plainCreator, { tab: 'files', scope: 'domain', domain: 'sales', path: '/d' }),
    /domain admin|platform admin/i,
  );
});
test('folders: an in-domain domain_admin CREATES a domain folder', () => {
  __resetStore();
  assert.ok(createFolder(inDomainAdmin, { tab: 'files', scope: 'domain', domain: 'sales', path: '/d' }));
});
test('folders: a platform admin creates any domain folder', () => {
  __resetStore();
  // Admin belongs to 'platform' — create in a domain they administer tenant-wide.
  assert.ok(createFolder(u('alex', 'admin', ['sales']), { tab: 'files', scope: 'domain', domain: 'sales', path: '/d' }));
});
