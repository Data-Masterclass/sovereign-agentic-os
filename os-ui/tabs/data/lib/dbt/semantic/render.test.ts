/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The semantic layer really appears in the generated dbt project, in the right lane
 * USER STORY: As a data engineer I want `models/semantic/<model>.yml` in the tree I clone, with the
 *             time spine beside it, every `ref()` naming a model that EXISTS, and the whole file
 *             parsing back into the OS model (checklist M1, M3, M9, M12).
 * ARCHITECTURE:
 *   - Drives the real `generateProject`, so what is asserted is what is committed. Literal
 *     fixtures, no store, no cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset, Measure } from '@tabs/data/lib/dataset-schema';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import { emitSemanticYaml, parseSemanticYaml } from '@tabs/data/lib/dbt/semantic/model';
import { isSafeSemanticExpr, validateSemanticDoc } from '@tabs/data/lib/dbt/semantic/validate';
import { TIME_SPINE_SQL_PATH, TIME_SPINE_YML_PATH, TIME_SPINE_MODEL } from '@tabs/data/lib/dbt/semantic/time-spine';

const built = (artifact: string | null, passThrough = false) => ({
  built: true,
  passThrough,
  quality: 'unknown' as const,
  updatedAt: '2026-11-14T00:00:00.000Z',
  artifact,
});

function orders(measures: Measure[], extra: Partial<Dataset> = {}): Dataset {
  return {
    version: '1',
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Orders.',
    versions: { bronze: built('bronze/o.dlt.yml'), silver: built('silver/o.sql', true), gold: built('gold/o.sql', true) },
    grants: [],
    measures,
    columns: [
      { name: 'order_id', description: 'Key' },
      { name: 'order_date', description: 'Date' },
      { name: 'net_amount', description: 'Amount' },
    ],
    viewNamespaced: false,
    ...extra,
  } as Dataset;
}

function snap(d: Dataset): ProjectSnapshot {
  return { domain: 'sales', datasets: [{ dataset: d, artifacts: {} }], catalogs: {} };
}

const REVENUE: Measure[] = [{ name: 'revenue', type: 'sum', sql: 'net_amount' }];

test('the semantic file lands in the generated tree, and its ref() names a model that EXISTS', () => {
  const files = generateProject('sales', snap(orders(REVENUE)));
  const path = 'models/semantic/orders.yml';
  const text = files.get(path);
  assert.ok(text, `expected ${path} in: ${[...files.keys()].join(', ')}`);
  const doc = parseSemanticYaml(text);
  const ref = /^ref\('(.+)'\)$/.exec(doc.semantic_models[0].model)![1];
  assert.ok(files.has(`models/gold/${ref}.sql`), `ref('${ref}') must name a model file in this project`);
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('the generated semantic file ROUND-TRIPS: parse → re-emit is byte-identical', () => {
  const text = generateProject('sales', snap(orders(REVENUE))).get('models/semantic/orders.yml')!;
  assert.equal(emitSemanticYaml(parseSemanticYaml(text)), text);
});

test('a personal (un-promoted) dataset keeps its semantic file in the owner lane (M-R6.3)', () => {
  const personal = generateProject('sales', snap(orders(REVENUE, { tier: 'dataset', visibility: 'private' })));
  assert.ok(personal.has('models/personal/amir/semantic/orders.yml'));
  assert.equal(personal.has('models/semantic/orders.yml'), false);
  // Promotion moves the file exactly as it moves the model — the only diff is the lane.
  const promoted = generateProject('sales', snap(orders(REVENUE)));
  assert.ok(promoted.has('models/semantic/orders.yml'));
  assert.equal(
    promoted.get('models/semantic/orders.yml')!.replace(/gold_orders/g, 'X'),
    personal.get('models/personal/amir/semantic/orders.yml')!.replace(/gold_orders/g, 'X'),
  );
});

test('the time spine is generated for a domain with a time dimension, and not for one without', () => {
  const withTime = generateProject('sales', snap(orders(REVENUE)));
  assert.ok(withTime.has(TIME_SPINE_SQL_PATH));
  assert.match(withTime.get(TIME_SPINE_YML_PATH)!, /time_spine:\n\s+standard_granularity_column: date_day/);
  assert.match(withTime.get(TIME_SPINE_YML_PATH)!, /granularity: day/);
  assert.match(withTime.get(TIME_SPINE_SQL_PATH)!, /materialized='view'/);
  assert.match(withTime.get(TIME_SPINE_SQL_PATH)!, /sequence\(date '\d{4}-\d{2}-\d{2}', current_date \+ interval '\d+' day, interval '1' day\)/);
  // dbt <= 1.8 discovered a spine BY NAME; that name must never be what the OS emits.
  assert.doesNotMatch(withTime.get(TIME_SPINE_YML_PATH)!, /metricflow_time_spine/);
  assert.equal(TIME_SPINE_MODEL, 'os_time_spine_day');

  const noTime = generateProject(
    'sales',
    snap(orders(REVENUE, { columns: [{ name: 'order_id', description: 'Key' }, { name: 'net_amount', description: 'Amount' }] })),
  );
  assert.equal(noTime.has(TIME_SPINE_SQL_PATH), false, 'no time dimension ⇒ no spine');
  // …and no semantic file either (review H-1): dbt requires an agg_time_dimension for every
  // measure, so a dataset with no time column has no valid dbt artefact at all.
  assert.equal(noTime.has('models/semantic/orders.yml'), false);
  assert.match(noTime.get('README.md')!, /### Not emitted/);
  assert.match(noTime.get('README.md')!, /no time dimension/);
});

test('a dataset with no metric gets no semantic file at all', () => {
  const files = generateProject('sales', snap(orders([])));
  assert.deepEqual([...files.keys()].filter((k) => k.includes('semantic')), []);
  assert.equal(files.has(TIME_SPINE_SQL_PATH), false);
});

test('regeneration is idempotent: the semantic half of two generations is byte-identical', () => {
  const a = generateProject('sales', snap(orders(REVENUE)));
  const b = generateProject('sales', snap(orders(REVENUE)));
  for (const k of [...a.keys()].filter((x) => x.includes('semantic') || x.includes('os_time_spine'))) {
    assert.equal(a.get(k), b.get(k), k);
  }
});

test('every generated semantic file is spec-valid and carries no live Jinja beyond the filter grammar', () => {
  const files = generateProject(
    'sales',
    snap(
      orders([
        ...REVENUE,
        { name: 'orders', type: 'count', sql: '' },
        { name: 'aov', type: 'number', sql: '1.0 * {revenue} / {orders}' },
        // REVIEW M-2: `expr` reaches dbt through Jinja AND as SQL, and its content comes from
        // authored input — so a column carrying a template must not survive into the file.
        { name: 'smuggled', type: 'sum', sql: "{{ env_var('SECRET_TOKEN') }}" },
      ], { description: "Orders {{ env_var('SECRET_TOKEN') }}" }),
    ),
  );
  const text = files.get('models/semantic/orders.yml')!;
  assert.deepEqual(validateSemanticDoc(parseSemanticYaml(text)), []);
  for (const m of text.matchAll(/\{\{(.*?)\}\}/g)) {
    assert.match(m[1], / (?:Dimension|TimeDimension)\('/, `unexpected Jinja in the semantic file: ${m[0]}`);
  }
  // `stripJinja` strips the DELIMITERS; the call text survives as inert prose, which is the whole
  // contract (prose has no business being a template, and nothing real is lost).
  assert.match(text, /description: Orders env_var\('SECRET_TOKEN'\)/);
  // The smuggled `expr` is stripped the same way, and then REFUSED by the closed grammar — the
  // quotes and parentheses that survive stripping are not in it — so the measure never lands.
  // The token NAME survives in the description as inert prose (asserted above); what must not
  // survive anywhere is a live delimiter, and the smuggled measure must not land at all.
  assert.doesNotMatch(text, /- name: smuggled/);
  assert.doesNotMatch(text, /expr:.*SECRET_TOKEN/);
  // One bad measure costs ONE measure: the other three metrics on the dataset still land, and the
  // refusal is named in the project README.
  assert.match(text, /- name: revenue$/m);
  assert.match(text, /- name: aov$/m);
  assert.match(files.get('README.md')!, /`smuggled`.*closed expr grammar/);
});

test('REVIEW M-2: an `expr` carrying Jinja is stripped on emit AND refused by the closed grammar', () => {
  for (const bad of ["{{ env_var('X') }}", '{% if 1 %}a{% endif %}', "a' or '1'='1", 'a; drop table t', 'a -- comment', 'a /* c */']) {
    assert.equal(isSafeSemanticExpr(bad), false, `should be refused: ${bad}`);
  }
  for (const ok of ['net_amount', 'revenue / orders', '(revenue - cost) * 100 / orders', 'coalesce(a, 0)']) {
    assert.equal(isSafeSemanticExpr(ok), true, ok);
  }
  // Emission strips the delimiters even when a caller hands the model a template directly.
  const emitted = emitSemanticYaml({
    semantic_models: [
      {
        name: 'x',
        model: "ref('gold_x')",
        defaults: { agg_time_dimension: 'd' },
        entities: [{ name: 'x', type: 'primary', expr: 'id' }],
        dimensions: [{ name: 'd', type: 'time', type_params: { time_granularity: 'day' }, expr: "{{ d }}" }],
        measures: [{ name: 'm', agg: 'sum', expr: "{{ env_var('T') }}" }],
      },
    ],
    metrics: [{ name: 'm', type: 'simple', type_params: { measure: { name: 'm' } } }],
  });
  assert.doesNotMatch(emitted, /\{\{|\}\}|\{%|%\}/);
});
