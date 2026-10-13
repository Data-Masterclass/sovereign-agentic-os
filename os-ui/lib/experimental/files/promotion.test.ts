/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotionGate, gateReason } from './promotion.ts';
import { emptyAsset, type FileAsset } from './asset-schema.ts';

function a(over: Partial<FileAsset> = {}): FileAsset {
  return { ...emptyAsset({ id: 'as_x', name: 'x.pdf', owner: 'amir', domain: 'sales' }), ...over };
}

test('the docs gate requires owner + description + ≥1 tag (decision #5)', () => {
  assert.equal(promotionGate(a()).ok, false); // no description, no tags
  assert.equal(promotionGate(a({ description: 'd' })).ok, false); // still no tags
  assert.equal(promotionGate(a({ description: 'd', tags: ['t'] })).ok, true);
});

test('the gate names exactly what is missing', () => {
  const r = promotionGate(a());
  assert.ok(r.missing.includes('a description'));
  assert.ok(r.missing.includes('at least one tag'));
  assert.match(gateReason(r), /add .* first/);
  assert.equal(gateReason(promotionGate(a({ description: 'd', tags: ['t'] }))), 'ready to promote');
});
