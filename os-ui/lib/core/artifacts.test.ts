/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Artifact security tests — the fail-open gaps this suite pins closed:
 *   • Marketplace IMPORT (addFromMarketplace) is Builder+ (a creator/participant
 *     cannot self-import a cross-domain Certified item).
 *   • The demo seed is EMPTY by default so a fresh cohort tenant starts clean.
 * Pure module (no cluster): getCache's OpenSearch probe fails fast offline, so
 * everything runs in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed, createArtifact, promoteArtifact, demoteArtifact, addFromMarketplace, getArtifact, updateArtifact, deleteArtifact, listForUser, archiveArtifact, listArtifactVersions, restoreArtifactVersion, __resetArtifactsCache } from './artifacts.ts';
import type { CurrentUser } from './auth.ts';

const admin: CurrentUser = { id: 'arya', name: 'Arya', domains: ['sales'], role: 'admin' };
const builder: CurrentUser = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const participant: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };

/** Admin authors a Certified Marketplace artifact via the governed ladder. */
async function certified(): Promise<string> {
  const a = await createArtifact(admin, { type: 'metric', name: 'Company revenue', domain: 'sales' });
  await promoteArtifact(a.id, admin); // Personal → Shared
  await promoteArtifact(a.id, admin); // Shared → Certified
  return a.id;
}

test('SECURITY: the demo seed is empty unless SEED_DEMO_ARTIFACTS=1', () => {
  const prev = process.env.SEED_DEMO_ARTIFACTS;
  delete process.env.SEED_DEMO_ARTIFACTS;
  assert.equal(seed().length, 0, 'a fresh cohort tenant starts clean');
  process.env.SEED_DEMO_ARTIFACTS = '1';
  assert.ok(seed().length > 0, 'the teaching flag re-enables the worked-example seed');
  if (prev === undefined) delete process.env.SEED_DEMO_ARTIFACTS;
  else process.env.SEED_DEMO_ARTIFACTS = prev;
});

test('SECURITY: a creator cannot self-import a Certified Marketplace artifact', async () => {
  const id = await certified();
  await assert.rejects(() => addFromMarketplace(id, creator), /Builder or Admin/i);
  await assert.rejects(() => addFromMarketplace(id, participant), /Builder or Admin/i);
});

test('a Builder (and Admin) may import from the Marketplace', async () => {
  const id = await certified();
  const copy = await addFromMarketplace(id, builder);
  assert.equal(copy.owner, builder.id);
  assert.equal(copy.origin, 'certified-copy');
  assert.equal(copy.sourceId, id);
});

test('DEMOTE: revoke sharing lowers Certified → Shared → Personal one step at a time', async () => {
  __resetArtifactsCache();
  const id = await certified();
  assert.equal((await getArtifact(id))!.visibility, 'Certified');
  const shared = await demoteArtifact(id, admin); // Certified → Shared (admin)
  assert.equal(shared.visibility, 'Shared');
  const personal = await demoteArtifact(id, admin); // Shared → Personal
  assert.equal(personal.visibility, 'Personal');
  await assert.rejects(() => demoteArtifact(id, admin), /already Personal/i);
});

test('DEMOTE role gate: revoking a Certified artifact requires an admin (builder → 403)', async () => {
  __resetArtifactsCache();
  const id = await certified();
  await assert.rejects(() => demoteArtifact(id, builder), /admin/i);
});

test('DEMOTE role gate (fail-closed): a creator cannot unshare a Shared artifact they do not own', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(builder, { type: 'knowledge', name: 'Shared runbook', domain: 'sales' });
  await promoteArtifact(a.id, builder); // Personal → Shared (owned by builder)
  await assert.rejects(() => demoteArtifact(a.id, creator), /owner or an in-domain builder/i);
});

test('DEMOTE: the owner may unshare their own Shared artifact even as a creator', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(creator, { type: 'knowledge', name: 'My draft', domain: 'sales' });
  await promoteArtifact(a.id, builder); // Personal → Shared (a builder promoted it)
  const back = await demoteArtifact(a.id, creator); // owner pulls it back
  assert.equal(back.visibility, 'Personal');
});

test('globalThis: soa.artifacts.cache — write is visible on globalThis and readable back', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(admin, { type: 'dataset', name: 'Pin test', domain: 'sales' });
  const g = (globalThis as any)[Symbol.for('soa.artifacts.cache')];
  assert.ok(g, 'globalThis key is set');
  assert.ok(g.cache instanceof Map, 'cache is a Map on globalThis');
  assert.ok(g.cache.has(a.id), 'written artifact is in globalThis cache');
  const fetched = await getArtifact(a.id);
  assert.equal(fetched?.id, a.id, 'reading back returns the same artifact — pinned');
});

// ------------------------------------------------ archive / delete / versions --

test('updateArtifact snapshots the prior state; restore reverts + is itself versioned', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(builder, { type: 'knowledge', name: 'Runbook', description: 'v0', domain: 'sales' });
  assert.equal((await listArtifactVersions(a.id, builder)).length, 0);

  await updateArtifact(a.id, builder, { description: 'v1' });
  await updateArtifact(a.id, builder, { description: 'v2' });
  const history = await listArtifactVersions(a.id, builder);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 2, 'newest first');
  assert.equal((history[1].state as { description: string }).description, 'v0', 'v1 holds the original');

  // Restore v1 (original description) → reverts AND snapshots the current state.
  const restored = await restoreArtifactVersion(a.id, builder, 1);
  assert.equal(restored.description, 'v0');
  const after = await listArtifactVersions(a.id, builder);
  assert.equal(after.length, 3);
  assert.match(after[0].summary, /restore of v1/);

  await assert.rejects(() => restoreArtifactVersion(a.id, builder, 99), /not found/i);
});

test('archive soft-hides an artifact from the list; unarchive restores it', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(builder, { type: 'knowledge', name: 'Draft', domain: 'sales' });
  await archiveArtifact(a.id, builder, true);
  assert.ok(!(await listForUser(builder, { type: 'knowledge' })).some((x) => x.id === a.id));
  assert.ok((await listForUser(builder, { type: 'knowledge', includeArchived: true })).some((x) => x.id === a.id));
  await archiveArtifact(a.id, builder, false);
  assert.ok((await listForUser(builder, { type: 'knowledge' })).some((x) => x.id === a.id));
});

test('delete purges the artifact and its version history; edits obey edit authz', async () => {
  __resetArtifactsCache();
  const a = await createArtifact(builder, { type: 'knowledge', name: 'Doomed', description: 'x', domain: 'sales' });
  await updateArtifact(a.id, builder, { description: 'y' });
  assert.equal((await listArtifactVersions(a.id, builder)).length, 1);

  // A different creator (not owner, not admin) cannot archive/edit/restore.
  const other: CurrentUser = { id: 'nate', name: 'Nate', domains: ['sales'], role: 'creator' };
  await assert.rejects(() => archiveArtifact(a.id, other, true), /Not permitted/i);
  await assert.rejects(() => restoreArtifactVersion(a.id, other, 1), /Not permitted/i);

  await deleteArtifact(a.id, builder);
  assert.equal(await getArtifact(a.id), null);
  // A fresh artifact starts with clean history (purge worked, no leakage).
  const b = await createArtifact(builder, { type: 'knowledge', name: 'Fresh', domain: 'sales' });
  assert.equal((await listArtifactVersions(b.id, builder)).length, 0);
});
