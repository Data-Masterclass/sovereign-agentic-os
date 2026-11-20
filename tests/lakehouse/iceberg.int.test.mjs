// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// iceberg.int.test (WP-13; design 10 F16, 06 §5.6): on the pinned Trino + Polaris pair from the
// chart, through the chart's Iceberg REST catalog config:
//   - cross-namespace `ALTER TABLE … RENAME TO` keeps the table's data and snapshot history
//     (the promotion move of 10 F16);
//   - which Iceberg tag/branch DDL the pinned Trino accepts (recorded, 06 §5.6 / PR #26050).
// Results are recorded in components/trino/UPSTREAM.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './lib.mjs';

const as = { user: 'lh-admin', source: 'os-seed/lakehouse-it' };
const q = (sql) => run(sql, as);
const sfx = Date.now().toString(36);
const A = `iceberg.lh_a_${sfx}`;
const B = `iceberg.lh_b_${sfx}`;

test('cross-namespace RENAME TO keeps data and snapshots (10 F16)', async () => {
  await q(`CREATE SCHEMA ${A}`);
  await q(`CREATE SCHEMA ${B}`);
  await q(`CREATE TABLE ${A}.po (id integer, v varchar)`);
  await q(`INSERT INTO ${A}.po VALUES (1, 'a'), (2, 'b')`);
  await q(`INSERT INTO ${A}.po VALUES (3, 'c')`);
  // As varchar: a snapshot id exceeds 2^53, which a JS number cannot hold.
  const before = (await q(`SELECT CAST(snapshot_id AS varchar) FROM ${A}."po$snapshots" ORDER BY committed_at`)).rows.map((r) => String(r[0]));
  assert.ok(before.length >= 2, 'two inserts give at least two snapshots');

  await q(`ALTER TABLE ${A}.po RENAME TO ${B}.po`);

  assert.deepEqual((await q(`SELECT id, v FROM ${B}.po ORDER BY id`)).rows, [[1, 'a'], [2, 'b'], [3, 'c']]);
  const after = (await q(`SELECT CAST(snapshot_id AS varchar) FROM ${B}."po$snapshots" ORDER BY committed_at`)).rows.map((r) => String(r[0]));
  assert.deepEqual(after, before, 'the snapshot history moved with the table');
  // Time travel to the snapshot of the first insert (the one before the last) still works after
  // the move. (CREATE TABLE writes an empty snapshot of its own first.)
  assert.equal((await q(`SELECT count(*) FROM ${B}.po FOR VERSION AS OF ${before.at(-2)}`)).rows[0][0], 2);
  // Twin: the old name is gone.
  await assert.rejects(q(`SELECT 1 FROM ${A}.po`), /does not exist/);
});

test('tag and branch DDL on the pinned Trino (recorded, not required)', async (t) => {
  await q(`CREATE TABLE ${B}.tg (id integer)`);
  await q(`INSERT INTO ${B}.tg VALUES (1)`);
  const probes = {
    'CREATE TAG': `ALTER TABLE ${B}.tg EXECUTE create_tag(name => 'certified-1')`,
    'ALTER TABLE … CREATE TAG': `ALTER TABLE ${B}.tg CREATE TAG "certified-1"`,
    'CREATE BRANCH': `CREATE BRANCH audit IN TABLE ${B}.tg`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(probes)) {
    try { await q(sql); result[name] = 'accepted'; } catch (e) { result[name] = `rejected: ${e.message.slice(0, 120)}`; }
  }
  const refs = (await q(`SELECT name, type FROM ${B}."tg$refs" ORDER BY name`)).rows;
  t.diagnostic(`tag/branch DDL: ${JSON.stringify(result)}; refs: ${JSON.stringify(refs)}`);
  // The refs table is readable on every supported version (06 §2.2).
  assert.ok(refs.some(([n, ty]) => n === 'main' && ty === 'BRANCH'));
});
