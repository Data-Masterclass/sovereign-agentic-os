/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCheck, violationPredicate, failingRowsSql, passingRowsSql, DqError } from './dq.ts';
import {
  ROWS_THRESHOLD,
  columnFixable,
  resolveRowIdentity,
  rowsEligibility,
  parseModelJson,
  coerceProposal,
  coerceRowsFill,
  batchMergeSql,
  rowsMergeSql,
  fixPreviewSql,
  residualSql,
  acceptedCount,
  decisionsToFixes,
  type RowDecision,
} from './dq-fix.ts';
import type { DataCheck } from './dataset-schema.ts';

const FQN = 'iceberg.sales.gold_orders';
function chk(over: Partial<DataCheck>): DataCheck {
  return { id: 'c1', name: '', description: '', createdBy: 'amir', createdAt: '', ...over };
}

// The execute-guard MERGE shape (execute_guard.py _RE_MERGE), ported byte-for-byte so
// the builders can never drift from what the query-tool accepts.
const IDENT = '[a-z_][a-z0-9_]*';
const GUARD_MERGE = new RegExp(
  `^merge\\s+into\\s+iceberg\\.(${IDENT})\\.(${IDENT})(?:\\s+(?:as\\s+)?${IDENT})?` +
  `\\s+using\\s+[\\s\\S]*\\bon\\b[\\s\\S]*\\bwhen\\b[\\s\\S]*$`,
  'i',
);

// ---- the ONE violation predicate ---------------------------------------------

test('violationPredicate: compileCheck and the predicate can never drift', () => {
  for (const c of [
    chk({ rule: 'not_null', column: 'id' }),
    chk({ rule: 'not_blank', column: 'name' }),
    chk({ rule: 'accepted_values', column: 'region', values: ['EU', 'US'] }),
    chk({ rule: 'range', column: 'qty', min: 0, max: 10 }),
  ]) {
    const pred = violationPredicate(c);
    assert.ok(pred, `predicate exists for ${c.rule}`);
    assert.equal(compileCheck(c, FQN).sql, `select count(*) as v from ${FQN} where ${pred}`);
  }
});

test('violationPredicate: null for unique/free-text; ref substitution works', () => {
  assert.equal(violationPredicate(chk({ rule: 'unique', column: 'id' })), null);
  assert.equal(violationPredicate(chk({})), null);
  assert.equal(violationPredicate(chk({ rule: 'not_null', column: 'id' }), 't."id"'), 't."id" is null');
});

test('failingRowsSql: row-shaped rules select by the predicate, capped', () => {
  assert.equal(
    failingRowsSql(chk({ rule: 'not_null', column: 'id' }), FQN, 100),
    `select * from ${FQN} where "id" is null limit 100`,
  );
});

test('failingRowsSql: unique samples the duplicate groups; passingRowsSql is null', () => {
  const sql = failingRowsSql(chk({ rule: 'unique', column: 'id' }), FQN, 50);
  assert.match(sql, /group by "id" having count\(\*\) > 1/);
  assert.match(sql, /order by "id" limit 50/);
  assert.equal(passingRowsSql(chk({ rule: 'unique', column: 'id' }), FQN, 5), null);
});

test('passingRowsSql: the NOT of the violation predicate', () => {
  assert.equal(
    passingRowsSql(chk({ rule: 'not_null', column: 'id' }), FQN, 5),
    `select * from ${FQN} where not ("id" is null) limit 5`,
  );
});

// ---- row identity: declared, never guessed ------------------------------------

test('resolveRowIdentity: only a DECLARED unique column counts; not_null-backed preferred', () => {
  const cols = ['order_id', 'email', 'region'];
  assert.equal(resolveRowIdentity([], cols), null, 'no declaration ⇒ no identity, never guessed');
  const uniqueOnly = [chk({ id: 'u1', rule: 'unique', column: 'email' })];
  assert.equal(resolveRowIdentity(uniqueOnly, cols), 'email');
  const both = [
    chk({ id: 'u1', rule: 'unique', column: 'email' }),
    chk({ id: 'u2', rule: 'unique', column: 'order_id' }),
    chk({ id: 'n1', rule: 'not_null', column: 'order_id' }),
  ];
  assert.equal(resolveRowIdentity(both, cols), 'order_id', 'unique + not_null wins');
  assert.equal(
    resolveRowIdentity([chk({ rule: 'unique', column: 'ghost' })], cols),
    null,
    'a unique rule on a column that is not physically present is not an identity',
  );
});

test('rowsEligibility: threshold, key-column self-fix and missing identity are refused honestly', () => {
  const checks = [chk({ id: 'u1', rule: 'unique', column: 'order_id' })];
  const cols = ['order_id', 'region'];
  const target = chk({ id: 'c2', rule: 'accepted_values', column: 'region', values: ['EU'] });

  const ok = rowsEligibility(target, checks, cols, 50);
  assert.deepEqual(ok, { ok: true, pk: 'order_id' });

  const over = rowsEligibility(target, checks, cols, ROWS_THRESHOLD + 1);
  assert.equal(over.ok, false);
  assert.match((over as { reason: string }).reason, /batch mode/);

  const noId = rowsEligibility(target, [], cols, 5);
  assert.equal(noId.ok, false);
  assert.match((noId as { reason: string }).reason, /unique rule on your key column/, 'the Define hint');

  const selfFix = rowsEligibility(chk({ id: 'c3', rule: 'not_null', column: 'order_id' }), checks, cols, 5);
  assert.equal(selfFix.ok, false);

  const notFixable = rowsEligibility(chk({ id: 'u1', rule: 'unique', column: 'order_id' }), checks, cols, 5);
  assert.equal(notFixable.ok, false);
  assert.equal(columnFixable(chk({ rule: 'unique', column: 'x' })), false);
});

// ---- model-reply parsing -------------------------------------------------------

test('parseModelJson: strips fences, survives garbage', () => {
  assert.deepEqual(parseModelJson('```json\n{"kind":"none","diagnosis":"d"}\n```'), { kind: 'none', diagnosis: 'd' });
  assert.equal(parseModelJson('not json at all'), null);
});

test('coerceProposal: batch validates the expression through the fix guard', () => {
  const opts = { allowBatch: true, allowRows: false, column: 'region', columns: ['region', 'order_id'] };
  const good = coerceProposal({ kind: 'batch', sqlExpr: 'upper(region)', rationale: 'normalise' }, opts);
  assert.deepEqual(good, { kind: 'batch', sqlExpr: 'upper(region)', rationale: 'normalise' });
  assert.equal(
    coerceProposal({ kind: 'batch', sqlExpr: '(select 1 from t)', rationale: 'x' }, opts),
    null,
    'statement smuggling in sqlExpr is refused',
  );
});

test('coerceProposal: rows only when the server allows; column is never trusted from the model', () => {
  const opts = { allowBatch: true, allowRows: true, column: 'region', columns: ['region', 'order_id'] };
  const p = coerceProposal(
    { kind: 'rows', fixes: [{ pk: 'o1', column: 'HACKED', current: 'EMEA', proposed: 'EU' }, { bad: true }] },
    opts,
  );
  assert.equal(p?.kind, 'rows');
  if (p?.kind === 'rows') {
    assert.equal(p.fixes.length, 1, 'malformed fixes dropped');
    assert.equal(p.fixes[0].column, 'region', 'the checked column wins');
  }
  assert.equal(coerceProposal({ kind: 'rows', fixes: [{ pk: 'o1', proposed: 'EU' }] }, { ...opts, allowRows: false }), null);
  assert.equal(coerceRowsFill([{ pk: 'o1', proposed: 'EU' }, 42], 'region').length, 1);
});

// ---- governed SQL builders -----------------------------------------------------

test('batchMergeSql: touches ONLY violating rows and matches the execute-guard shape', () => {
  const sql = batchMergeSql(FQN, chk({ rule: 'not_blank', column: 'email' }), 'trim(lower(email))');
  assert.match(sql, GUARD_MERGE, 'guard-compatible MERGE');
  assert.match(sql, /on \(t\."email" is null or trim\(cast\(t\."email" as varchar\)\) = ''\)/);
  assert.match(sql, /update set "email" = trim\(lower\(email\)\)/);
  assert.throws(() => batchMergeSql(FQN, chk({ rule: 'unique', column: 'id' }), 'x'), DqError);
});

test('rowsMergeSql: literals escaped, types cast, threshold enforced, guard-compatible', () => {
  const sql = rowsMergeSql(
    FQN,
    { name: 'order_id', type: 'bigint' },
    { name: 'region', type: 'varchar' },
    [{ pk: '12', proposed: "O'Brien" }],
  );
  assert.match(sql, GUARD_MERGE, 'guard-compatible MERGE');
  assert.match(sql, /values \('12', 'O''Brien'\)/, 'quote-escaped literals');
  assert.match(sql, /on t\."order_id" = cast\(s\.k as bigint\)/);
  assert.match(sql, /update set "region" = cast\(s\.v as varchar\)/);
  assert.throws(() => rowsMergeSql(FQN, { name: 'k', type: 'bigint' }, { name: 'v', type: 'varchar' }, []), DqError);
  assert.throws(
    () =>
      rowsMergeSql(
        FQN,
        { name: 'k', type: 'bigint' },
        { name: 'v', type: 'varchar' },
        Array.from({ length: ROWS_THRESHOLD + 1 }, (_, i) => ({ pk: String(i), proposed: 'x' })),
      ),
    DqError,
  );
  assert.throws(
    () => rowsMergeSql(FQN, { name: 'k', type: "bigint'); drop" }, { name: 'v', type: 'varchar' }, [{ pk: '1', proposed: 'x' }]),
    DqError,
    'an evil cast type is refused',
  );
});

test('fixPreviewSql + residualSql: read-only, predicate-substituted (measured, not trusted)', () => {
  const c = chk({ rule: 'range', column: 'qty', min: 0 });
  const prev = fixPreviewSql(FQN, c, 'greatest(qty, 0)', 20);
  assert.match(prev, /^select cast\("qty" as varchar\) as current_value, cast\(greatest\(qty, 0\) as varchar\) as proposed_value/);
  assert.match(prev, /limit 20$/);
  const res = residualSql(FQN, c, 'greatest(qty, 0)');
  assert.match(res, /select greatest\(qty, 0\) as "_fixed" from/);
  assert.match(res, /where "_fixed" is not null and \("_fixed" < 0\)$/);
});

// ---- table decisions (the UI's pure logic) -------------------------------------

test('acceptedCount + decisionsToFixes: accepted + edited count; skipped and undecided do not', () => {
  const fixes = [
    { pk: 'a', column: 'r', current: 'x', proposed: 'X' },
    { pk: 'b', column: 'r', current: 'y', proposed: 'Y' },
    { pk: 'c', column: 'r', current: 'z', proposed: 'Z' },
  ];
  const decisions: Record<string, RowDecision> = {
    a: { kind: 'accept' },
    b: { kind: 'edit', value: 'Y-manual' },
    c: { kind: 'skip' },
  };
  assert.equal(acceptedCount(decisions), 2);
  assert.deepEqual(decisionsToFixes(fixes, decisions), [
    { pk: 'a', proposed: 'X' },
    { pk: 'b', proposed: 'Y-manual' },
  ]);
  assert.deepEqual(decisionsToFixes(fixes, {}), [], 'undecided rows are never applied');
});
