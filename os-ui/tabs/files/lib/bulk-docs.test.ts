/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Describe & tag" over a selection — append, never silently replace
 * USER STORY: As a Files owner with 12 undocumented invoices I describe and tag them all at
 *             once, and the tags a file already carried survive: a bulk retag must not destroy
 *             work on a mis-click. I can still clear tags, or overwrite descriptions, by asking.
 * ARCHITECTURE:
 *   - Pure per-row patch builder for the EXISTING per-file write path (PATCH /api/files/[id] →
 *     setDocs); no new write path, so no second gate.
 *   - `null` means "this file would not change" — the caller skips the request rather than
 *     recording a failure, and the store sees no version churn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTags,
  unionTags,
  parseTagInput,
  describeAndTagPatch,
  type DescribeAndTagInput,
  type DocsRow,
} from '@tabs/files/lib/bulk-docs';

function row(over: Partial<DocsRow> = {}): DocsRow {
  return { id: 'as_1', name: 'invoice-01.pdf', description: '', tags: [], ...over };
}
function input(over: Partial<DescribeAndTagInput> = {}): DescribeAndTagInput {
  return { description: '', tags: [], overwriteDescription: false, replaceTags: false, ...over };
}

test('tag input parses commas and newlines, trims, and drops blanks', () => {
  assert.deepEqual(parseTagInput(' invoices , 2026\nfinance,,  '), ['invoices', '2026', 'finance']);
  assert.deepEqual(parseTagInput('   '), []);
});

test('cleanTags dedupes case-insensitively and keeps the first spelling', () => {
  assert.deepEqual(cleanTags([' Finance ', 'finance', 'FINANCE', 'ar']), ['Finance', 'ar']);
});

test('tags are a set-union: what the file already carried survives', () => {
  const p = describeAndTagPatch(row({ tags: ['invoices'] }), input({ tags: ['2026', 'finance'] }));
  assert.deepEqual(p?.tags, ['invoices', '2026', 'finance']);
  // A tag the file already has adds nothing — and an all-duplicate entry is a no-op.
  assert.deepEqual(unionTags(['invoices'], ['Invoices']), ['invoices']);
  assert.equal(describeAndTagPatch(row({ tags: ['invoices'] }), input({ tags: ['invoices'] })), null);
});

test('the user can still clear or replace tags, but only by asking', () => {
  const replaced = describeAndTagPatch(row({ tags: ['old'] }), input({ tags: ['new'], replaceTags: true }));
  assert.deepEqual(replaced?.tags, ['new']);
  const cleared = describeAndTagPatch(row({ tags: ['old'] }), input({ tags: [], replaceTags: true }));
  assert.deepEqual(cleared?.tags, []);
  // Clearing a file that has no tags changes nothing.
  assert.equal(describeAndTagPatch(row(), input({ replaceTags: true })), null);
});

test('a description is written where one is MISSING, not over one that exists', () => {
  const filled = describeAndTagPatch(row(), input({ description: 'Supplier invoices, FY26' }));
  assert.equal(filled?.description, 'Supplier invoices, FY26');
  // An existing description is left alone…
  const kept = describeAndTagPatch(row({ description: 'Hand-written, do not touch' }), input({ description: 'bulk' }));
  assert.equal(kept, null);
  // …unless the user ticks overwrite.
  const over = describeAndTagPatch(
    row({ description: 'Hand-written' }),
    input({ description: 'bulk', overwriteDescription: true }),
  );
  assert.equal(over?.description, 'bulk');
  // Whitespace-only counts as missing; an empty entry never blanks a description.
  assert.equal(describeAndTagPatch(row({ description: '   ' }), input({ description: 'bulk' }))?.description, 'bulk');
  assert.equal(describeAndTagPatch(row({ description: 'x' }), input({ overwriteDescription: true })), null);
});

test('one patch can carry both halves, and an identical value is not a write', () => {
  const both = describeAndTagPatch(row(), input({ description: 'FY26 invoices', tags: ['invoices'] }));
  assert.deepEqual(both, { tags: ['invoices'], description: 'FY26 invoices' });
  assert.equal(describeAndTagPatch(row({ description: 'FY26', tags: ['invoices'] }), input({ description: 'FY26', tags: ['invoices'], overwriteDescription: true })), null);
});

test('the patch is exactly what the gate asks for — a described, tagged file passes', async () => {
  const { promotionGate } = await import('@tabs/files/lib/promotion');
  const r = row({ tags: [] });
  const p = describeAndTagPatch(r, input({ description: 'Supplier invoices, FY26', tags: ['invoices'] }));
  const after = { owner: 'amir', domain: 'sales', description: p?.description ?? r.description, tags: p?.tags ?? r.tags };
  assert.equal(promotionGate(after).ok, true);
});
