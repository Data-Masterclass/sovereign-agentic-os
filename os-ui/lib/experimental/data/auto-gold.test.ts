/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoGold, type AutoGoldInput } from './auto-gold.ts';

const V = (built: boolean, updatedAt: string | null = null) => ({ built, updatedAt });
const ds = (
  origin: 'ingest' | 'curated' | undefined,
  bronze: { built: boolean; updatedAt?: string | null },
  silver: { built: boolean; updatedAt?: string | null },
  gold: { built: boolean; updatedAt?: string | null },
): AutoGoldInput => ({
  origin,
  versions: {
    bronze: V(bronze.built, bronze.updatedAt ?? null),
    silver: V(silver.built, silver.updatedAt ?? null),
    gold: V(gold.built, gold.updatedAt ?? null),
  },
});

test('curated never auto-golds — its Gold is the explicit Compose build', () => {
  assert.equal(shouldAutoGold(ds('curated', { built: true }, { built: true }, { built: false }), 'bronze'), false);
  assert.equal(shouldAutoGold(ds('curated', { built: true }, { built: true }, { built: false }), 'silver'), false);
});

test('ingested bronze build with no Gold → auto-gold (carries bronze forward)', () => {
  assert.equal(shouldAutoGold(ds('ingest', { built: true }, { built: false }, { built: false }), 'bronze'), true);
});

test('ingested silver build with no Gold → auto-gold', () => {
  assert.equal(shouldAutoGold(ds('ingest', { built: true }, { built: true }, { built: false }), 'silver'), true);
});

test('undefined origin is treated as ingested (default lane)', () => {
  assert.equal(shouldAutoGold(ds(undefined, { built: true }, { built: false }, { built: false }), 'bronze'), true);
});

test('a just-built layer that is absent never fires (defensive — would 400)', () => {
  assert.equal(shouldAutoGold(ds('ingest', { built: false }, { built: false }, { built: false }), 'bronze'), false);
  assert.equal(shouldAutoGold(ds('ingest', { built: true }, { built: false }, { built: false }), 'silver'), false);
});

test('Gold already newer than the just-built layer → no redundant re-fire (idempotent re-open)', () => {
  // Silver built at T1, Gold built at T2 (later) — re-opening must not re-copy.
  assert.equal(
    shouldAutoGold(ds('ingest', { built: true }, { built: true, updatedAt: '2026-01-01T00:00:00Z' }, { built: true, updatedAt: '2026-02-01T00:00:00Z' }), 'silver'),
    false,
  );
});

test('a fresh silver build newer than an existing Gold → refresh Gold', () => {
  assert.equal(
    shouldAutoGold(ds('ingest', { built: true }, { built: true, updatedAt: '2026-03-01T00:00:00Z' }, { built: true, updatedAt: '2026-02-01T00:00:00Z' }), 'silver'),
    true,
  );
});

test('missing timestamps with an existing Gold → treated as not-newer (no re-fire)', () => {
  assert.equal(
    shouldAutoGold(ds('ingest', { built: true }, { built: true }, { built: true }), 'silver'),
    false,
  );
});
