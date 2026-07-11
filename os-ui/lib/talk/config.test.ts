/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, transition, listAskable, type Principal } from '../data/store.ts';
import { runAsk, type AskGrid } from '../data/ask.ts';
import { dataResult } from './config.ts';

/**
 * The DATA copilot grounding (config.ts `dataResult`) — the mapping from a governed NL→SQL
 * outcome to the copilot's evidence. Two failures were live before this suite:
 *   1. `listAskable` must hand the model the EXACT gold FQN the governed query path uses —
 *      `iceberg.<snake_domain>.gold_<slug>` — or the generated SQL hits TABLE_NOT_FOUND.
 *   2. On ANY `runAsk` failure the retrieval SWALLOWED the reason (returned no evidence), so
 *      the copilot said "the CONTEXT has no data rows" — pretending no data exists.
 * These tests run fully offline: an injected llm returns a correct SELECT and an injected
 * query returns rows ONLY for the correct FQN, so real evidence rows must flow through.
 */

const admin: Principal = { id: 'aborek', domains: ['agentic-leader-q3-2026'], role: 'admin' };

beforeEach(() => __resetStore());

/** Seed the confirmed-live dataset: admin-owned, domain-tier, gold-built. */
function seedNorthpeak() {
  const d = createDataset(admin, { name: 'Northpeak Sales Transactions' });
  buildVersion(d.id, admin, 'gold', { quality: 'passing', artifact: 'gold/np.sql' });
  transition(d.id, admin, 'promote', { visibility: 'domain' });
  return d;
}

// ---------------------------------------------------------------- the FQN contract --

test('FQN: listAskable hands the model the exact gold FQN the governed query path uses', () => {
  seedNorthpeak();
  const askable = listAskable(admin);
  assert.equal(askable.length, 1);
  // The confirmed-healthy physical name: snake_domain + gold_<slug>, hyphen-free.
  assert.equal(askable[0].fqn, 'iceberg.agentic_leader_q3_2026.gold_northpeak_sales_transactions');
  assert.doesNotMatch(askable[0].fqn, /-/, 'no raw hyphen may reach Trino');
});

// -------------------------------------------------- rows flow (FQN → runAsk → dataResult) --

test('ROWS: a correct SELECT over the real FQN returns rows, and dataResult surfaces them as evidence', async () => {
  seedNorthpeak();
  const datasets = listAskable(admin);
  const fqn = datasets[0].fqn;

  // The model returns the correct LIMIT-2 SELECT over the real FQN…
  const sql = `select * from ${fqn} order by order_date desc limit 2`;
  // …and the governed query returns rows ONLY for that exact FQN (a wrong name → no rows).
  const query = async (executed: string): Promise<AskGrid> => {
    if (!executed.toLowerCase().includes(fqn.toLowerCase())) {
      return { columns: ['order_id', 'order_date'], rows: [], rowCount: 0 };
    }
    return {
      columns: ['order_id', 'order_date'],
      rows: [['NP-1002', '2026-06-26'], ['NP-1001', '2026-06-25']],
      rowCount: 2,
    };
  };

  const outcome = await runAsk({
    question: 'show me the last two records of Northpeak Sales Transactions',
    datasets,
    llm: async () => sql,
    models: { generate: 'g', summarize: 's' },
    query,
  });
  assert.ok(outcome.ok, 'the governed query succeeded over the correct FQN');

  const grounding = dataResult(outcome, datasets);
  assert.equal(grounding.kind, 'sql');
  // The ACTUAL values must be in the evidence — not just column names.
  assert.match(grounding.evidence ?? '', /query result — 2 rows/);
  assert.match(grounding.evidence ?? '', /NP-1002\t2026-06-26/);
  assert.match(grounding.evidence ?? '', /NP-1001\t2026-06-25/);
  // The referenced dataset is cited (matched by FQN substring).
  assert.deepEqual(grounding.citations.map((c) => c.id), [fqn]);
});

// ------------------------------------------------------- the swallow is fixed (honesty) --

test('SWALLOW: a query_failed outcome now surfaces its reason as evidence (no silent drop)', () => {
  const datasets = listAskable(admin); // empty is fine — dataResult is pure
  const grounding = dataResult(
    { ok: false, kind: 'query_failed', message: 'Access Denied: Cannot select from table', sql: 'select 1 from t' },
    datasets,
  );
  assert.equal(grounding.kind, 'sql');
  assert.equal(grounding.query, 'select 1 from t'); // the SQL is still disclosed
  assert.match(grounding.evidence ?? '', /could not run — query_failed: Access Denied/);
});

test('SWALLOW: every failure kind carries its kind + message into the evidence', () => {
  const kinds = [
    { kind: 'no_dataset' as const, message: 'nothing you can view holds that data' },
    { kind: 'invalid_sql' as const, message: 'only a read-only SELECT is allowed' },
    { kind: 'not_materialized' as const, message: 'not materialized yet' },
  ];
  for (const f of kinds) {
    const g = dataResult({ ok: false, ...f }, []);
    assert.match(g.evidence ?? '', new RegExp(`could not run — ${f.kind}:`), `${f.kind} must surface`);
    assert.match(g.evidence ?? '', new RegExp(f.message.split(' ')[0]));
  }
});
