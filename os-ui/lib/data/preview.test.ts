/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createDataset,
  buildVersion,
  getDataset,
  builtLayerFqn,
  transition,
  type Principal,
} from './store.ts';
import { runPreview, clampLimit, PREVIEW_MAX_LIMIT, PREVIEW_DEFAULT_LIMIT } from './preview.ts';
import type { QueryResult } from '../governed.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'admin' };

beforeEach(() => __resetStore());

/** A fake governed query that records the SQL it was asked to run and returns rows. */
function fakeQuery(rows: string[][], columns: string[] = ['a', 'b']) {
  const calls: string[] = [];
  const query = async (sql: string): Promise<QueryResult> => {
    calls.push(sql);
    return { engine: 'trino', tables: [], columns, rows, rowCount: rows.length };
  };
  return { query, calls };
}

test('runPreview runs a bounded SELECT * over the resolved FQN and returns the rows', async () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });

  // The route resolves the physical table SERVER-SIDE, tier-aware (governed scope).
  const target = builtLayerFqn(getDataset(d.id, amir), amir);
  assert.ok(target, 'a built layer resolves to a physical FQN');
  // A private dataset lives in the caller's OWN personal lane — not a shared schema.
  assert.equal(target!.layer, 'bronze');
  assert.match(target!.fqn, /^iceberg\.personal_amir\.bronze_orders$/);

  const { query, calls } = fakeQuery([['1', 'x'], ['2', 'y']]);
  const out = await runPreview({ target, limit: 50, query });

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'select * from iceberg.personal_amir.bronze_orders limit 50');
  assert.equal(out.available, true);
  if (out.available) {
    assert.equal(out.rowCount, 2);
    assert.deepEqual(out.columns, ['a', 'b']);
    assert.equal(out.limit, 50);
  }
});

test('runPreview resolves a promoted asset to its DOMAIN schema (governed lane)', async () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  transition(d.id, bea, 'promote', { visibility: 'domain' }); // admin promotes → tier asset (sales)

  const target = builtLayerFqn(getDataset(d.id, amir), amir);
  assert.ok(target);
  assert.match(target!.fqn, /^iceberg\.sales\.silver_orders$/); // domain schema, not personal lane
});

test('runPreview: nothing built → calm not-materialized, never a query', async () => {
  const d = createDataset(amir, { name: 'Draft' }); // nothing built
  const target = builtLayerFqn(getDataset(d.id, amir), amir);
  assert.equal(target, null);

  const { query, calls } = fakeQuery([]);
  const out = await runPreview({ target, query });
  assert.equal(calls.length, 0, 'no doomed query is issued');
  assert.equal(out.available, false);
  if (!out.available) assert.match(out.reason, /materialized yet/i);
});

test('runPreview: a TABLE_NOT_FOUND is answered honestly, not surfaced raw', async () => {
  const target = { layer: 'bronze', fqn: 'iceberg.sales.bronze_northpeak_cac_cos_weekly' };
  const query = async (): Promise<QueryResult> => {
    throw new Error(
      'TrinoUserError TABLE_NOT_FOUND: iceberg.sales.bronze_northpeak_cac_cos_weekly does not exist',
    );
  };
  const out = await runPreview({ target, query });
  assert.equal(out.available, false);
  if (!out.available) {
    assert.match(out.reason, /this bronze version/i);
    assert.match(out.reason, /materialized yet/i);
    assert.doesNotMatch(out.reason, /TABLE_NOT_FOUND/); // the raw Trino error never leaks
  }
});

test('runPreview: a genuine engine fault is surfaced honestly (not swallowed as not-materialized)', async () => {
  const target = { layer: 'gold', fqn: 'iceberg.sales.gold_orders' };
  const query = async (): Promise<QueryResult> => {
    throw new Error('Could not reach query-tool');
  };
  const out = await runPreview({ target, query });
  assert.equal(out.available, false);
  if (!out.available) {
    assert.match(out.reason, /could not read/i);
    assert.match(out.reason, /query-tool/);
  }
});

test('clampLimit bounds the scan window', () => {
  assert.equal(clampLimit(50), 50);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(9999), PREVIEW_MAX_LIMIT);
  assert.equal(clampLimit('abc'), PREVIEW_DEFAULT_LIMIT);
});
