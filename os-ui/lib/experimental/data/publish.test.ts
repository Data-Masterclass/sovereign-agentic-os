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
  transition,
  renameDataset,
  type Principal,
  type PromotionRequest,
} from './store.ts';
import { DatasetError, type Dataset } from './dataset-schema.ts';
import { publishApprovedPromotion, type PublishWrite } from './publish.ts';
import { assetTarget } from './store-fqn.ts';
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

/** A fake build runner capturing what the publish threads into the promote stage.
 *  `domainTableLive` models the independent #96 post-CTAS probe: true ⇒ the governed
 *  gold really landed in the domain schema; false ⇒ the flip must be refused. */
function fakeBuild(
  ok: boolean,
  error = 'Trino: TABLE_NOT_FOUND iceberg.personal_amir.gold_orders',
  domainTableLive = true,
) {
  const calls: BuildCall[] = [];
  const probes: { fqn: string; principal: string }[] = [];
  const report: DataBuildReport & { mode: string } = ok
    ? { ok: true, rows: [{ tool: 'dbt-trino', applied: true, verified: true, status: 'ok', detail: 'ok' }], skipped: [], mode: 'live' }
    : { ok: false, rows: [{ tool: 'dbt-trino', applied: false, verified: false, status: 'fail', detail: error, error }], skipped: [], mode: 'live' };
  return {
    calls,
    probes,
    deps: {
      async buildPromote(dataset: Dataset, principal: string, write: PublishWrite) {
        calls.push({ dataset, principal, write });
        return report;
      },
      async verifyDomainTable(fqn: string, principal: string) {
        probes.push({ fqn, principal });
        return domainTableLive;
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

test('promote-as-view: with asView the publish emits a VIEW + records domainArtifact:view', async () => {
  const { id, req } = ready();
  const fb = fakeBuild(true);
  const out = await publishApprovedPromotion(req, bea, { ...fb.deps, asView: true });
  assert.equal(out.ok, true);
  // The threaded statement is a governed VIEW over the owner's personal lane — NOT a CTAS copy.
  assert.equal(
    fb.calls[0].write.transformSql,
    'create or replace view iceberg.sales.gold_orders as select * from iceberg.personal_amir.gold_orders',
  );
  // The dataset records that its domain artifact is a view (demote/reconcile branch on this).
  assert.equal(getDataset(id, amir).domainArtifact, 'view');
  // The read path is UNCHANGED: consumers still read the same domain FQN.
  assert.equal(out.ok && out.fqn, 'iceberg.sales.gold_orders');
});

test('promote-as-view OFF (default): the publish is a physical CTAS copy, no view marker', async () => {
  const { id, req } = ready();
  const fb = fakeBuild(true);
  const out = await publishApprovedPromotion(req, bea, fb.deps); // asView omitted ⇒ table
  assert.equal(out.ok, true);
  assert.match(fb.calls[0].write.transformSql, /^create or replace table /);
  assert.equal(getDataset(id, amir).domainArtifact, undefined, 'table promote records no view marker');
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

test('#96 FAIL-CLOSED: a build ✓ but an ABSENT domain table refuses the flip (tier unchanged)', async () => {
  // The Northpeak gap: the build report is ✓ but the governed CTAS never landed the
  // gold in the domain schema (it lived only in personal_<owner>). The independent
  // post-CTAS probe returns false → the promotion is refused and the tier stays dataset.
  const { id, req } = ready();
  const fb = fakeBuild(true, undefined, /* domainTableLive */ false);
  await assert.rejects(
    () => publishApprovedPromotion(req, bea, fb.deps),
    (e: DatasetError) => e.status === 502 && /did not land iceberg\.sales\.gold_orders/.test(e.message),
  );
  assert.equal(getDataset(id, amir).tier, 'dataset', 'tier must NOT flip when the domain table is absent');
  // The probe targeted the exact promoted domain FQN, as the approving Builder.
  assert.deepEqual(fb.probes, [{ fqn: 'iceberg.sales.gold_orders', principal: 'sales' }]);
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
  // #155: a NEW dataset gets the domain-namespaced cube identity (`sales__orders`).
  const model = buildCubeModels(listGovernedDatasets()).models.find((m) => m.name === 'sales__orders');
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

// ── Northpeak fix: STALE domain tables + re-materialization on source rebuild ──
// The bug pair: (a) a promoted dataset's Gold rebuild rewrote only the personal lane —
// the governed domain table (what Cube reads) silently kept the PRIOR snapshot;
// (b) nothing ever re-ran the publish CTAS. Now the rebuild FLAGS the drift and
// `rematerializeDomainTable` re-runs the same governed CTAS + probe, clearing it.

test('rebuilding a PROMOTED dataset’s gold flags the domain table STALE (visible, never silent)', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  assert.equal(getDataset(id, amir).domainTableStale, undefined, 'in sync right after promotion');
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' }); // the source rebuild
  assert.equal(getDataset(id, amir).domainTableStale, true, 'the drift is flagged');
  // The visible stale state reaches the tile summary too (a promoted asset lists
  // under the domain group for its owner).
  const { listDatasets } = await import('./store.ts');
  const groups = listDatasets(amir);
  const summary = [...groups.mine, ...groups.domain, ...groups.marketplace].find((s) => s.id === id);
  assert.equal(summary?.domainTableStale, true);
});

test('a BRONZE build (sync freshness) does not flag the domain table', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  buildVersion(id, amir, 'bronze', { quality: 'passing', artifact: 'b2' });
  assert.equal(getDataset(id, amir).domainTableStale, undefined);
});

test('an UN-promoted dataset never carries the stale flag', () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'g' });
  assert.equal(getDataset(d.id, amir).domainTableStale, undefined);
});

test('re-materialize re-runs the SAME publish CTAS (right FQNs) as the operating Builder and clears STALE', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  assert.equal(getDataset(id, amir).domainTableStale, true);

  const { rematerializeDomainTable } = await import('./publish.ts');
  const fb = fakeBuild(true);
  const out = await rematerializeDomainTable(id, bea, fb.deps);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.fqn, 'iceberg.sales.gold_orders');
  // The refresh CTAS copies the owner's freshly-rebuilt personal gold → the domain schema.
  assert.equal(fb.calls.length, 1);
  assert.equal(
    fb.calls[0].write.transformSql,
    'create or replace table iceberg.sales.gold_orders as select * from iceberg.personal_amir.gold_orders',
  );
  assert.equal(fb.calls[0].write.identity.uid, 'bea', 'runs AS the operator (Builder write floor)');
  assert.equal(fb.calls[0].write.releaseSchema, 'personal_amir');
  // The independent probe re-checked the exact domain target before clearing the flag.
  assert.deepEqual(fb.probes, [{ fqn: 'iceberg.sales.gold_orders', principal: 'sales' }]);
  assert.equal(getDataset(id, amir).domainTableStale, undefined, 'STALE cleared on ✓');
});

test('promote-as-view: a rebuild NEVER flags the view stale (a view is a live pass-through)', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, { ...fakeBuild(true).deps, asView: true });
  assert.equal(getDataset(id, amir).domainArtifact, 'view');
  // Rebuilding the owner's personal Gold would flag a TABLE-promoted dataset stale; a VIEW
  // reads through live, so it must stay in sync.
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  assert.equal(getDataset(id, amir).domainTableStale, undefined, 'a view never drifts');
});

test('promote-as-view: re-materialize is a NO-OP (no CTAS re-run) and reports ok on the view FQN', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, { ...fakeBuild(true).deps, asView: true });
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  const { rematerializeDomainTable } = await import('./publish.ts');
  const fb = fakeBuild(true);
  const out = await rematerializeDomainTable(id, bea, fb.deps);
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.fqn, 'iceberg.sales.gold_orders');
  // No CTAS re-run and no probe — a view is always-materialized by construction.
  assert.equal(fb.calls.length, 0, 'no CTAS re-run for a view');
  assert.equal(fb.probes.length, 0, 'no probe for a view');
});

test('re-materialize is idempotent: refreshing an already-in-sync table is a harmless ✓', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  const { rematerializeDomainTable } = await import('./publish.ts');
  const out = await rematerializeDomainTable(id, bea, fakeBuild(true).deps);
  assert.equal(out.ok, true);
  assert.equal(getDataset(id, amir).domainTableStale, undefined);
});

test('HONESTY: a failed refresh CTAS leaves the STALE flag set + surfaces the real error', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  const { rematerializeDomainTable } = await import('./publish.ts');
  const out = await rematerializeDomainTable(id, bea, fakeBuild(false).deps);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /TABLE_NOT_FOUND/);
  assert.equal(getDataset(id, amir).domainTableStale, true, 'still honestly stale');
});

test('FAIL-CLOSED: a refresh whose domain probe fails throws 502 and keeps the STALE flag', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  const { rematerializeDomainTable } = await import('./publish.ts');
  await assert.rejects(
    () => rematerializeDomainTable(id, bea, fakeBuild(true, undefined, /* domainTableLive */ false).deps),
    (e: DatasetError) => e.status === 502,
  );
  assert.equal(getDataset(id, amir).domainTableStale, true);
});

test('the domain-schema write floor: a creator cannot re-materialize (honest stale outcome, no build)', async () => {
  const { id, req } = ready();
  await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'g2' });
  const { rematerializeDomainTable } = await import('./publish.ts');
  const fb = fakeBuild(true);
  const out = await rematerializeDomainTable(id, amir, fb.deps); // amir is a creator
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /Builder/);
  assert.equal(fb.calls.length, 0, 'nothing reaches the write path');
  assert.equal(getDataset(id, amir).domainTableStale, true);
});

test('re-materialize refuses a dataset that was never promoted', async () => {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  const { rematerializeDomainTable } = await import('./publish.ts');
  // As the owner (a private dataset isn't even VISIBLE to a non-owner builder — canView).
  const out = await rematerializeDomainTable(d.id, amir, fakeBuild(true).deps);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /not promoted/);
});

// ── ZOMBIE-ASSET ROUND-TRIP (0.6.141 root-cause prevention): promote → demote → re-promote ──
// The durable invariant: a dataset must never claim SERVED without a physical domain table.
// promote flips to asset (fail-closed: the table must exist) AND appears in the governed/Cube
// list; a demote (unshare) moves it back to `dataset` so it LEAVES the governed serving set
// (no zombie); a re-promote is fail-closed AGAIN (a build ✓ with an absent table is refused).

test('round-trip: promote → served & in the governed list; demote → NOT served (no zombie); re-promote → fail-closed again', async () => {
  const { id, req } = ready();

  // PROMOTE — fail-closed materialization gate + the tier flips to a served asset.
  const up = await publishApprovedPromotion(req, bea, fakeBuild(true).deps);
  assert.equal(up.ok, true);
  assert.equal(getDataset(id, amir).tier, 'asset');
  assert.ok(listGovernedDatasets().some((d) => d.id === id), 'a served asset is in the Cube/governed set');

  // DEMOTE (unshare) — the store moves it OUT of the domain tier, so it can no longer be
  // read as a served domain asset (dropped from listGovernedDatasets → Cube stops serving it).
  // Unshare needs BOTH the Builder floor AND govern authority (owner / in-domain admin) — a
  // domain_admin in the dataset's domain satisfies both (the DemoteButton's real actor).
  const dom: Principal = { id: 'dora', domains: ['sales'], role: 'domain_admin' };
  const demoted = transition(id, dom, 'unshare');
  assert.equal(demoted.tier, 'dataset', 'back to a private dataset');
  assert.equal(demoted.owner, amir.id, 'ownership stays with the ORIGINAL creator after demote');
  assert.equal(demoted.slug, undefined, 'the physical slug is never pinned → personal lane byte-stable across the round-trip');
  assert.equal(demoted.grants.length, 0, 'sharing grants are dropped');
  assert.ok(!listGovernedDatasets().some((d) => d.id === id), 'a demoted dataset is NOT served (no zombie)');

  // RE-PROMOTE — fail-closed is re-enforced: a build ✓ but an ABSENT domain table refuses the
  // flip (tier stays dataset), so a re-promote can never resurrect a served-but-empty zombie.
  const req2 = requestPromotion(id, amir, { visibility: 'domain' });
  await assert.rejects(
    () => publishApprovedPromotion(req2, bea, fakeBuild(true, undefined, /* domainTableLive */ false).deps),
    (e: DatasetError) => e.status === 502,
  );
  assert.equal(getDataset(id, amir).tier, 'dataset', 'a re-promote whose CTAS did not land does NOT flip');

  // A re-promote whose CTAS DOES land flips it back to a served asset — the happy path is intact.
  const req3 = requestPromotion(id, amir, { visibility: 'domain' });
  const up2 = await publishApprovedPromotion(req3, bea, fakeBuild(true).deps);
  assert.equal(up2.ok, true);
  assert.equal(getDataset(id, amir).tier, 'asset');
  assert.ok(listGovernedDatasets().some((d) => d.id === id), 're-promote restores serving');
});

// ── PROMOTE COLLISION GUARD (data-loss, name/slug collision) ──
// The bug: the domain table is keyed on the name-slug, not the id, so two datasets that
// resolve to the same `gold_<slug>` in ONE domain overwrite each other and orphan a sibling.
// The guard REJECTS the colliding promote (409) rather than pinning a physical slug — the slug
// also names the owner's personal-lane table, so mutating it would break the owner's own dataset
// and the promote→demote round-trip. Rename, then promote into your own shared table.

/** A ready-to-promote dataset with an explicit NAME (unique within the domain). */
function readyNamed(name: string): { id: string; req: PromotionRequest } {
  const d = createDataset(amir, { name });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'g' });
  setDocs(d.id, amir, { description: 'Docs.', columns: [{ name: 'k', description: 'Key.' }] });
  const req = requestPromotion(d.id, amir, { visibility: 'domain' });
  return { id: d.id, req };
}

test('promote collision: a second dataset colliding on an already-claimed gold table is REJECTED (409), personal slug never mutated', async () => {
  // A: name "Web Orders" → slug web_orders. Rename it so the NAME "Web Orders" frees up,
  // but A KEEPS the frozen physical slug web_orders (the real rename→slug-clash mechanism).
  const a = readyNamed('Web Orders');
  renameDataset(a.id, amir, 'Alpha'); // A.slug is now pinned to web_orders
  await publishApprovedPromotion(a.req, bea, fakeBuild(true).deps);
  assert.equal(getDataset(a.id, amir).tier, 'asset');
  assert.equal(assetTarget(getDataset(a.id, amir)), 'iceberg.sales.gold_web_orders');

  // B: name "Web Orders" (free now) → name-slug web_orders → SAME domain gold table as A.
  const b = readyNamed('Web Orders');
  assert.equal(assetTarget(getDataset(b.id, amir)), 'iceberg.sales.gold_web_orders', 'pre-guard: B collides with A');

  // The colliding promote is REJECTED with an actionable 409 — never silently overwriting A,
  // and CRUCIALLY never pinning B's physical slug (which also names B's personal-lane table).
  await assert.rejects(
    () => publishApprovedPromotion(b.req, bea, fakeBuild(true).deps),
    (e: DatasetError) => e.status === 409,
  );
  const bAfter = getDataset(b.id, amir);
  assert.equal(bAfter.tier, 'dataset', 'B stays a private dataset — the promote did not flip');
  assert.equal(bAfter.slug, undefined, "B's physical slug is NEVER mutated (personal lane byte-stable)");
  // A still owns its table, untouched.
  assert.equal(assetTarget(getDataset(a.id, amir)), 'iceberg.sales.gold_web_orders');
});

test('promote collision: a UNIQUE target promotes untouched (byte-stable, personal slug never pinned)', async () => {
  const only = readyNamed('Lonely Dataset');
  const before = getDataset(only.id, amir);
  assert.equal(before.slug, undefined, 'no slug pinned before promotion');
  const out = await publishApprovedPromotion(only.req, bea, fakeBuild(true).deps);
  assert.equal(out.ok, true);
  const after = getDataset(only.id, amir);
  assert.equal(after.slug, undefined, 'a unique dataset is NEVER slug-pinned');
  assert.equal(out.ok && out.fqn, 'iceberg.sales.gold_lonely_dataset');
});
