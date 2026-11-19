/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Which tables does a read-only SQL statement name? — tests
 * USER STORY: As the owner of an agent system limited to some datasets I want the table check
 *             to find every table a query reads, or refuse — never a partial list.
 * ARCHITECTURE:
 *   - Pure tests of `sqlTableRefs`: what it lists, and what it refuses with the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlTableRefs } from '@tabs/agents/lib/build/sql-tables';

const tables = (sql: string): string[] => {
  const r = sqlTableRefs(sql);
  assert.ok(r.ok, `expected a table list for: ${sql} — got: ${r.ok ? '' : r.reason}`);
  return r.ok ? r.tables : [];
};
const refused = (sql: string): string => {
  const r = sqlTableRefs(sql);
  assert.ok(!r.ok, `expected a refusal for: ${sql} — got: ${r.ok ? r.tables.join(', ') : ''}`);
  return r.ok ? '' : r.reason;
};

test('sqlTableRefs: FROM, JOIN and comma joins, qualified and quoted', () => {
  assert.deepEqual(tables('SELECT * FROM iceberg.sales.gold_orders'), ['iceberg.sales.gold_orders']);
  assert.deepEqual(
    tables('select o.id from iceberg.sales.gold_orders o left join "iceberg"."sales"."GOLD_Customers" c on o.c = c.id'),
    ['iceberg.sales.gold_orders', 'iceberg.sales.gold_customers'],
  );
  assert.deepEqual(tables('SELECT 1 FROM a.b.c x, d.e.f AS y WHERE x.k = y.k'), ['a.b.c', 'd.e.f']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c JOIN d.e.f ON 1=1, g.h.i'), ['a.b.c', 'd.e.f', 'g.h.i']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c;'), ['a.b.c']);
});

test('sqlTableRefs: every nesting level is read — subqueries, scalar subqueries, set operations', () => {
  assert.deepEqual(tables('SELECT * FROM (SELECT * FROM a.b.c) t WHERE x IN (SELECT y FROM d.e.f)'), ['a.b.c', 'd.e.f']);
  assert.deepEqual(tables('SELECT (SELECT max(v) FROM s.t.secret) AS m FROM a.b.c'), ['s.t.secret', 'a.b.c']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c UNION ALL SELECT 2 FROM d.e.f'), ['a.b.c', 'd.e.f']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c WHERE EXISTS (SELECT 1 FROM d.e.f, g.h.i)'), ['a.b.c', 'd.e.f', 'g.h.i']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c WHERE x IN (TABLE d.e.f)'), ['a.b.c', 'd.e.f']);
});

test('sqlTableRefs: a relation in parentheses is still a relation', () => {
  assert.deepEqual(tables('SELECT * FROM (s.t.secret)'), ['s.t.secret']);
  assert.deepEqual(tables('SELECT * FROM ((s.t.secret))'), ['s.t.secret']);
  assert.deepEqual(tables('SELECT * FROM (a.b.c JOIN d.e.f ON 1=1), g.h.i'), ['a.b.c', 'd.e.f', 'g.h.i']);
  assert.deepEqual(tables('SELECT * FROM a.b.c JOIN (d.e.f CROSS JOIN g.h.i) ON 1=1'), ['a.b.c', 'd.e.f', 'g.h.i']);
  assert.deepEqual(tables('SELECT * FROM (VALUES (1), (2)) AS t(x)'), []);
  assert.deepEqual(tables('SELECT * FROM a.b.c, LATERAL (SELECT * FROM d.e.f) l'), ['a.b.c', 'd.e.f']);
});

test('sqlTableRefs: a CTE is local only after its body closed', () => {
  assert.deepEqual(tables('WITH t AS (SELECT * FROM a.b.c) SELECT * FROM t'), ['a.b.c']);
  assert.deepEqual(tables('WITH t AS (SELECT * FROM a.b.c), u AS (SELECT * FROM t) SELECT * FROM u JOIN t ON 1=1'), ['a.b.c']);
  // `b` is used before it is defined: inside `a` it is the OUTER table b, and must be reported.
  assert.deepEqual(tables('WITH a AS (SELECT * FROM b), b AS (SELECT 1 FROM x.y.z) SELECT * FROM a'), ['b', 'x.y.z']);
  // A self-reference is reported (a non-recursive CTE reads the outer table of that name).
  assert.deepEqual(tables('WITH orders AS (SELECT * FROM orders) SELECT * FROM orders'), ['orders']);
});

test('sqlTableRefs: FROM inside an expression is not a relation', () => {
  assert.deepEqual(tables('SELECT extract(year FROM ts), substring(n FROM 1 FOR 2), trim(both \' \' FROM n) FROM a.b.c'), ['a.b.c']);
  assert.deepEqual(tables('SELECT 1 FROM a.b.c WHERE x IS NOT DISTINCT FROM y AND z IS DISTINCT FROM w'), ['a.b.c']);
  // …but a subquery inside one still is.
  assert.deepEqual(tables('SELECT extract(year FROM (SELECT max(ts) FROM s.t.secret)) FROM a.b.c'), ['s.t.secret', 'a.b.c']);
});

test('sqlTableRefs: a table name hidden in a string, a comment or an alias is not a relation', () => {
  assert.deepEqual(tables("SELECT 'from s.t.secret' AS x FROM a.b.c -- from s.t.other\n"), ['a.b.c']);
  assert.deepEqual(tables('SELECT 1 /* join s.t.secret */ FROM a.b.c'), ['a.b.c']);
  assert.deepEqual(tables('SELECT x FROM a.b.c CROSS JOIN UNNEST(arr) AS u(x)'), ['a.b.c']);
});

test('sqlTableRefs: REFUSES what it cannot follow, and says why', () => {
  assert.match(refused('SHOW TABLES FROM iceberg.sales'), /not a SELECT/);
  assert.match(refused('DESCRIBE iceberg.sales.gold_orders'), /not a SELECT/);
  assert.match(refused('DELETE FROM a.b.c'), /not a SELECT/);
  assert.match(refused('SELECT * FROM TABLE(system.query(query => \'select 1\'))'), /table function/i);
  assert.match(refused('SELECT * FROM pg.system.query(1)'), /table function/);
  assert.match(refused('SELECT 1 FROM a.b.c; SELECT 1 FROM d.e.f'), /more than one statement/);
  assert.match(refused('SELECT * FROM (WITH t AS (SELECT 1 FROM s.t.secret) SELECT * FROM t)'), /nested WITH/);
  assert.match(refused("SELECT 'abc FROM a.b.c"), /unterminated string/);
  assert.match(refused('SELECT 1 FROM a.b.c)'), /parentheses/);
});
