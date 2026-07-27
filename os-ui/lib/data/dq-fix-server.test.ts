/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { proposeFixes, applyFixes, type FixQueryFn, type AssistantMsg } from './dq-fix-server.ts';
import { __resetRemediations, latestRemediation } from './dq-remediations.ts';
import { DqError } from './dq.ts';
import type { Dataset, DataCheck } from './dataset-schema.ts';

const FQN = 'iceberg.sales.gold_orders';

function chk(over: Partial<DataCheck>): DataCheck {
  return { id: 'c1', name: '', description: '', createdBy: 'amir', createdAt: '', ...over };
}

function dataset(checks: DataCheck[]): Dataset {
  return {
    version: '1', id: 'ds1', name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset',
    visibility: 'shared', folder: '/', description: '', grants: [], measures: [], columns: [],
    versions: { bronze: {} as never, silver: {} as never, gold: {} as never },
    checks,
    ...( {} as Partial<Dataset>),
  } as Dataset;
}

const REGION_CHECK = chk({ id: 'c1', rule: 'accepted_values', column: 'region', values: ['EU', 'US'] });
const IDENTITY = chk({ id: 'u1', rule: 'unique', column: 'order_id' });

/** A scripted governed read executor: answers describe / counts / row samples. */
function fakeQuery(opts: {
  violations?: number | (() => number);
  residual?: number;
  failRows?: string[][];
  passRows?: string[][];
  snapshot?: string | null;
  log?: string[];
}): FixQueryFn {
  return async (sql: string) => {
    opts.log?.push(sql);
    const cols = ['order_id', 'region'];
    if (/^describe/i.test(sql)) return { columns: ['Column', 'Type'], rows: [['order_id', 'bigint'], ['region', 'varchar']] };
    if (/\$snapshots/.test(sql)) {
      if (opts.snapshot === null) throw new Error('no snapshot table');
      return { columns: ['snapshot_id'], rows: [[opts.snapshot ?? 'snap-42']] };
    }
    if (/"_fixed"/.test(sql)) return { columns: ['v'], rows: [[String(opts.residual ?? 0)]] };
    if (/proposed_value/.test(sql)) return { columns: ['current_value', 'proposed_value'], rows: [['EMEA', 'EU']] };
    if (/count\(\*\) as v/.test(sql)) {
      const v = typeof opts.violations === 'function' ? opts.violations() : (opts.violations ?? 0);
      return { columns: ['v'], rows: [[String(v)]] };
    }
    if (/where not \(/.test(sql)) return { columns: cols, rows: opts.passRows ?? [['1', 'EU']] };
    return { columns: cols, rows: opts.failRows ?? [['7', 'EMEA'], ['9', 'apac']] };
  };
}

beforeEach(() => __resetRemediations());

// ------------------------------------------------------------------- propose ---

test('propose: no built layer ⇒ honest not_run, no model call', async () => {
  let called = 0;
  const out = await proposeFixes(dataset([REGION_CHECK]), REGION_CHECK, {
    fqn: null, layer: null, queryFn: fakeQuery({}),
    complete: async () => { called++; return ''; },
  });
  assert.equal(out.status, 'not_run');
  assert.equal(out.proposal, null);
  assert.equal(called, 0);
});

test('propose: a passing rule proposes NOTHING (no invented work, no model call)', async () => {
  let called = 0;
  const out = await proposeFixes(dataset([REGION_CHECK]), REGION_CHECK, {
    fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 0 }),
    complete: async () => { called++; return ''; },
  });
  assert.equal(out.status, 'pass');
  assert.equal(out.sample, null);
  assert.equal(out.proposal, null);
  assert.equal(called, 0);
});

test('propose: model offline ⇒ offline envelope, the REAL sample still shows', async () => {
  const out = await proposeFixes(dataset([REGION_CHECK, IDENTITY]), REGION_CHECK, {
    fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 2 }),
    complete: async () => { throw new Error('The assistant LLM is not configured.'); },
  });
  assert.equal(out.status, 'fail');
  assert.equal(out.offline, true);
  assert.match(out.offlineReason ?? '', /not configured/);
  assert.equal(out.sample?.total, 2, 'failing rows still shown honestly');
  assert.equal(out.rowsEligible, true, 'manual per-row path stays open');
  assert.equal(out.pkColumn, 'order_id');
});

test('propose: batch — expression validated, preview measured, estimatedFix derived by SQL', async () => {
  const log: string[] = [];
  const out = await proposeFixes(dataset([REGION_CHECK]), REGION_CHECK, {
    fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 5, residual: 0, log }),
    complete: async (_msgs: AssistantMsg[], role) => {
      assert.equal(role, 'reasoning');
      return JSON.stringify({ kind: 'batch', sqlExpr: 'upper(region)', rationale: 'normalise case', estimatedFix: 'partial' });
    },
  });
  assert.equal(out.proposal?.kind, 'batch');
  if (out.proposal?.kind === 'batch') {
    assert.equal(out.proposal.estimatedFix, 'all', "measured residual 0 overrides the model's own claim");
  }
  assert.equal(out.preview?.residual, 0);
  assert.deepEqual(out.preview?.pairs, [{ before: 'EMEA', after: 'EU' }]);
  assert.ok(log.some((s) => /"_fixed"/.test(s)), 'the residual was actually measured');
  // no declared identity ⇒ rows-mode refused with the Define hint
  assert.equal(out.rowsEligible, false);
  assert.match(out.rowsIneligibleReason ?? '', /unique rule on your key column/);
});

test('propose: an unsafe model expression is withheld (never offered for apply)', async () => {
  const out = await proposeFixes(dataset([REGION_CHECK]), REGION_CHECK, {
    fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 5 }),
    complete: async () => JSON.stringify({ kind: 'batch', sqlExpr: '(select pw from users)', rationale: 'x' }),
  });
  assert.equal(out.proposal, null);
  assert.match(out.proposalReason ?? '', /usable, safe proposal/);
});

test('propose: rows split — reasoning sets the pattern, the STANDARD model fills the rest', async () => {
  const roles: string[] = [];
  const out = await proposeFixes(dataset([REGION_CHECK, IDENTITY]), REGION_CHECK, {
    fqn: FQN, layer: 'gold',
    queryFn: fakeQuery({ violations: 30, failRows: [['7', 'EMEA'], ['9', 'apac']] }),
    complete: async (_msgs, role) => {
      roles.push(role);
      if (role === 'reasoning') {
        return JSON.stringify({ kind: 'rows', rationale: 'map to the accepted set', fixes: [{ pk: '7', proposed: 'EU', current: 'EMEA' }] });
      }
      return JSON.stringify([
        { pk: '7', proposed: 'EU-std', current: 'EMEA' },
        { pk: '9', proposed: 'US', current: 'apac' },
      ]);
    },
  });
  assert.deepEqual(roles, ['reasoning', 'standard'], 'the smart split ran in order');
  assert.equal(out.proposal?.kind, 'rows');
  if (out.proposal?.kind === 'rows') {
    const byPk = new Map(out.proposal.fixes.map((f) => [f.pk, f.proposed]));
    assert.equal(byPk.get('7'), 'EU', "the reasoning model's explicit fix wins on collision");
    assert.equal(byPk.get('9'), 'US', 'the standard model filled the rest');
  }
});

test('propose: unique rule ⇒ kind:none diagnosis only (no fake column fix)', async () => {
  const out = await proposeFixes(dataset([IDENTITY]), IDENTITY, {
    fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 4 }),
    complete: async (msgs) => {
      assert.ok(!/"kind":"batch"/.test(msgs[0].content), 'batch is not even offered for a cross-row rule');
      return JSON.stringify({ kind: 'none', diagnosis: 'duplicates need a structural dedupe' });
    },
  });
  assert.equal(out.proposal?.kind, 'none');
  assert.equal(out.rowsEligible, false);
});

// --------------------------------------------------------------------- apply ---

test('apply batch: governed MERGE executed, batch id + snapshot recorded, re-check is real', async () => {
  let executed = '';
  const counts = [3, 0]; // before → after (the fix worked)
  const out = await applyFixes(dataset([REGION_CHECK]), REGION_CHECK, { mode: 'batch', sqlExpr: 'upper(region)' }, {
    fqn: FQN, layer: 'gold',
    queryFn: fakeQuery({ violations: () => counts.shift() ?? 0 }),
    executeFn: async (sql) => { executed = sql; return { rowsAffected: 3 }; },
    ranBy: 'amir', domain: 'sales', now: () => '2026-07-27T10:00:00.000Z',
  });
  assert.match(executed, /^merge into iceberg\.sales\.gold_orders as t using /);
  assert.equal(out.rowsChanged, 3);
  assert.equal(out.recheck.status, 'pass', 're-checked for real');
  assert.equal(out.remediation?.violationsBefore, 3);
  assert.equal(out.remediation?.violationsAfter, 0);
  assert.equal(out.remediation?.snapshotIdBefore, 'snap-42');
  assert.match(out.remediation?.batchId ?? '', /^ds1\.dqfix\./, 'remediation batch id stamped');
  assert.equal(latestRemediation('ds1', 'c1')?.mode, 'batch', 'durably recorded');
});

test('apply: a fix that did not fix STAYS RED (honest recheck)', async () => {
  const counts = [3, 2];
  const out = await applyFixes(dataset([REGION_CHECK]), REGION_CHECK, { mode: 'batch', sqlExpr: 'upper(region)' }, {
    fqn: FQN, layer: 'gold',
    queryFn: fakeQuery({ violations: () => counts.shift() ?? 0 }),
    executeFn: async () => ({ rowsAffected: 3 }),
    ranBy: 'amir', domain: 'sales',
  });
  assert.equal(out.recheck.status, 'fail');
  assert.equal(out.recheck.violations, 2);
});

test('apply: the guard re-validates server-side — a smuggled expression never executes', async () => {
  let executed = 0;
  await assert.rejects(
    applyFixes(dataset([REGION_CHECK]), REGION_CHECK, { mode: 'batch', sqlExpr: "1); drop table x --" }, {
      fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 3 }),
      executeFn: async () => { executed++; return { rowsAffected: 0 }; },
      ranBy: 'amir', domain: 'sales',
    }),
    DqError,
  );
  assert.equal(executed, 0, 'nothing reached the execute path');
});

test('apply rows: refused honestly without a declared identity; literals bound when declared', async () => {
  let executed = '';
  await assert.rejects(
    applyFixes(dataset([REGION_CHECK]), REGION_CHECK, { mode: 'rows', fixes: [{ pk: '7', proposed: 'EU' }] }, {
      fqn: FQN, layer: 'gold', queryFn: fakeQuery({ violations: 2 }),
      executeFn: async () => ({ rowsAffected: 0 }),
      ranBy: 'amir', domain: 'sales',
    }),
    /unique rule on your key column/,
  );
  const counts2 = [2, 0];
  const out = await applyFixes(dataset([REGION_CHECK, IDENTITY]), REGION_CHECK, { mode: 'rows', fixes: [{ pk: '7', proposed: "O'Brien" }] }, {
    fqn: FQN, layer: 'gold',
    queryFn: fakeQuery({ violations: () => counts2.shift() ?? 0 }),
    executeFn: async (sql) => { executed = sql; return { rowsAffected: 1 }; },
    ranBy: 'amir', domain: 'sales',
  });
  assert.match(executed, /values \('7', 'O''Brien'\)/, 'escaped literal binding');
  assert.match(executed, /on t\."order_id" = cast\(s\.k as bigint\)/, 'declared key + real type');
  assert.equal(out.remediation?.rowsFixed, 1);
});

test('apply: a cross-row rule (unique) is refused — structural, not a column fix', async () => {
  await assert.rejects(
    applyFixes(dataset([IDENTITY]), IDENTITY, { mode: 'batch', sqlExpr: 'order_id' }, {
      fqn: FQN, layer: 'gold', queryFn: fakeQuery({}),
      executeFn: async () => ({ rowsAffected: 0 }),
      ranBy: 'amir', domain: 'sales',
    }),
    /manual\/structural/,
  );
});
