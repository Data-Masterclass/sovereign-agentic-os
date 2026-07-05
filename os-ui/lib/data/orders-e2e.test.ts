/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The "Orders" worked example, end-to-end (data-architecture-model.md §Worked example;
 * data-ui-ux.md validation gate). It drives the SAME registry the guided UI drives,
 * runs the (pure) offline-mock Build adapter pipeline, compiles + conforms the policy,
 * assembles the lineage, and proves the scoped data agent reads exactly the governed
 * product the lifecycle produced — the "both ways" guarantee (guided path == agent path).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore, createDataset, buildVersion, setDocs, requestPromotion, applyApprovedPromotion,
  certify, defineMeasure, importProduct, getDataset, type Principal,
} from './store.ts';
import { orchestrateStage } from './build/orchestrate.ts';
import { makeMockAdapters, newMockBackends, MOCK_ROSTER } from './build/mocks.ts';
import { CUBE_ARTIFACT, DASHBOARD_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldCubeYaml, scaffoldDashboardBundle, scaffoldExposureYaml } from './metrics.ts';
import { compilePolicy, tableFqn, cubeFor } from './policy/compiler.ts';
import { runConformance, evaluateOpa } from './policy/conformance.ts';
import { lineageFor } from './lineage.ts';
import { runAgentTool, type Executors } from './agent-tools.ts';
import { claimsFromUser } from './identity.ts';
import { assertSandboxScoped } from '../sandbox.ts';
import type { Dataset } from './dataset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' }; // Creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };
// Importing a product is a Builder+ action; a finance Builder onboards it, then
// kenji (participant) reads the imported product like any domain peer.
const finBuilder: Principal = { id: 'fatima', domains: ['finance'], role: 'builder' };

beforeEach(() => __resetStore());

function ctxFor(d: Dataset) {
  return {
    dataset: d,
    artifacts: {
      [CUBE_ARTIFACT(d)]: scaffoldCubeYaml(d),
      [EXPOSURE_ARTIFACT]: scaffoldExposureYaml(d),
      [DASHBOARD_ARTIFACT(d)]: scaffoldDashboardBundle(d),
    },
  };
}
async function build(d: Dataset, stage: Parameters<typeof orchestrateStage>[0]) {
  return orchestrateStage(stage, ctxFor(d), makeMockAdapters(newMockBackends()));
}

test('Orders: ingest → Silver dataset → promote → Gold asset → certify → metric → dashboard, governed + conformant', async () => {
  // 1. Creator ingests + cleans (Bronze, Silver dataset in DuckDB)
  const d0 = createDataset(amir, { name: 'Orders' });
  buildVersion(d0.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  assert.equal((await build(getDataset(d0.id, amir), 'bronze')).ok, true); // dlt → om
  buildVersion(d0.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  setDocs(d0.id, amir, {
    description: 'Sales orders — the worked example.',
    columns: [{ name: 'order_id', description: 'Key.' }, { name: 'order_date', description: 'When.' }, { name: 'net_amount', description: 'EUR net.' }],
  });
  assert.equal((await build(getDataset(d0.id, amir), 'silver')).ok, true); // dbt → om

  // 2. Builder promotes (separation of duties; the dataset is private to amir)
  const req = requestPromotion(d0.id, amir, { visibility: 'domain' });
  const asset = applyApprovedPromotion(req, bea);
  assert.equal(asset.tier, 'asset');
  const promoteBuild = await build(getDataset(d0.id, sara), 'promote'); // policy → dbt-trino → trino (T8)
  assert.equal(promoteBuild.ok, true);
  assert.deepEqual(promoteBuild.rows.map((r) => r.tool), ['policy', 'dbt-trino', 'trino']);
  assert.match(promoteBuild.rows.find((r) => r.tool === 'policy')!.detail, /conformant/);

  // 3. Harmonize to Gold (on the asset), then Admin certifies → Gold Data Product
  buildVersion(d0.id, sara, 'gold', { quality: 'passing', artifact: 'gold/mart_orders.sql' });
  assert.equal((await build(getDataset(d0.id, sara), 'gold')).ok, true);
  const product = certify(d0.id, sara, { level: 'gold', visibility: 'shared' });
  assert.equal(product.tier, 'product');
  assert.equal((await build(product, 'certify')).ok, true); // om → policy (conformance gate)

  // 4. Define a metric on the governed Gold (Cube handover), then build the dashboard
  const withMetric = defineMeasure(d0.id, sara, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  assert.equal((await build(withMetric, 'metric')).ok, true); // cube → om
  assert.equal((await build(withMetric, 'dashboard')).ok, true); // superset → om

  // 5. Lineage spans both axes; transparency green
  const lin = lineageFor(getDataset(d0.id, sara));
  assert.deepEqual(lin.nodes.filter((n) => n.kind === 'version').map((n) => n.id), ['v:bronze', 'v:silver', 'v:gold']);
  assert.ok(lin.edges.some((e) => e.from === 'v:gold' && e.to === 'm:revenue'));
  assert.equal(lin.transparency.ok, true);

  // 6. Another domain imports it (Builder+) → conformance still green
  importProduct(d0.id, finBuilder);
  assert.equal(runConformance([getDataset(d0.id, kenji)], MOCK_ROSTER).ok, true);
});

test('Orders both ways: the data agent reads exactly the governed product the UI built', async () => {
  // Stand up the certified, imported product as above (compact).
  const d0 = createDataset(amir, { name: 'Orders' });
  buildVersion(d0.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d0.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  setDocs(d0.id, amir, { description: 'Orders.', columns: [{ name: 'order_id', description: 'k' }, { name: 'net_amount', description: 'v' }] });
  applyApprovedPromotion(requestPromotion(d0.id, amir, { visibility: 'domain' }), bea);
  buildVersion(d0.id, sara, 'gold', { quality: 'passing', artifact: 'g' });
  const product = certify(d0.id, sara, { level: 'gold', visibility: 'shared' });
  importProduct(d0.id, finBuilder); // finance imports it (Builder+)
  defineMeasure(d0.id, sara, { name: 'revenue', type: 'sum', sql: 'net_amount' });

  const governed = getDataset(d0.id, sara);
  const compiled = compilePolicy([governed], MOCK_ROSTER);
  const fqn = tableFqn(governed);

  // Executors that HONOUR the compiled OPA policy (Trino RLS) — so the agent's access
  // reflects exactly the grants the guided UI set.
  function execFor(): Executors {
    return {
      async authorize() { return { allowed: true, policy: 'opa-allow' }; },
      async trinoQuery(_sql, principal) {
        const id = { user: principal, domains: MOCK_ROSTER[principal]?.domains ?? [] };
        const entitled = evaluateOpa(compiled.opa, id, fqn).entitled;
        return { columns: ['order_id', 'net_amount'], rows: entitled ? [['1', '100']] : [] }; // RLS: no rows if not entitled
      },
      async cubeQuery() { return { rows: [{ revenue: 100 }] }; },
      async sandboxQuery() { return { columns: ['c'], rows: [['x']] }; },
      async trace() { return true; },
      assertSandboxScoped,
    };
  }

  // amir (sales, owner-domain) — the domain tool returns rows over the SAME FQN.
  const amirClaims = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'creator' });
  const amirRes = await runAgentTool(amirClaims, { scope: 'domain', kind: 'query', sql: `select * from ${fqn}` }, execFor());
  assert.equal(amirRes.rows!.length, 1); // sees rows

  // kenji (finance) imported it → marketplace scope sees rows (the import grant).
  const kenjiClaims = claimsFromUser({ id: 'kenji', domains: ['finance'], role: 'creator' });
  const kenjiRes = await runAgentTool(kenjiClaims, { scope: 'marketplace', kind: 'query', sql: `select * from ${fqn}` }, execFor());
  assert.equal(kenjiRes.rows!.length, 1); // imported → entitled

  // a user in a domain that never imported/was-granted is denied (RLS → no rows).
  const denied = evaluateOpa(compiled.opa, { user: 'zoe', domains: ['marketing'] }, fqn).entitled;
  assert.equal(denied, false);
  const zoeRes = await runAgentTool(
    claimsFromUser({ id: 'zoe', domains: ['marketing'], role: 'creator' }),
    { scope: 'marketplace', kind: 'query', sql: `select * from ${fqn}` },
    execFor(),
  );
  assert.equal(zoeRes.rows!.length, 0); // governed-denied → no rows

  // the metrics tool resolves the SAME Cube view the UI defined.
  const metric = await runAgentTool(amirClaims, { scope: 'domain', kind: 'metrics', query: { measures: [`${cubeFor(governed)}.revenue`] } }, execFor());
  assert.equal(metric.source, 'cube');
  assert.equal((metric.data as { revenue: number }[])[0].revenue, 100);

  // personal scope never touches the governed product — it stays in the user's sandbox.
  await assert.rejects(
    runAgentTool(amirClaims, { scope: 'personal', kind: 'query', sql: `select * from ${fqn}` }, execFor()),
    /governed/i,
  );
  void product;
});
