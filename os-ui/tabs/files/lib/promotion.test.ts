/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promotionGate, gateReason, promotionReadiness, readinessLabel, readinessHint,
  type GateFields,
} from '@tabs/files/lib/promotion';
import { emptyAsset, type FileAsset } from '@tabs/files/lib/asset-schema';

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

/**
 * The PRE-FLIGHT half (2026-11-18): the selection toolbar must be able to say "3 of 12 ready
 * to promote" BEFORE anything is POSTed. It runs the SAME `promotionGate` over the LISTING
 * rows — which is why the gate takes only the four fields it reads, and why `FileSummary`
 * carries `description`. A second, client-side approximation of "documented" would drift.
 */
function listingRow(over: Partial<GateFields> = {}): GateFields {
  return { owner: 'amir', domain: 'sales', description: '', tags: [], ...over };
}

test('the gate reads only the listing fields, so a summary row passes through it unchanged', () => {
  // A FileSummary-shaped row (no body, no version, no storage) is a valid gate input.
  assert.equal(promotionGate(listingRow()).ok, false);
  assert.equal(promotionGate(listingRow({ description: 'Supplier invoices', tags: ['invoices'] })).ok, true);
  // And the full asset still agrees with the row cut from it.
  const asset = a({ description: 'd', tags: ['t'] });
  assert.deepEqual(
    promotionGate(asset),
    promotionGate({ owner: asset.owner, domain: asset.domain, description: asset.description, tags: asset.tags }),
  );
});

test('promotionReadiness counts the selection the toolbar is about to act on', () => {
  const ready = listingRow({ description: 'd', tags: ['t'] });
  const rows = [ready, ready, ready, ...Array.from({ length: 9 }, () => listingRow())];
  const r = promotionReadiness(rows);
  assert.equal(r.ready, 3);
  assert.equal(r.total, 12);
  assert.equal(r.blocked.length, 9);
  assert.equal(readinessLabel(r), '3 of 12 ready to promote');
  // An empty selection is neither ready nor blocked.
  assert.deepEqual(promotionReadiness([]), { ready: 0, total: 0, blocked: [] });
});

test('the hint names every distinct gap once, so a disabled button still teaches', () => {
  const r = promotionReadiness([
    listingRow(),                                // missing both
    listingRow({ description: 'd' }),            // missing the tag
    listingRow({ domain: '', description: 'd', tags: ['t'] }), // missing the domain
  ]);
  const hint = readinessHint(r);
  assert.match(hint, /a description/);
  assert.match(hint, /at least one tag/);
  assert.match(hint, /domain/);
  assert.equal(hint.match(/a description/g)?.length, 1); // deduped, not repeated per row
  // Nothing blocked → nothing to hint at.
  assert.equal(readinessHint(promotionReadiness([listingRow({ description: 'd', tags: ['t'] })])), '');
});
