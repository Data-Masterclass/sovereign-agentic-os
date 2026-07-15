/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase-0 pillar lifecycle + versioning (server store, lib/strategy/pillars.ts):
 *   • archive → restore → physical delete, each version-logged;
 *   • a create + edit + archive/restore snapshot the version history;
 *   • deleting a pillar that still has linked bets is BLOCKED (409, non-destructive);
 *   • personal (My) create + list; archived pillars hidden unless opted in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPillar,
  listPillars,
  archivePillar,
  unarchivePillar,
  deletePillar,
  listPillarVersions,
  restorePillarVersion,
  updatePillar,
  __resetForTests,
} from './pillars.ts';
import type { CurrentUser } from '../core/auth.ts';

const admin: CurrentUser = { id: 'u-admin', name: 'Ada', role: 'admin', domains: ['platform'] };
const builder: CurrentUser = { id: 'u-b', name: 'Bo', role: 'builder', domains: ['sales'] };

test('personal (My) create: owner-only visibility + hidden from a peer', async () => {
  __resetForTests();
  const p = await createPillar(builder, { name: 'My focus', scope: 'personal' });
  assert.equal(p.scope, 'personal');
  assert.ok((await listPillars(builder)).some((x) => x.id === p.id), 'owner sees their My pillar');
  const peer: CurrentUser = { id: 'u-peer', name: 'Pi', role: 'builder', domains: ['sales'] };
  assert.equal((await listPillars(peer)).some((x) => x.id === p.id), false, 'a peer never sees a My pillar');
});

test('archive → restore → delete, each version-logged; delete purges history', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  // create snapshot
  assert.equal((await listPillarVersions(admin, p.id)).length, 1, 'create logs v1');

  await updatePillar(admin, p.id, { description: 'edited' });
  assert.equal((await listPillarVersions(admin, p.id)).length, 2, 'edit logs a version');

  const archived = await archivePillar(admin, p.id);
  assert.equal(archived.archived, true, 'archive sets the flag');
  // hidden by default, visible with includeArchived
  assert.equal((await listPillars(admin)).some((x) => x.id === p.id), false, 'archived hidden by default');
  assert.ok((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), 'opt-in shows it');

  const restored = await unarchivePillar(admin, p.id);
  assert.equal(restored.archived, false, 'restore clears the flag');
  assert.ok((await listPillars(admin)).some((x) => x.id === p.id), 'restored back into the working list');

  const versionsBeforeDelete = (await listPillarVersions(admin, p.id)).length;
  assert.ok(versionsBeforeDelete >= 4, 'create+edit+archive+restore all logged');

  await deletePillar(admin, p.id);
  assert.equal((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), false, 'gone');
  // The pillar itself is gone → a version query is a typed 404 (nothing to view),
  // and the underlying history was purged.
  await assert.rejects(
    () => listPillarVersions(admin, p.id),
    (e: Error & { status?: number }) => e.status === 404,
    'version history unavailable after hard delete',
  );
});

test('restorePillarVersion reverts content + is itself reversible (snapshots current first)', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'V1', scope: 'tenant' });
  await updatePillar(admin, p.id, { name: 'V2' });
  const versions = await listPillarVersions(admin, p.id); // newest-first
  const v1 = versions.find((v) => (v.state as { name?: string }).name === 'V1')!;
  assert.ok(v1, 'the v1 snapshot exists');

  const restored = await restorePillarVersion(admin, p.id, v1.version);
  assert.equal(restored.name, 'V1', 'content reverted to v1');
  // Restore snapshots the current (V2) state first → the V2 state is recoverable.
  const after = await listPillarVersions(admin, p.id);
  assert.ok(after.some((v) => (v.state as { name?: string }).name === 'V2'), 'V2 kept as a version, restore is reversible');
});

test('deleting a pillar with linked bets is BLOCKED (409, non-destructive)', async () => {
  __resetForTests();
  const p = await createPillar(admin, { name: 'Has bets', scope: 'tenant' });
  // Inject a linked bet id directly on the record (bypassing the bets-bridge stub,
  // which this unit does not exercise) to assert the delete-guard rule.
  const listed = await listPillars(admin, { includeArchived: true });
  const rec = listed.find((x) => x.id === p.id)!;
  rec.betIds.push('bet_linked');

  await assert.rejects(
    () => deletePillar(admin, p.id),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409, 'must be a 409 conflict');
      return /linked big bet/i.test(e.message);
    },
    'a pillar with live bets must not be deletable',
  );
  // Still present — nothing destroyed.
  assert.ok((await listPillars(admin, { includeArchived: true })).some((x) => x.id === p.id), 'pillar survives the blocked delete');
});
