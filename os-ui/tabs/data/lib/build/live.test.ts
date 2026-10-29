/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLiveAdapters, type DataLiveDeps } from '@tabs/data/lib/build/live';
import { makeMockAdapters, mockDeps, newMockBackends } from '@tabs/data/lib/build/mocks';
import { orchestrateStage } from '@tabs/data/lib/build/orchestrate';
import { runAdapter, type DataBuildContext } from '@tabs/data/lib/build/adapter';
import { emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';

function gold(over: Partial<Dataset> = {}): Dataset {
  const v = emptyVersions();
  v.bronze.built = true; v.silver.built = true; v.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions: v,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [{ name: 'order_id', description: 'Key.' }, { name: 'net_amount', description: 'Value.' }],
    ...over,
  };
}

function ctxFor(d: Dataset): DataBuildContext {
  return { dataset: d, artifacts: {} };
}

/** A live-shaped fake deps set (the in-process clients: dlt/dbt/dbt-trino/trino/policy + roster). */
function fakes(): DataLiveDeps {
  return mockDeps(newMockBackends());
}

test('offline-mock runs the SAME adapter logic and agrees with live (no drift)', async () => {
  const mock = await orchestrateStage('promote', ctxFor(gold()), makeMockAdapters(newMockBackends()));
  assert.equal(mock.ok, true);
  assert.deepEqual(mock.rows.map((x) => x.tool), ['policy', 'dbt-trino', 'trino']);
});

test('bronze dlt adapter normalizes a hyphenated domain to a valid Trino schema (dash->underscore)', async () => {
  const seen: string[] = [];
  const deps: DataLiveDeps = {
    ...fakes(),
    dlt: {
      async load(table) { seen.push(table); },
      async tableExists(table) { seen.push(table); return true; },
    },
  };
  const d = gold({ domain: 'agentic-leader-q3-2026', name: 'Orders' });
  const r = await orchestrateStage('bronze', ctxFor(d), makeLiveAdapters(deps));
  assert.equal(r.ok, true);
  // Both the load (apply) and existence probe (verify) must target the underscore schema.
  assert.ok(seen.length >= 1, 'dlt adapter was invoked');
  for (const table of seen) {
    assert.equal(table, 'iceberg.agentic_leader_q3_2026.bronze_orders');
    assert.ok(!table.includes('-'), 'no dash reaches Trino');
  }
});

test('promote stage runs the full set (policy → dbt-trino → trino) and ✓', async () => {
  const r = await orchestrateStage('promote', ctxFor(gold()), makeLiveAdapters(fakes()));
  // policy FIRST: the promoted FQN's OPA governance is live before the table exists.
  assert.deepEqual(r.rows.map((x) => x.tool), ['policy', 'dbt-trino', 'trino']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, []);
});

test('orchestrator SKIPS an absent adapter (no faked ✓) rather than inventing a row', async () => {
  const adapters = makeLiveAdapters(fakes());
  delete adapters.policy; // simulate a not-yet-wired tool
  const r = await orchestrateStage('promote', ctxFor(gold()), adapters);
  assert.deepEqual(r.rows.map((x) => x.tool), ['dbt-trino', 'trino']);
  assert.deepEqual(r.skipped, ['policy']);
});

test('T8 publish: the promote CTAS + the APPROVING Builder identity thread to dbt-trino', async () => {
  const b = newMockBackends();
  const ctx = {
    ...ctxFor(gold()),
    principal: 'bea',
    transformSql: 'create or replace table iceberg.sales.gold_orders as select * from iceberg.personal_amir.gold_orders',
    schemaSql: 'create schema if not exists iceberg.sales',
    identity: { principal: 'bea', uid: 'bea', domains: ['sales'], role: 'builder' as const },
    releaseSchema: 'personal_amir',
  };
  const r = await orchestrateStage('promote', ctx, makeMockAdapters(b));
  assert.equal(r.ok, true);
  assert.equal(b.publishWrites.length, 1);
  assert.equal(b.publishWrites[0].uid, 'bea', 'the CTAS runs as the APPROVER, never the requester');
  assert.equal(b.publishWrites[0].role, 'builder');
  assert.equal(b.publishWrites[0].releaseSchema, 'personal_amir');
  assert.match(b.publishWrites[0].sql, /^create or replace table iceberg\.sales\.gold_orders as select/);
  const row = r.rows.find((x) => x.tool === 'dbt-trino')!;
  assert.match(row.detail, /approving Builder|materialized/);
});

test('T8 publish without a write ctx stays a verify-only probe (no accidental DDL)', async () => {
  const b = newMockBackends();
  const r = await orchestrateStage('promote', ctxFor(gold()), makeMockAdapters(b));
  assert.equal(r.ok, true);
  assert.equal(b.publishWrites.length, 0);
});

test('promote ✗ if the materialized table is not queryable (dbt-trino/trino chain)', async () => {
  const deps = mockDeps(newMockBackends()); // trino.tableQueryable=false until materialized
  // Override dbt-trino to NOT materialize, so trino's probe fails honestly.
  const broken = { ...deps, dbtTrino: { async materialize() { return { ok: true }; } } };
  const r = await orchestrateStage('promote', ctxFor(gold()), makeLiveAdapters(broken));
  const trino = r.rows.find((x) => x.tool === 'trino')!;
  assert.equal(trino.status, 'fail');
});

test('policy adapter verify checks the compiled OPA bundle governs the promoted FQN', async () => {
  const r = await orchestrateStage('certify', ctxFor(gold({ tier: 'product', visibility: 'shared' })), makeLiveAdapters(fakes()));
  const policy = r.rows.find((x) => x.tool === 'policy')!;
  assert.equal(policy.status, 'ok');
  assert.match(policy.detail, /OPA governance covers iceberg\.sales\.gold_orders/);
});

test('policy adapter ✗ for a dataset the compiler does not govern (never an ungoverned publish)', async () => {
  const r = await orchestrateStage('certify', ctxFor(gold({ tier: 'dataset', visibility: 'private' })), makeLiveAdapters(fakes()));
  const policy = r.rows.find((x) => x.tool === 'policy')!;
  assert.equal(policy.status, 'fail');
  assert.match(policy.error ?? '', /no OPA governance compiled/);
});

test('runAdapter catches a thrown live-client error as ✗ (honest network failure)', async () => {
  const throwing = makeLiveAdapters({
    ...fakes(),
    policy: { async push() { throw new Error('OPA unreachable'); } },
  });
  const row = await runAdapter(throwing.policy, ctxFor(gold({ tier: 'product', visibility: 'shared' })));
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /unreachable/);
});
