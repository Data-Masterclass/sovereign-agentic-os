/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, type Dataset } from './dataset-schema.ts';
import { buildCubeModels } from './cube-models.ts';
import { buildDbtModelSql, buildDbtSchemaYaml, dbtModelPath, dbtSchemaPath } from './analytics-repo.ts';
import { CUBE_ARTIFACT } from './metrics.ts';
import {
  isOsManagedPath,
  pathToDataset,
  reemit,
  reemitExposures,
  decideFile,
  planApply,
} from './analytics-apply.ts';

/**
 * Unit tests for the analytics APPLY pure core (epic #146 Phase 1). No network —
 * the mapping + round-trip verifier is exercised directly against fixtures. The
 * golden property throughout: what the MIRROR writes (`writeAnalyticsFiles` via the
 * shared emitters) is exactly what the APPLY accepts — one writer, one shape.
 */

function ds(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

/** The repo path the mirror writes a dataset's cube model to. */
function cubePath(d: Dataset): string {
  return `cube/models/metrics/${CUBE_ARTIFACT(d).replace(/^metrics\//, '')}`;
}

/** The exact cube bytes the mirror would write for a dataset. */
function cubeBytes(d: Dataset): string {
  return buildCubeModels([d]).models[0]!.model;
}

// ─── isOsManagedPath ─────────────────────────────────────────────────────────

test('isOsManagedPath: governed dbt, cube metrics, and exposures are OS-managed', () => {
  assert.ok(isOsManagedPath('dbt/models/governed/sales/gold_orders.sql'));
  assert.ok(isOsManagedPath('dbt/models/governed/sales/schema.yml'));
  assert.ok(isOsManagedPath('cube/models/metrics/orders.cube.yml'));
  assert.ok(isOsManagedPath('dbt/models/exposures.yml'));
});

test('isOsManagedPath: human-space paths are NOT OS-managed', () => {
  assert.ok(!isOsManagedPath('dbt/models/staging/stg_raw.sql'));
  assert.ok(!isOsManagedPath('dbt/tests/assert_positive.sql'));
  assert.ok(!isOsManagedPath('cube/models/seed/demo.cube.yml'));
  assert.ok(!isOsManagedPath('README.md'));
  assert.ok(!isOsManagedPath('dagster/schedules.yml'));
});

// ─── path → dataset inversion ────────────────────────────────────────────────

test('pathToDataset inverts the cube mirror path', () => {
  const d = ds();
  const hit = pathToDataset(cubePath(d), [d]);
  assert.ok(hit, 'cube path maps to a dataset');
  assert.equal(hit!.dataset.id, 'ds_orders');
  assert.equal(hit!.kind, 'cube');
});

test('pathToDataset inverts the dbt sql mirror path (gitBacked)', () => {
  const d = ds({ gitBacked: true });
  const path = dbtModelPath(d)!;
  const hit = pathToDataset(path, [d]);
  assert.ok(hit);
  assert.equal(hit!.kind, 'dbt-sql');
  assert.equal(hit!.dataset.id, 'ds_orders');
});

test('pathToDataset inverts the dbt schema.yml mirror path', () => {
  const d = ds({ gitBacked: true });
  const hit = pathToDataset(dbtSchemaPath(d), [d]);
  assert.ok(hit);
  assert.equal(hit!.kind, 'dbt-schema');
});

test('pathToDataset: namespaced (#155) cube path inverts to the right dataset', () => {
  const d = ds({ cubeNamespaced: true });
  // sales__orders.cube.yml → ds_orders
  const path = 'cube/models/metrics/sales__orders.cube.yml';
  const hit = pathToDataset(path, [d]);
  assert.ok(hit, 'namespaced cube path inverts');
  assert.equal(hit!.dataset.id, 'ds_orders');
});

test('pathToDataset returns null when no governed dataset owns the path', () => {
  const d = ds();
  const hit = pathToDataset('cube/models/metrics/nonexistent.cube.yml', [d]);
  assert.equal(hit, null);
});

// ─── round-trip re-emit ──────────────────────────────────────────────────────

test('reemit(cube) is byte-identical to the mirror cube output', () => {
  const d = ds();
  assert.equal(reemit(d, 'cube', [d]), cubeBytes(d));
});

test('reemit(dbt-sql) is byte-identical to buildDbtModelSql', () => {
  const d = ds({ gitBacked: true });
  assert.equal(reemit(d, 'dbt-sql', [d]), buildDbtModelSql(d));
});

test('reemit(dbt-schema) merges all git-backed datasets in the domain', () => {
  const d1 = ds({ id: 'ds_orders', name: 'Orders', gitBacked: true });
  const d2 = ds({ id: 'ds_customers', name: 'Customers', gitBacked: true,
    columns: [{ name: 'customer_id', description: 'PK.' }] });
  const out = reemit(d1, 'dbt-schema', [d1, d2]);
  assert.equal(out, buildDbtSchemaYaml([d1, d2]));
});

test('reemitExposures is byte-identical to the mirror exposures wrapping', () => {
  const d = ds();
  const out = reemitExposures([d]);
  assert.match(out ?? '', /^exposures:\nversion: 2\n\n/);
  // Round-trips: decideFile must accept exactly this content.
  const decision = decideFile({ path: 'dbt/models/exposures.yml', content: out! }, [d]);
  assert.ok(decision.ok, 'mirror exposures bytes round-trip through decideFile');
});

// ─── decideFile: accept / reject / ignore ────────────────────────────────────

test('decideFile ACCEPTS a cube file whose bytes match the emitter', () => {
  const d = ds();
  const decision = decideFile({ path: cubePath(d), content: cubeBytes(d) }, [d]);
  assert.ok(decision.ok, 'round-tripping cube file accepted');
  assert.equal(decision.kind, 'cube');
  assert.equal(decision.datasetId, 'ds_orders');
  assert.ok(!decision.ignored);
});

test('decideFile REJECTS a cube file hand-edited into a non-emitter shape (single-writer guard)', () => {
  const d = ds();
  const tampered = cubeBytes(d) + '\n# hand-edited line the emitter would never produce\n';
  const decision = decideFile({ path: cubePath(d), content: tampered }, [d]);
  assert.ok(!decision.ok, 'non-round-trippable cube file rejected');
  assert.match(decision.reason ?? '', /does not round-trip/);
  assert.match(decision.reason ?? '', /single-writer invariant/);
});

test('decideFile REJECTS a dbt sql file that does not round-trip', () => {
  const d = ds({ gitBacked: true });
  const path = dbtModelPath(d)!;
  const tampered = buildDbtModelSql(d)! + '\nunion all select * from evil\n';
  const decision = decideFile({ path, content: tampered }, [d]);
  assert.ok(!decision.ok);
  assert.equal(decision.kind, 'dbt-sql');
  assert.match(decision.reason ?? '', /does not round-trip/);
});

test('decideFile IGNORES a non-OS-managed (human-space) path — never rejected', () => {
  const d = ds();
  const decision = decideFile(
    { path: 'dbt/models/staging/stg_raw.sql', content: 'select 1' },
    [d],
  );
  assert.ok(decision.ok, 'human-space path is not the apply\'s business');
  assert.ok(decision.ignored, 'flagged ignored');
  assert.equal(decision.datasetId, undefined);
});

test('decideFile REJECTS an OS-managed path mapping to no governed dataset', () => {
  const d = ds();
  const decision = decideFile(
    { path: 'cube/models/metrics/ghost.cube.yml', content: 'cube: {}' },
    [d],
  );
  assert.ok(!decision.ok);
  assert.match(decision.reason ?? '', /maps to no governed dataset/);
});

// ─── planApply roll-up ───────────────────────────────────────────────────────

test('planApply ok=true when every OS-managed file round-trips (and human files ignored)', () => {
  const d = ds();
  const plan = planApply(
    [
      { path: cubePath(d), content: cubeBytes(d) },
      { path: 'dbt/models/staging/stg_raw.sql', content: 'select 1' }, // ignored
    ],
    [d],
  );
  assert.ok(plan.ok, 'plan ok when all round-trip');
  assert.equal(plan.decisions.length, 2);
});

test('planApply ok=false when ANY OS-managed file fails to round-trip', () => {
  const d = ds();
  const plan = planApply(
    [
      { path: cubePath(d), content: cubeBytes(d) },       // ok
      { path: cubePath(d), content: 'tampered' },          // reject
    ],
    [d],
  );
  assert.ok(!plan.ok, 'a single bad OS-managed file fails the whole apply');
});
