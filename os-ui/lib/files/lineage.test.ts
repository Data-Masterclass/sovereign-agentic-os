/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordLineage, listLineage, __resetLineage } from './lineage.ts';

beforeEach(() => __resetLineage());

test('records and lists lineage edges, newest first, filterable by file', () => {
  recordLineage({ kind: 'file_promoted', fileId: 'as_1', fileName: 'a.pdf', target: 's3://files/sales/a', by: 'bea', at: '2026-06-30T10:00:00Z' });
  recordLineage({ kind: 'file_certified', fileId: 'as_1', fileName: 'a.pdf', target: 's3://files/sales/a', by: 'sara', at: '2026-06-30T11:00:00Z' });
  recordLineage({ kind: 'file_promoted', fileId: 'as_2', fileName: 'b.pdf', target: 's3://files/sales/b', by: 'bea', at: '2026-06-30T10:30:00Z' });

  const forA = listLineage('as_1');
  assert.equal(forA.length, 2);
  assert.equal(forA[0].kind, 'file_certified'); // newest first
  assert.equal(listLineage().length, 3);
  assert.equal(listLineage('as_2').length, 1);
});
