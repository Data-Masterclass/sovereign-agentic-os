/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  classifyType,
  statsSql,
  topValuesSql,
  previewSql,
  parseDescribe,
  assembleProfile,
  nullsAlias,
  distinctAlias,
  minAlias,
  maxAlias,
  ROW_COUNT_ALIAS,
  type ProfileColumn,
} from './profile.ts';
import { versionTarget } from './store-fqn.ts';
import { parseDataset } from './dataset-schema.ts';
import type { QueryResult } from '../governed.ts';

const COLS: ProfileColumn[] = [
  { name: 'order_id', type: 'bigint' },
  { name: 'region', type: 'varchar(32)' },
  { name: 'ordered_at', type: 'timestamp(6)' },
  { name: 'active', type: 'boolean' },
];

// A single statement = exactly one top-level statement, no stray `;`.
function isSingleStatement(sql: string): void {
  assert.equal(sql.trim().endsWith(';'), false, 'no trailing semicolon');
  assert.equal((sql.match(/;/g) ?? []).length, 0, 'contains no statement separators');
  assert.match(sql.trim(), /^select\b/i, 'is a SELECT');
}

test('classifyType maps Trino types to the profiling kind (parametrised included)', () => {
  assert.equal(classifyType('bigint'), 'numeric');
  assert.equal(classifyType('decimal(10,2)'), 'numeric');
  assert.equal(classifyType('DOUBLE'), 'numeric');
  assert.equal(classifyType('timestamp(6)'), 'temporal');
  assert.equal(classifyType('date'), 'temporal');
  assert.equal(classifyType('boolean'), 'boolean');
  assert.equal(classifyType('varchar(255)'), 'string');
  assert.equal(classifyType('row(a int)'), 'other');
});

test('statsSql is one SELECT with row count + null/distinct per column, min/max only for ranged types', () => {
  const sql = statsSql('iceberg.sales.bronze_orders', COLS);
  isSingleStatement(sql);
  assert.match(sql, new RegExp(`count\\(\\*\\) as ${ROW_COUNT_ALIAS}\\b`));
  COLS.forEach((_, i) => {
    assert.match(sql, new RegExp(`as ${nullsAlias(i)}\\b`), `nulls alias ${i}`);
    assert.match(sql, new RegExp(`as ${distinctAlias(i)}\\b`), `distinct alias ${i}`);
    assert.match(sql, new RegExp(`as ${minAlias(i)}\\b`), `min alias ${i}`);
    assert.match(sql, new RegExp(`as ${maxAlias(i)}\\b`), `max alias ${i}`);
  });
  // Numeric/temporal columns compute a real min(); the varchar column gets NULL.
  assert.match(sql, /min\("order_id"\)/);
  assert.match(sql, /min\("ordered_at"\)/);
  assert.match(sql, new RegExp(`cast\\(null as varchar\\) as ${minAlias(1)}`)); // region (varchar)
  assert.match(sql, new RegExp(`cast\\(null as varchar\\) as ${minAlias(3)}`)); // active (boolean)
  assert.match(sql, /from iceberg\.sales\.bronze_orders$/);
});

test('topValuesSql is one SELECT, one union-all branch per column, capped at K', () => {
  const sql = topValuesSql('iceberg.sales.bronze_orders', COLS, 5)!;
  isSingleStatement(sql);
  assert.equal((sql.match(/union all/g) ?? []).length, COLS.length - 1, 'one branch per column');
  assert.match(sql, /rn <= 5/);
  assert.match(sql, /'order_id' as col/);
  assert.equal(topValuesSql('iceberg.x.y', []), null, 'no columns → null (nothing to rank)');
});

test('previewSql is a single bounded SELECT *', () => {
  const sql = previewSql('iceberg.sales.bronze_orders', 50);
  isSingleStatement(sql);
  assert.match(sql, /select \* from iceberg\.sales\.bronze_orders limit 50/);
});

test('identifier + literal escaping — a hostile column name cannot break the statement', () => {
  const nasty: ProfileColumn[] = [{ name: 'a"b) ; drop', type: 'varchar' }];
  const s = statsSql('iceberg.s.t', nasty);
  assert.match(s, /"a""b\) ; drop"/, 'double-quote in ident is doubled');
  const t = topValuesSql('iceberg.s.t', [{ name: "o'brien", type: 'varchar' }], 5)!;
  assert.match(t, /'o''brien' as col/, 'single-quote in literal is doubled');
  isSingleStatement(t);
});

test('versionTarget resolves the physical FQN per layer (same name the adapters write)', () => {
  // A NON-owner viewing a domain asset reads the promoted copy from the domain schema.
  const d = parseDataset({ name: 'North Peak Orders', domain: 'sales', owner: 'amir', tier: 'asset' });
  const other = { id: 'someone_else' };
  assert.equal(versionTarget(d, 'bronze', other), 'iceberg.sales.bronze_north_peak_orders');
  assert.equal(versionTarget(d, 'silver', other), 'iceberg.sales.silver_north_peak_orders');
  assert.equal(versionTarget(d, 'gold', other), 'iceberg.sales.gold_north_peak_orders');
});

test('parseDescribe + assembleProfile fold raw query rows into a governed Profile', () => {
  const columns = parseDescribe({
    engine: 'trino', tables: [], rowCount: 2,
    columns: ['Column', 'Type', 'Extra', 'Comment'],
    rows: [['order_id', 'bigint', '', ''], ['region', 'varchar', '', '']],
  });
  assert.deepEqual(columns, [{ name: 'order_id', type: 'bigint' }, { name: 'region', type: 'varchar' }]);

  const statsRes: QueryResult = {
    engine: 'trino', tables: [], rowCount: 1,
    columns: [ROW_COUNT_ALIAS, nullsAlias(0), distinctAlias(0), minAlias(0), maxAlias(0), nullsAlias(1), distinctAlias(1), minAlias(1), maxAlias(1)],
    rows: [['100', '0', '100', '1', '100', '25', '4', 'None', 'None']],
  };
  const topRes: QueryResult = {
    engine: 'trino', tables: [], rowCount: 2,
    columns: ['col', 'val', 'cnt'],
    rows: [['region', 'EU', '40'], ['region', 'US', '35']],
  };
  const previewRes: QueryResult = {
    engine: 'trino', tables: [], rowCount: 1, columns: ['order_id', 'region'], rows: [['1', 'EU']],
  };

  const p = assembleProfile({ fqn: 'iceberg.sales.bronze_orders', layer: 'bronze', columns, statsRes, topRes, previewRes });
  assert.equal(p.rowCount, 100);
  const region = p.columns.find((c) => c.name === 'region')!;
  assert.equal(region.nulls, 25);
  assert.equal(region.nullPct, 0.25); // 25 / 100 — the known-dirty-column signal
  assert.equal(region.distinct, 4);
  assert.equal(region.min, null); // 'None' → null (masked/non-ranged)
  assert.deepEqual(region.top, [{ value: 'EU', count: 40 }, { value: 'US', count: 35 }]);
  const orderId = p.columns.find((c) => c.name === 'order_id')!;
  assert.equal(orderId.nullPct, 0);
  assert.equal(orderId.min, '1');
  assert.equal(orderId.max, '100');
});

test('assembleProfile degrades gracefully when top-values were skipped (null)', () => {
  const statsRes: QueryResult = {
    engine: 'trino', tables: [], rowCount: 1,
    columns: [ROW_COUNT_ALIAS, nullsAlias(0), distinctAlias(0), minAlias(0), maxAlias(0)],
    rows: [['10', '3', '7', 'None', 'None']],
  };
  const previewRes: QueryResult = { engine: 'trino', tables: [], rowCount: 0, columns: ['x'], rows: [] };
  const p = assembleProfile({
    fqn: 'iceberg.s.t', layer: 'bronze',
    columns: [{ name: 'x', type: 'varchar' }], statsRes, topRes: null, previewRes,
  });
  assert.equal(p.columns[0].nulls, 3);
  assert.deepEqual(p.columns[0].top, []);
});

// -- Route guard tripwire: handlers can't import `next` under node --test, so we
// -- assert the profile GET wires its OWN gates (mirrors security-route-guards.test.ts).
const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const routeSrc = readFileSync(resolve(OSUI, 'app/api/data/datasets/[id]/profile/route.ts'), 'utf8');

test('profile route rejects an anonymous caller (401) and a non-viewer (403)', () => {
  // requirePrincipal() throws the 401-tagged error for anon callers.
  assert.match(routeSrc, /requirePrincipal\(\)/, 'gates on a session (401 for anon)');
  // getDataset(id, user) is the canView guard — throws 403 for a non-viewer.
  assert.match(routeSrc, /getDataset\(id, user\)/, 'view-scope guard (403 for a non-viewer)');
  // Tagged auth statuses (401/403) are folded into the response, not swallowed.
  assert.match(routeSrc, /errorResponse\(e\)/, 'surfaces the tagged 401/403 status');
});

test('profile route derives the principal from the session, never the request body', () => {
  assert.match(routeSrc, /user\.domains\[0\] \?\? user\.id/, 'principal comes from the session');
  assert.doesNotMatch(routeSrc, /body\.principal/, 'never trusts a client principal');
  // Reads ride the governed queryRun (so Trino-OPA masking applies) — no direct Trino.
  assert.match(routeSrc, /queryRun\(/, 'profiling SQL runs through the governed path');
});
