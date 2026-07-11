/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_DATASET_TOKEN,
  extractSql,
  validateReadOnlySelect,
  schemaContext,
  sqlGenMessages,
  answerMessages,
  runAsk,
  type AskDataset,
  type AskGrid,
  type AskMessage,
} from './ask.ts';
import { __resetStore, createDataset, buildVersion, setDocs, transition, listAskable, type Principal } from './store.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

const northpeak: AskDataset = {
  id: 'ds_np',
  name: 'Northpeak Commerce',
  domain: 'sales',
  tier: 'asset',
  fqn: 'iceberg.sales.gold_northpeak_commerce',
  description: 'E-commerce orders, one row per order line.',
  columns: [
    { name: 'region', description: 'Customer region' },
    { name: 'revenue', description: 'Net revenue in EUR' },
  ],
};

// ------------------------------------------------------------- SQL validator --

test('VALIDATOR: a plain SELECT and a WITH…SELECT pass', () => {
  const a = validateReadOnlySelect('select region, sum(revenue) from iceberg.sales.gold_northpeak_commerce group by region');
  assert.ok(a.ok);
  const b = validateReadOnlySelect('with r as (select region from iceberg.sales.gold_northpeak_commerce) select * from r limit 100');
  assert.ok(b.ok);
});

test('VALIDATOR: INSERT / UPDATE / DELETE / DDL are rejected', () => {
  for (const sql of [
    "insert into iceberg.sales.gold_northpeak_commerce values (1)",
    "update iceberg.sales.gold_northpeak_commerce set revenue = 0",
    "delete from iceberg.sales.gold_northpeak_commerce",
    "drop table iceberg.sales.gold_northpeak_commerce",
    "create table iceberg.sales.x as select 1",
    "truncate table iceberg.sales.gold_northpeak_commerce",
  ]) {
    const v = validateReadOnlySelect(sql);
    assert.equal(v.ok, false, `must reject: ${sql}`);
  }
});

test('VALIDATOR: a write smuggled INSIDE a SELECT is rejected', () => {
  const v = validateReadOnlySelect('select * from x where 1 = (delete from y)');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /delete/);
});

test('VALIDATOR: multi-statement is rejected (even with the ; mid-string)', () => {
  const v = validateReadOnlySelect('select 1; drop table iceberg.sales.gold_northpeak_commerce');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /one SQL statement/);
});

test('VALIDATOR: comment smuggle (line + block + hash) is rejected', () => {
  for (const sql of [
    'select 1 -- drop table x',
    'select /* hidden */ 1 from x',
    'select 1 from x # comment',
  ]) {
    const v = validateReadOnlySelect(sql);
    assert.equal(v.ok, false, `must reject: ${sql}`);
    assert.match((v as { reason: string }).reason, /comment/i);
  }
});

test("VALIDATOR: keywords inside STRING LITERALS don't false-positive; word stems don't either", () => {
  const a = validateReadOnlySelect("select * from t where note = 'please delete me' limit 10");
  assert.ok(a.ok, 'a quoted literal mentioning delete is fine');
  const b = validateReadOnlySelect('select created_at, deleted_at from t limit 5 offset 0');
  assert.ok(b.ok, 'created_at/deleted_at/offset are not write keywords');
});

// BUG 2: a raw hyphenated identifier (the model copying the cohort domain / display
// name) is a Trino SYNTAX_ERROR — reject it BEFORE execution, don't ship it.
test('VALIDATOR: a raw hyphenated FQN/identifier is rejected (never reaches Trino)', () => {
  for (const sql of [
    'select name\nfrom iceberg.agentic-leader-Q3-2026.bronze_participants limit 10',
    'select * from agentic-leader-q3-2026 limit 5',
    'select foo-bar from t limit 1',
  ]) {
    const v = validateReadOnlySelect(sql);
    assert.equal(v.ok, false, `must reject: ${sql}`);
    assert.match((v as { reason: string }).reason, /identifier|fully-qualified/i);
  }
});

test('VALIDATOR: a valid slugified FQN + spaced subtraction still pass (no false positive)', () => {
  // The CORRECT physical name for the hyphenated cohort — underscores, no hyphen.
  const a = validateReadOnlySelect(
    'select name from iceberg.agentic_leader_q3_2026.bronze_participants limit 10',
  );
  assert.ok(a.ok, 'the slugified FQN is valid');
  // Real subtraction is spaced — the hyphen guard must not fire on it.
  const b = validateReadOnlySelect('select revenue - cost as margin from iceberg.sales.gold_x limit 5');
  assert.ok(b.ok, 'spaced arithmetic is not a hyphenated identifier');
});

test('VALIDATOR: empty / non-SELECT prose is rejected', () => {
  assert.equal(validateReadOnlySelect('').ok, false);
  assert.equal(validateReadOnlySelect('I cannot answer that').ok, false);
});

test('EXTRACT: markdown fences and one trailing semicolon are tolerated', () => {
  assert.equal(extractSql('```sql\nselect 1\n```'), 'select 1');
  assert.equal(extractSql('select 1;'), 'select 1');
  const v = validateReadOnlySelect(extractSql('```sql\nselect region from t limit 5;\n```'));
  assert.ok(v.ok);
});

// ------------------------------------------------------------ prompt context --

test('CONTEXT: schemaContext renders FQN + docs; the prompt carries ONLY the given datasets', () => {
  const ctx = schemaContext([northpeak]);
  assert.match(ctx, /iceberg\.sales\.gold_northpeak_commerce/);
  assert.match(ctx, /revenue \(Net revenue in EUR\)/);
  const messages = sqlGenMessages('total revenue by region', [northpeak]);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /gold_northpeak_commerce/);
  assert.match(messages[0].content, new RegExp(NO_DATASET_TOKEN));
  assert.equal(messages[1].content, 'total revenue by region');
});

test('GOVERNANCE: listAskable is canView-scoped and only lists BUILT datasets', () => {
  // amir's own private dataset (bronze built) → visible to amir only, personal schema.
  const mine = createDataset(amir, { name: 'My Orders' });
  buildVersion(mine.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/o.dlt.yml' });
  // A promoted sales asset (silver built) → any sales user, domain schema.
  const shared = createDataset(amir, { name: 'Shared Orders' });
  buildVersion(shared.id, amir, 'silver', { quality: 'passing', artifact: 'silver/s.sql' });
  transition(shared.id, sara, 'promote', { visibility: 'domain' });
  // kenji's private finance dataset (built) → NEVER visible to sales users.
  const secret = createDataset(kenji, { name: 'Finance Ledger' });
  buildVersion(secret.id, kenji, 'silver', { quality: 'passing', artifact: 'silver/l.sql' });
  setDocs(secret.id, kenji, { description: 'SECRET LEDGER', columns: [{ name: 'iban', description: 'account' }] });
  // An unbuilt dataset → nothing to query, excluded.
  createDataset(amir, { name: 'Empty Draft' });

  const forAmir = listAskable(amir);
  const fqns = forAmir.map((d) => d.fqn);
  assert.deepEqual(fqns.sort(), ['iceberg.personal_amir.bronze_my_orders', 'iceberg.sales.silver_shared_orders']);
  // The finance schema/docs can never leak into amir's prompt context.
  const ctx = schemaContext(forAmir.map((d) => ({ ...d, tier: d.tier as string })));
  assert.doesNotMatch(ctx, /SECRET LEDGER|iban|finance/i);
  // kenji sees his own private dataset (his personal schema), not amir's.
  const forKenji = listAskable(kenji);
  assert.deepEqual(forKenji.map((d) => d.fqn), ['iceberg.personal_kenji.silver_finance_ledger']);
});

// BUG 2: a hyphenated-domain dataset must reach the model as a VALID slug FQN, and the
// prompt must forbid inventing a name from the display/domain label.
test('CONTEXT: a hyphenated domain yields a hyphen-free slug FQN + a no-invent rule', () => {
  const cohortOwner: Principal = { id: 'aborek', domains: ['agentic-leader-q3-2026'], role: 'creator' };
  const shared = createDataset(cohortOwner, { name: 'Agentic Leader Q3 2026 Participants' });
  buildVersion(shared.id, cohortOwner, 'silver', { quality: 'passing', artifact: 'silver/p.sql' });
  transition(shared.id, { ...cohortOwner, role: 'admin' }, 'promote', { visibility: 'domain' });

  const askable = listAskable(cohortOwner);
  const fqn = askable[0].fqn;
  assert.doesNotMatch(fqn, /-/, 'no raw hyphen may reach Trino');
  assert.match(fqn, /^iceberg\.agentic_leader_q3_2026\.silver_agentic_leader_q3_2026_participants$/);

  // The generated FQN passes the validator; and the prompt tells the model not to invent.
  assert.ok(validateReadOnlySelect(`select * from ${fqn} limit 5`).ok);
  const sys = sqlGenMessages('list participants', askable.map((d) => ({ ...d, tier: d.tier as string })))[0].content;
  assert.match(sys, /NEVER build a table name/i);
});

// -------------------------------------------------------------- orchestrator --

function grid(rows: string[][]): AskGrid {
  return { columns: ['region', 'total'], rows, rowCount: rows.length };
}

test('ASK: a question produces {sql, rows, answer}; the summary is grounded ONLY in returned rows', async () => {
  const calls: { messages: AskMessage[]; model: string }[] = [];
  const llm = async (messages: AskMessage[], model: string) => {
    calls.push({ messages, model });
    if (calls.length === 1) return '```sql\nselect region, sum(revenue) as total from iceberg.sales.gold_northpeak_commerce group by region;\n```';
    return 'EMEA leads with 120, APAC follows with 80.';
  };
  const executed: string[] = [];
  const out = await runAsk({
    question: 'total revenue by region',
    datasets: [northpeak],
    llm,
    models: { generate: 'sovereign-reasoning', summarize: 'sovereign-default' },
    query: async (sql) => {
      executed.push(sql);
      return grid([['EMEA', '120'], ['APAC', '80']]);
    },
  });
  assert.ok(out.ok);
  assert.equal(out.sql, 'select region, sum(revenue) as total from iceberg.sales.gold_northpeak_commerce group by region');
  assert.deepEqual(out.rows, [['EMEA', '120'], ['APAC', '80']]);
  assert.equal(out.answer, 'EMEA leads with 120, APAC follows with 80.');
  // Exactly the validated SQL was executed (nothing else, no fence, no ';').
  assert.deepEqual(executed, [out.sql]);
  // Model routing: deep model generates, light model summarizes.
  assert.equal(calls[0].model, 'sovereign-reasoning');
  assert.equal(calls[1].model, 'sovereign-default');
  // The summary prompt is grounded in the returned rows and the executed SQL only.
  const summaryPrompt = calls[1].messages.map((m) => m.content).join('\n');
  assert.match(summaryPrompt, /EMEA\t120/);
  assert.match(summaryPrompt, /ONLY in the SQL result/);
});

test('ASK: invalid generated SQL is REJECTED and never executed', async () => {
  let executed = 0;
  const out = await runAsk({
    question: 'wipe it',
    datasets: [northpeak],
    llm: async () => 'drop table iceberg.sales.gold_northpeak_commerce',
    models: { generate: 'g', summarize: 's' },
    query: async () => {
      executed++;
      return grid([]);
    },
  });
  assert.equal(out.ok, false);
  const fail = out as { kind: string; message: string; sql?: string };
  assert.equal(fail.kind, 'invalid_sql');
  assert.match(fail.message, /SELECT/i);
  assert.equal(fail.sql, 'drop table iceberg.sales.gold_northpeak_commerce'); // shown honestly
  assert.equal(executed, 0, 'rejected SQL must never reach queryRun');
});

test('ASK: an invented hyphenated table name is rejected as invalid_sql, never executed', async () => {
  let executed = 0;
  const out = await runAsk({
    question: 'first 10 participants',
    datasets: [northpeak],
    // The model ignores the FQN and invents a name from the cohort domain/display label.
    llm: async () => 'select name\nfrom iceberg.agentic-leader-Q3-2026.bronze_participants limit 10',
    models: { generate: 'g', summarize: 's' },
    query: async () => {
      executed++;
      return grid([]);
    },
  });
  assert.equal(out.ok, false);
  const fail = out as { kind: string; message: string };
  assert.equal(fail.kind, 'invalid_sql');
  assert.match(fail.message, /identifier|fully-qualified/i);
  assert.equal(executed, 0, 'a doomed hyphenated statement must never reach Trino');
});

test('ASK: the NO_ACCESSIBLE_DATASET token and an empty context both answer honestly', async () => {
  const viaToken = await runAsk({
    question: 'what is in the finance ledger?',
    datasets: [northpeak],
    llm: async () => NO_DATASET_TOKEN,
    models: { generate: 'g', summarize: 's' },
    query: async () => grid([]),
  });
  assert.equal(viaToken.ok, false);
  assert.equal((viaToken as { kind: string }).kind, 'no_dataset');

  let llmCalls = 0;
  const empty = await runAsk({
    question: 'anything',
    datasets: [],
    llm: async () => {
      llmCalls++;
      return 'select 1';
    },
    models: { generate: 'g', summarize: 's' },
    query: async () => grid([]),
  });
  assert.equal(empty.ok, false);
  assert.equal((empty as { kind: string }).kind, 'no_dataset');
  assert.equal(llmCalls, 0, 'no context → no LLM call at all');
});

test('ASK: zero rows is said plainly — no second LLM call, nothing fabricated', async () => {
  let llmCalls = 0;
  const out = await runAsk({
    question: 'revenue on mars',
    datasets: [northpeak],
    llm: async () => {
      llmCalls++;
      return "select region from iceberg.sales.gold_northpeak_commerce where region = 'mars'";
    },
    models: { generate: 'g', summarize: 's' },
    query: async () => grid([]),
  });
  assert.ok(out.ok);
  assert.equal(out.rowCount, 0);
  assert.match(out.answer, /no rows/i);
  assert.equal(llmCalls, 1, 'the summary model must not be asked to narrate an empty result');
});

test('ASK: a Trino/OPA refusal surfaces as query_failed with the real message + the SQL', async () => {
  const out = await runAsk({
    question: 'total revenue',
    datasets: [northpeak],
    llm: async () => 'select sum(revenue) from iceberg.sales.gold_northpeak_commerce',
    models: { generate: 'g', summarize: 's' },
    query: async () => {
      throw new Error('Access Denied: Cannot select from table');
    },
  });
  assert.equal(out.ok, false);
  const fail = out as { kind: string; message: string; sql?: string };
  assert.equal(fail.kind, 'query_failed');
  assert.match(fail.message, /Access Denied/);
  assert.ok(fail.sql);
});

test('ASK: a TABLE_NOT_FOUND is answered as calm not_materialized, never a raw Trino error', async () => {
  const out = await runAsk({
    question: 'weekly cac',
    datasets: [northpeak],
    llm: async () => 'select * from iceberg.sales.bronze_northpeak_cac_cos_weekly limit 100',
    models: { generate: 'g', summarize: 's' },
    query: async () => {
      throw new Error(
        'TrinoUserError TABLE_NOT_FOUND: iceberg.sales.bronze_northpeak_cac_cos_weekly does not exist',
      );
    },
  });
  assert.equal(out.ok, false);
  const fail = out as { kind: string; message: string; sql?: string };
  assert.equal(fail.kind, 'not_materialized');
  assert.match(fail.message, /materialized yet/i);
  assert.doesNotMatch(fail.message, /TABLE_NOT_FOUND/); // the raw Trino error never leaks
  assert.ok(fail.sql); // the SQL is still shown for transparency
});

test('ASK: answerMessages caps the grounding rows but reports the true rowCount', () => {
  const rows = Array.from({ length: 80 }, (_, i) => [`r${i}`, String(i)]);
  const messages = answerMessages('q', 'select 1', { columns: ['region', 'total'], rows, rowCount: 80 });
  assert.match(messages[1].content, /80 rows total, first 50 shown/);
  assert.doesNotMatch(messages[1].content, /r79\t/);
});
