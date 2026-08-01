/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { _resetModels, upsertModel } from './model-service.ts';
import { scienceAdapter } from './folder-adapter.ts';
import type { ServiceModel } from './types.ts';

// A SHARED (Domain-tier) model — the scope where a non-owner domain_admin has manage
// authority. Models are DOMAIN-scoped, so every model's folders live in the domain tree.
function domainModel(): ServiceModel {
  return {
    id: 'svc_test', model: 'test_model', name: 'Test', owner: 'sara', domain: 'sales',
    tier: 'Domain', stage: 'Staging', frontDoors: ['rest', 'mcp'],
    versions: [{ version: 'v1', stage: 'Staging', auc: 0.8, certified: false, runId: 'r1' }],
  };
}

// The domain_admin who may manage a non-owned shared model in their domain.
const domainAdmin = { id: 'dana', role: 'domain_admin', domains: ['sales'] };

beforeEach(() => { _resetModels(); resetFolders(); });

// Models are DOMAIN-scoped (there is no cross-tenant personal lane): after a move the
// DOMAIN scope enumeration finds the model at its new path, and the PERSONAL scope never
// does — so a scope-driven single-root picker can only ever offer a valid destination.
test('a moved model is found under its new folder in the DOMAIN scope only', () => {
  upsertModel(domainModel());
  scienceAdapter.moveItem('test_model', domainAdmin, '/finance');
  assert.deepEqual(
    scienceAdapter.itemsUnderFolder(domainAdmin, 'domain', '/finance').map((i) => i.id),
    ['test_model'],
  );
  assert.deepEqual(scienceAdapter.itemsUnderFolder(domainAdmin, 'personal', '/finance').map((i) => i.id), []);
});

test('science adapter itemsUnderFolder includes ARCHIVED members for the cascade', () => {
  upsertModel(domainModel());
  scienceAdapter.moveItem('test_model', domainAdmin, '/keep');
  scienceAdapter.archiveItem('test_model', domainAdmin);
  assert.deepEqual(
    scienceAdapter.itemsUnderFolder(domainAdmin, 'domain', '/keep').map((i) => i.id),
    ['test_model'],
  );
});

test('science adapter ops are edit-scoped — an out-of-domain admin is rejected 403', () => {
  upsertModel(domainModel());
  const otherAdmin = { id: 'm', role: 'admin', domains: ['marketing'] };
  assert.throws(() => scienceAdapter.moveItem('test_model', otherAdmin, '/x'), (e) => (e as { status?: number }).status === 403);
  assert.throws(() => scienceAdapter.archiveItem('test_model', otherAdmin), (e) => (e as { status?: number }).status === 403);
});

test('science adapter restore reverses archive; delete requires archived-first', () => {
  upsertModel(domainModel());
  scienceAdapter.archiveItem('test_model', domainAdmin);
  scienceAdapter.restoreItem('test_model', domainAdmin);
  // Not archived → delete is refused (the OS-wide archive-before-delete rule).
  assert.throws(() => scienceAdapter.deleteItem('test_model', domainAdmin), /archive the model before deleting/i);
  scienceAdapter.archiveItem('test_model', domainAdmin);
  scienceAdapter.deleteItem('test_model', domainAdmin);
  assert.deepEqual(scienceAdapter.itemsUnderFolder(domainAdmin, 'domain', '/').map((i) => i.id), []);
});
