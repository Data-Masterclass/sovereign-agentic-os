/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createDataset,
  buildVersion,
  setDocs,
  requestPromotion,
  getDataset,
  listGovernedDatasets,
  type Principal,
  type PromotionRequest,
} from './store.ts';
import { DatasetError, type Dataset } from './dataset-schema.ts';
import { publishApprovedPromotion, type PublishWrite } from './publish.ts';
import { publishPlan } from './transform.ts';
import { buildCubeModels } from './cube-models.ts';
import { governanceFor } from './policy/compiler.ts';
import type { DataBuildReport } from './build/orchestrate.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' }; // requester
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' }; // approver
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

/** A documented dataset owned by amir with the given layers built. */
function ready(layers: ('silver' | 'gold')[] = ['silver', 'gold']): { id: string; req: PromotionRequest } {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  for (const l of layers) buildVersion(d.id, amir, l, { quality: 'passing', artifact: l[0] });
  setDocs(d.id, amir, { description: 'Sales orders.', columns: [{ name: 'order_id', description: 'Key.' }] });
  const req = requestPromotion(d.id, amir, { visibility: 'domain' });
  return { id: d.id, req };
}

type BuildCall = { dataset: Dataset; principal: string; write: PublishWrite };

/** A fake build runner capturing what the publish threads into the promote stage. */
function fakeBuild(ok: boolean, error = 'Trino: TABLE_NOT_FOUND iceberg.personal_amir.gold_orders') {
  const calls: BuildCall[] = [];
  const report: DataBuildReport & { mode: string } = ok
    ? { ok: true, rows: [{ tool: 'dbt-trino', applied: true, verified: true, status: 'ok', detail: 'ok' }], skipped: [], mode: 'live' }
    : { ok: false, rows: [{ tool: 'dbt-trino', applied: false, verified: false, status: 'fail', detail: error, error }], skipped: [], mode: 'live' };
  return {
    calls,
    deps: {
      async buildPromote(dataset: Dataset, principal: string, write: PublishWrite) {
        calls.push({ dataset, principal, write });
        return report;
      },
    },
  };
}

test('approval triggers a REAL apply: the promote CTAS is executed with the APPROVER identity', async () => {
  const { req } = ready();
  const fb = fakeBuild(true);
  const out = await publishApprovedPromotion(req, bea, fb.deps);
  assert.equal(out.ok, true);
  assert.equal(fb.calls.length, 1);
  const { write, principal } = fb.calls[0];
  // Separation of duties: the identity threaded into executeRun is the APPROVER —
  // uid AND Trino session principal — never the requester.
  assert.equal(write.identity.uid, 'bea');
  assert.equal(write.identity.principal, 'bea');
  assert.equal(write.identity.role, 'builder');
  assert.notEqual(write.identity.uid, req.owner);
  assert.equal(principal, 'bea');
  // The CTAS copies the requester's personal gold table into the governed target.
  assert.equal(
    write.transformSql,
    'create or replace table iceberg.sales.gold_orders as select * from iceberg.personal_amir.gold_orders',
  );
  assert.equal(write.schemaSql, 'create schema if not exists iceberg.sales');
  assert.equal(write.releaseSchema, 'personal_amir');
});

test('the promote build sees the POST-promotion governance so OPA gets the promoted FQN', async () => {
  const { req } = ready();
  const fb = fakeBuild(true);
  await publishApprovedPromotion(req, bea, fb.deps);
  const preview = fb.calls[0].dataset;
  assert.equal(preview.tier, 'asset'); // the build's policy adapter compiles THIS
  const g = governanceFor(preview);
  assert.ok(g, 'the preview compiles to a governance entry (a private dataset would not)');
  assert.equal(g!.fqn, 'iceberg.sales.gold_orders'); // the published FQN lands in the OPA push
  assert.equal(g!.domain, 'sales');
});

test('HONESTY: a failed materialization leaves the tier unchanged + surfaces the real error', async () => {
  const { id, req } = ready();
  const fb = fakeBuild(false);
  const out = await publishApprovedPromotion(req, bea, fb.deps);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /TABLE_NOT_FOUND/);
  assert.equal(getDataset(id, amir).tier, 'dataset', 'tier must NOT flip on a failed publish');
});

test('success: the tier flips AND the Cube models payload includes the new view', async () => {
  const { id, req } = ready();
  const out = await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  assert.equal(out.ok, true);
  const ds = getDataset(id, bea);
  assert.equal(ds.tier, 'asset');
  assert.ok(out.ok && out.cubeView, 'the promoted Gold dataset appears in /api/cube/models');
  assert.equal(out.ok && out.fqn, 'iceberg.sales.gold_orders');
});

test('Gold publish auto-registers a COMPLETE, queryable Cube model — no define_metric needed', async () => {
  // A dataset the user NEVER ran define_metric on: zero measures, gold columns documented.
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'g' });
  setDocs(d.id, amir, {
    description: 'Sales orders.',
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
  });
  const req = requestPromotion(d.id, amir, { visibility: 'domain' });

  const out = await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  assert.equal(out.ok, true);

  // The Cube model the sync sidecar reads is emitted from the SAME governed source.
  const model = buildCubeModels(listGovernedDatasets()).models.find((m) => m.name === 'orders');
  assert.ok(model, 'the Gold dataset is auto-registered as a Cube model');
  // Measures auto-fall back to `count` (queryable without any user-defined metric).
  assert.deepEqual(model!.measures, ['count']);
  assert.match(model!.model, /name: count\n\s+type: count/);
  // Dimensions are derived AUTOMATICALLY from the gold columns — no manual step.
  assert.match(model!.model, /dimensions:/);
  assert.match(model!.model, /name: order_id/);
  assert.match(model!.model, /name: region/);
  assert.match(model!.model, /name: net_amount/);
  // It binds to the built Gold mart, so the semantic model is actually queryable.
  assert.match(model!.model, /sql_table: iceberg\.sales\.gold_orders/);
});

test('a silver-only promotion publishes silver_<slug> and honestly reports no Cube view', async () => {
  const { req } = ready(['silver']);
  const fb = fakeBuild(true);
  const out = await publishApprovedPromotion(req, bea, fb.deps);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.fqn, 'iceberg.sales.silver_orders');
  assert.match(fb.calls[0].write.transformSql, /iceberg\.personal_amir\.silver_orders$/);
  assert.equal(out.ok && out.cubeView, null); // no Gold ⇒ not Cube-deliverable
});

test('separation of duties: the requesting creator cannot approve (no build is even run)', async () => {
  const { req } = ready();
  const fb = fakeBuild(true);
  await assert.rejects(
    () => publishApprovedPromotion(req, amir, fb.deps),
    (e: DatasetError) => e.status === 403,
  );
  assert.equal(fb.calls.length, 0, 'nothing may reach the write path');
});

test('a cross-domain builder cannot approve/publish', async () => {
  const { req } = ready();
  const fb = fakeBuild(true);
  await assert.rejects(
    () => publishApprovedPromotion(req, { ...kenji, role: 'builder' }, fb.deps),
    (e: DatasetError) => e.status === 403,
  );
  assert.equal(fb.calls.length, 0);
});

test('double publish is rejected once the dataset is already an asset (409)', async () => {
  const { req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  await assert.rejects(
    () => publishApprovedPromotion(req, bea, fakeBuild(true).deps),
    (e: DatasetError) => e.status === 409,
  );
});

test('publishPlan target always equals the promotion target (one FQN contract)', () => {
  const { id, req } = ready();
  const plan = publishPlan(getDataset(id, amir));
  assert.equal(plan.target, req.target);
  assert.equal(plan.sourceSchema, 'personal_amir');
  // Guard-shape: one statement, no comments, no ';' — accepted verbatim by /execute.
  assert.ok(!plan.sql.includes(';') && !plan.sql.includes('--'));
});
