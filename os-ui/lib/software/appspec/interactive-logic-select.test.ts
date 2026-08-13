/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * interactive-logic-select.test — the PURE grid→options / grid→rows helpers for assignment,
 * approval-queue and task-checklist. Pins: stable-key selection (id-like column preferred),
 * label-field-not-a-column → typed error (not a throw), records-as-grid tabularization.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyColumnIndex, pickOptions, pickSourceRows, recordsToGrid } from './interactive-logic-select.ts';
import type { QueryResult } from '@/lib/app-sdk/index.ts';

function grid(columns: string[], rows: string[][]): QueryResult {
  return { columns, rows, rowCount: rows.length };
}

test('keyColumnIndex prefers an id-like column, else column 0', () => {
  assert.equal(keyColumnIndex(['name', 'case_id', 'x']), 1);
  assert.equal(keyColumnIndex(['id', 'name']), 0);
  assert.equal(keyColumnIndex(['name', 'email']), 0); // no id-like → first column
  assert.equal(keyColumnIndex([]), -1);
});

test('pickOptions maps value=stable-key, label=label field', () => {
  const g = grid(['case_id', 'case_name'], [['c1', 'Fraud review'], ['c2', 'Refund']]);
  const { options, error } = pickOptions(g, 'case_name');
  assert.equal(error, undefined);
  assert.deepEqual(options, [
    { value: 'c1', label: 'Fraud review' },
    { value: 'c2', label: 'Refund' },
  ]);
});

test('pickOptions returns a typed error when the label field is not a column', () => {
  const g = grid(['id', 'name'], [['1', 'A']]);
  const { options, error } = pickOptions(g, 'missing');
  assert.deepEqual(options, []);
  assert.match(error ?? '', /not in this dataset/);
  assert.match(error ?? '', /id, name/);
});

test('pickOptions on an empty/undefined result yields no options (no fabrication)', () => {
  assert.deepEqual(pickOptions(undefined, 'x').options, []);
  assert.deepEqual(pickOptions(grid(['id', 'name'], []), 'name').options, []);
});

test('pickSourceRows builds id/title/subtitle; joins subtitle fields', () => {
  const g = grid(['req_id', 'title', 'team', 'when'], [['r1', 'Budget', 'Sales', 'Q3']]);
  const { rows, error } = pickSourceRows(g, 'title', ['team', 'when']);
  assert.equal(error, undefined);
  assert.deepEqual(rows, [{ id: 'r1', title: 'Budget', subtitle: 'Sales · Q3' }]);
});

test('pickSourceRows errors when titleField is not a column', () => {
  const { error } = pickSourceRows(grid(['id', 'x'], [['1', 'y']]), 'nope');
  assert.match(error ?? '', /not in this dataset/);
});

test('recordsToGrid tabularizes the app records (union of keys, first-seen order)', () => {
  const g = recordsToGrid([
    { id: '1', title: 'A', team: 'Sales' },
    { id: '2', title: 'B' }, // missing team → ''
  ]);
  assert.deepEqual(g.columns, ['id', 'title', 'team']);
  assert.deepEqual(g.rows, [['1', 'A', 'Sales'], ['2', 'B', '']]);
  assert.equal(g.rowCount, 2);
});
