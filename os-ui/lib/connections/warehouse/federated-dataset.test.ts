/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFederatedDataset } from './federated-dataset.ts';
import { WarehouseError } from './types.ts';

test('maps an OM/Glue table descriptor to a read-only federated dataset', () => {
  const fd = toFederatedDataset({
    catalog: 'glue_sales',
    platform: 'glue',
    domain: 'sales',
    descriptor: {
      schema: 'public',
      table: 'orders',
      description: 'Raw orders',
      columns: [
        { name: 'id', dataType: 'bigint' },
        { name: 'amount', dataType: 'decimal', description: 'order total' },
      ],
    },
  });
  assert.equal(fd.kind, 'federated');
  assert.equal(fd.id, 'federated:glue_sales.public.orders');
  assert.equal(fd.fqn, 'glue_sales.public.orders');
  assert.equal(fd.name, 'orders');
  assert.equal(fd.catalog, 'glue_sales');
  assert.equal(fd.schema, 'public');
  assert.equal(fd.table, 'orders');
  assert.equal(fd.platform, 'glue');
  assert.equal(fd.domain, 'sales');
  assert.equal(fd.description, 'Raw orders');
  assert.equal(fd.columns.length, 2);
  assert.equal(fd.readOnly, true);
});

test('defaults description and columns when the descriptor omits them', () => {
  const fd = toFederatedDataset({
    catalog: 'glue_sales',
    platform: 'glue',
    domain: 'sales',
    descriptor: { schema: 'public', table: 'customers' },
  });
  assert.equal(fd.description, '');
  assert.deepEqual(fd.columns, []);
});

test('rejects a malformed table (fails closed, no nonsense entry)', () => {
  assert.throws(
    () =>
      toFederatedDataset({
        catalog: 'glue_sales',
        platform: 'glue',
        domain: 'sales',
        descriptor: { schema: 'public', table: 'bad table' },
      }),
    WarehouseError,
  );
});
