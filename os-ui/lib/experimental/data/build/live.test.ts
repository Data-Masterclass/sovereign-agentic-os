/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLiveAdapters, type DataLiveDeps } from './live.ts';
import { makeMockAdapters, mockDeps, newMockBackends } from './mocks.ts';
import { orchestrateStage } from './orchestrate.ts';
import { runAdapter, type DataBuildContext } from './adapter.ts';
import {
  CUBE_ARTIFACT, DASHBOARD_ARTIFACT, EXPOSURE_ARTIFACT,
  scaffoldCubeYaml, scaffoldDashboardBundle, scaffoldExposureYaml,
} from '../metrics.ts';
import { emptyVersions, type Dataset } from '../dataset-schema.ts';

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
  return {
    dataset: d,
    artifacts: {
      [CUBE_ARTIFACT(d)]: scaffoldCubeYaml(d),
      [EXPOSURE_ARTIFACT]: scaffoldExposureYaml(d),
      [DASHBOARD_ARTIFACT(d)]: scaffoldDashboardBundle(d),
    },
  };
}

/** A live-shaped fake deps set we control to drive apply/verify outcomes. */
function fakes(over: Partial<{ resolves: boolean; imported: boolean; lineage: boolean }> = {}): DataLiveDeps {
  const o = { resolves: true, imported: true, lineage: true, ...over };
  const dashboards = new Set<string>();
  return {
    // Base on the mock deps so the Phase-6 clients (dlt/dbt/dbt-trino/trino/policy +
    // roster) are present; override cube/superset/om to steer the assertions.
    ...mockDeps(newMockBackends()),
    cube: {
      async reload() {},
      async resolveMeasure() { return o.resolves ? 4242 : null; },
    },
    superset: {
      async importBundle(name) { if (o.imported) dashboards.add(name); },
      async dashboardExists(name) { return dashboards.has(name); },
    },
    om: {
      async pushExposure() {},
      async hasLineage() { return o.lineage; },
    },
  };
}

test('metric stage ✓ when cube resolves AND om gate+lineage pass (live adapters)', async () => {
  const r = await orchestrateStage('metric', ctxFor(gold()), makeLiveAdapters(fakes()));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.tool), ['cube', 'om']);
  assert.ok(r.rows.every((x) => x.status === 'ok'));
});

test('cardinal rule: cube apply ok but the metric does NOT resolve → ✗ (no false green)', async () => {
  const r = await orchestrateStage('metric', ctxFor(gold()), makeLiveAdapters(fakes({ resolves: false })));
  assert.equal(r.ok, false);
  const cube = r.rows.find((x) => x.tool === 'cube')!;
  assert.equal(cube.applied, true);
  assert.equal(cube.verified, false);
  assert.equal(cube.status, 'fail');
});

test('om verify fails when the transparency gate is red (structural gap)', async () => {
  // Docs are advisory now — the gate only reds on a STRUCTURAL gap (owner/domain/tier).
  const bare = gold({ domain: '' });
  const r = await orchestrateStage('metric', ctxFor(bare), makeLiveAdapters(fakes()));
  const om = r.rows.find((x) => x.tool === 'om')!;
  assert.equal(om.status, 'fail');
  assert.match(om.error ?? '', /transparency gate|domain/);
});

test('dashboard stage ✓ when the bundle imports and the dashboard loads', async () => {
  const r = await orchestrateStage('dashboard', ctxFor(gold()), makeLiveAdapters(fakes()));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map((x) => x.tool), ['superset', 'om']);
});

test('dashboard ✗ if the import silently did nothing (verify catches it)', async () => {
  const r = await orchestrateStage('dashboard', ctxFor(gold()), makeLiveAdapters(fakes({ imported: false })));
  const ss = r.rows.find((x) => x.tool === 'superset')!;
  assert.equal(ss.applied, true);
  assert.equal(ss.status, 'fail'); // dashboardExists → false
});

test('offline-mock runs the SAME adapter logic and agrees with live (no drift)', async () => {
  const mock = await orchestrateStage('metric', ctxFor(gold()), makeMockAdapters(newMockBackends()));
  assert.equal(mock.ok, true);
  assert.deepEqual(mock.rows.map((x) => x.tool), ['cube', 'om']);
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

test('policy adapter verify is the CONFORMANCE gate (OPA == Cube)', async () => {
  const r = await orchestrateStage('certify', ctxFor(gold({ tier: 'product', visibility: 'shared' })), makeLiveAdapters(fakes()));
  const policy = r.rows.find((x) => x.tool === 'policy')!;
  assert.equal(policy.status, 'ok');
  assert.match(policy.detail, /conformant/);
});

test('runAdapter catches a thrown live-client error as ✗ (honest network failure)', async () => {
  const throwing = makeLiveAdapters({
    ...fakes(),
    cube: { async reload() { throw new Error('Cube unreachable'); }, async resolveMeasure() { return 1; } },
  });
  const row = await runAdapter(throwing.cube, ctxFor(gold()));
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /unreachable/);
});
