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

test('sqlTableRefs: a CTE with a column list is a CTE, not a table', () => {
  // Each CTE name — the one with a column list and the plain ones after it — is local.
  assert.deepEqual(
    tables('WITH inv(a,b) AS (VALUES (1,2)), bench AS (SELECT 1) SELECT * FROM inv JOIN iceberg.s.t ON true'),
    ['iceberg.s.t'],
  );
  assert.deepEqual(
    tables('WITH inv(a, b) AS (SELECT * FROM a.b.c), bench AS (SELECT * FROM inv), r(x) AS (SELECT a FROM bench) SELECT * FROM r JOIN d.e.f ON true'),
    ['a.b.c', 'd.e.f'],
  );
  // Quoted identifiers in the column list.
  assert.deepEqual(tables('WITH inv("a b", "C") AS (VALUES (1, 2)) SELECT * FROM inv, a.b.c'), ['a.b.c']);
  // Nested parentheses in the VALUES body.
  assert.deepEqual(
    tables('WITH inv(a, b) AS (VALUES (1, (2 + (3 * 4))), (coalesce(null, 5), 6)) SELECT * FROM inv JOIN a.b.c ON true'),
    ['a.b.c'],
  );
  // A RECURSIVE CTE (Trino requires the column list) reads itself, not an outer table.
  assert.deepEqual(tables('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<3) SELECT * FROM r'), []);
  assert.deepEqual(
    tables('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<3) SELECT * FROM r JOIN a.b.c ON true'),
    ['a.b.c'],
  );
});

test('sqlTableRefs: a column-list CTE does not hide real tables', () => {
  // `name(…)` in FROM is a table function, not a CTE.
  assert.match(refused('SELECT * FROM inv(1)'), /table function inv/);
  // A table read inside the CTE body, and one after the WITH clause, are still reported.
  assert.deepEqual(tables('WITH inv(a) AS (SELECT x FROM s.t.secret) SELECT * FROM inv JOIN s.t.other ON true'), ['s.t.secret', 's.t.other']);
  // A non-recursive self-reference still reads the outer table of that name.
  assert.deepEqual(tables('WITH orders(id) AS (SELECT id FROM orders) SELECT * FROM orders'), ['orders']);
  // Something that is not an identifier list is not a column list: no CTE is opened.
  assert.deepEqual(tables('WITH inv(1) AS (SELECT 1) SELECT * FROM inv'), ['inv']);
});

test('sqlTableRefs: only the CTE list defines CTEs — a WINDOW definition is not one', () => {
  assert.deepEqual(
    tables('WITH c(a) AS (SELECT 1) SELECT count(*) OVER w1 FROM iceberg.s.g WINDOW w1 AS (), secret AS () UNION ALL SELECT 1 FROM secret'),
    ['iceberg.s.g', 'secret'],
  );
  assert.deepEqual(
    tables('WITH c AS (SELECT 1) SELECT count(*) OVER w1 FROM iceberg.s.g WINDOW w1 AS (), secret AS () UNION ALL SELECT 1 FROM secret'),
    ['iceberg.s.g', 'secret'],
  );
  // A single window, then a set operation.
  assert.deepEqual(
    tables('WITH c AS (SELECT 1) SELECT count(*) OVER secret FROM iceberg.s.g WINDOW secret AS (ORDER BY x) UNION ALL SELECT 1 FROM secret'),
    ['iceberg.s.g', 'secret'],
  );
  // Several windows, with partitions, then a set operation reading each window name as a table.
  assert.deepEqual(
    tables('WITH c(a) AS (SELECT 1) SELECT sum(x) OVER w1, sum(x) OVER w2 FROM iceberg.s.g WINDOW w1 AS (PARTITION BY a), w2 AS (ORDER BY b), w3 AS (w1) UNION SELECT 1 FROM w2 JOIN w3 ON true'),
    ['iceberg.s.g', 'w2', 'w3'],
  );
  // Without any WITH, a window name is never a CTE either.
  assert.deepEqual(
    tables('SELECT count(*) OVER w1 FROM iceberg.s.g WINDOW w1 AS (), secret AS () UNION ALL SELECT 1 FROM secret'),
    ['iceberg.s.g', 'secret'],
  );
  // A CTE list still continues across commas between bodies.
  assert.deepEqual(tables('WITH a AS (SELECT 1), b(x) AS (SELECT 2), c AS (SELECT 3) SELECT * FROM a, b, c, d.e.f'), ['d.e.f']);
});

test('sqlTableRefs: RECURSIVE is the keyword only when a CTE definition follows it', () => {
  assert.deepEqual(
    tables('WITH recursive AS (SELECT 1), secret AS (SELECT * FROM secret) SELECT * FROM secret'),
    ['secret'],
  );
  assert.deepEqual(tables('WITH recursive(a) AS (SELECT 1) SELECT * FROM recursive, a.b.c'), ['a.b.c']);
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
