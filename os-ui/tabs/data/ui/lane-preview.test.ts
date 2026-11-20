/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Build previews name the recorded lane table
 * USER STORY: As a builder I want the Refine/GoldJoin SQL preview to show the table the build
 *             writes, so that a same-named dataset's table never appears in my preview.
 * ARCHITECTURE:
 *   - Pure test of lane-preview.ts against the server plans in transform.ts (silverPlan, passThroughPlan).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewLaneFqn } from '@tabs/data/ui/lane-preview';
import { silverPlan, passThroughPlan } from '@tabs/data/lib/transform';

const d = { name: 'Goods Receipts', domain: 'q3', tier: 'asset', laneSlug: 'goods_receipts_r0ejqrd65h' };
const ident = { uid: 'aborek', domains: ['q3'] };

test('the preview names the RECORDED lane table — the one the server plan writes', () => {
  const view = { owner: 'aborek', datasetName: d.name, laneSlug: d.laneSlug };
  assert.equal(previewLaneFqn(view, 'silver'), silverPlan(d, ident, ['a'], []).target);
  assert.equal(previewLaneFqn(view, 'bronze'), silverPlan(d, ident, ['a'], []).source);
  assert.equal(previewLaneFqn(view, 'gold'), passThroughPlan(d, ident, 'gold').target);
});

test('NEGATIVE TWIN: with a recorded lane name the preview never shows the name-only table', () => {
  const fqn = previewLaneFqn({ owner: 'aborek', datasetName: d.name, laneSlug: d.laneSlug }, 'gold');
  assert.notEqual(fqn, 'iceberg.personal_aborek.gold_goods_receipts');
  // A legacy dataset (no recorded name) keeps its legacy table.
  assert.equal(previewLaneFqn({ owner: 'aborek', datasetName: d.name }, 'gold'), 'iceberg.personal_aborek.gold_goods_receipts');
});
