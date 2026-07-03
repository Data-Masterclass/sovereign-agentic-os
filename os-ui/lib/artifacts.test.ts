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
import { seed, createArtifact, promoteArtifact, addFromMarketplace, getArtifact, __resetArtifactsCache } from './artifacts.ts';
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
