/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `schema.yml` per model directory — descriptions + quality rules as dbt tests
 * USER STORY: As a data engineer I want the OS's quality rules to be `schema.yml` tests
 *             (`not_null`, `unique`, `accepted_values`, `relationships`, plus the generator-shipped
 *             `range` and `not_blank`) so `dbt test` runs them and a violated rule fails the build
 *             (checklist D5).
 * ARCHITECTURE:
 *   - Pure renderer over the planner's models. One `schema.yml` per directory; a dataset's checks
 *     attach to its FURTHEST model (the layer the OS runs its checks on today). When that layer was
 *     built out of band (a source, not a model) the planner attaches the same tests to the source.
 *   - `data_tests` (dbt ≥ 1.8). Free-text intentions (checks without a `rule`) are recorded as
 *     `meta.os_intentions`, never faked as tests.
 *   - SAFETY (review M1/L7): a column name is interpolated UNQUOTED into test SQL by dbt, so a check
 *     whose column is not a plain identifier — or an `accepted_values` with no values — is recorded
 *     as an intention, never emitted as a test. The store refuses such columns at the gate too.
 *   - SAFETY (review B2-review-H2): an `accepted_values` VALUE reaches dbt as `'{{ value }}'`, a SQL
 *     literal with no escaping. A check holding a value `isSafeCheckValue` rejects becomes an
 *     intention as a WHOLE — never a test with the offending values quietly dropped, which would
 *     silently weaken the rule the author wrote. `store.addCheck` refuses them at the gate too.
 *   - SAFETY (`reference` / `relationships`): the referenced COLUMN is a plain identifier or the
 *     rule becomes an intention (`field` is interpolated unquoted into the test's SQL), and the
 *     referenced MODEL NAME never comes from authored text — it is resolved from the PLAN by
 *     `modelRefResolver`, because `to: ref('…')` is Jinja dbt evaluates at parse time. A reference
 *     to a dataset with no model in this project is an intention too: `ref()` on an unknown name
 *     fails `dbt parse`, which would take the whole domain's project down, not just that test.
 *   - SAFETY (review B2-review-H3): dbt renders `schema.yml` AS JINJA before reading it, so an
 *     authored description or name is template input. Every authored string this file emits goes
 *     through `emit.stripJinja` (`{% raw %}` does not protect a YAML scalar, and nothing in a
 *     description needs to survive as a template).
 */
import { isSafeCheckValue, type DataCheck, type Dataset } from '@tabs/data/lib/dataset-schema';
import { stripJinja, yml } from '@tabs/data/lib/dbt/emit';
import type { ModelPlan } from '@tabs/data/lib/dbt/models';

export type TestSpec = string | Record<string, unknown>;

/** The same rule the store enforces (`SAFE_COLUMN_RE`): letters, digits, underscore, not leading digit. */
export const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve a dataset id to the dbt MODEL NAME its tests attach to — the furthest (`tested`) model.
 * A `reference` rule can only become a `relationships` test when the referenced dataset HAS a model
 * in this project; otherwise there is nothing for `ref()` to name and the rule is recorded as an
 * intention rather than emitted against a guess.
 */
export function modelRefResolver(models: ModelPlan[]): (datasetId: string) => string | null {
  const byDataset = new Map<string, string>();
  for (const m of models) if (m.tested) byDataset.set(m.dataset.id, m.name);
  return (datasetId: string) => byDataset.get(datasetId) ?? null;
}

/** One check → one dbt test spec (null for a free-text intention or an unsafe / empty rule). */
export function checkToTest(check: DataCheck, resolveRef?: (datasetId: string) => string | null): TestSpec | null {
  if (!check.rule || !check.column || !SAFE_COLUMN.test(check.column.trim())) return null;
  switch (check.rule) {
    case 'not_null':
      return 'not_null';
    case 'unique':
      return 'unique';
    case 'not_blank':
      return 'not_blank';
    case 'accepted_values': {
      const raw = (check.values ?? []).map((v) => String(v).trim()).filter(Boolean);
      // ONE unsafe value disqualifies the whole check — emitting the rest would look like the
      // author's rule while enforcing a narrower one (review B2-review-H2).
      if (!raw.length || !raw.every(isSafeCheckValue)) return null;
      return { accepted_values: { values: raw } };
    }
    case 'range': {
      const args: Record<string, number> = {};
      if (typeof check.min === 'number') args.min = check.min;
      if (typeof check.max === 'number') args.max = check.max;
      return Object.keys(args).length ? { range: args } : null;
    }
    case 'reference': {
      // SAME safety gate as `accepted_values`, for the same reason: both halves of this test are
      // interpolated UNQUOTED by dbt — `field` into SQL, and the model name into `ref('…')`, which
      // is itself Jinja. So the referenced column must be a plain identifier, and the model name
      // must come from the PLAN (`modelRefResolver`), never from authored text.
      const toColumn = (check.toColumn ?? '').trim();
      const toDataset = (check.toDataset ?? '').trim();
      if (!toColumn || !SAFE_COLUMN.test(toColumn) || !toDataset) return null;
      const model = resolveRef?.(toDataset) ?? null;
      // No model in THIS project for the referenced dataset (another domain, nothing built yet,
      // or an out-of-band layer): there is no `ref()` to emit, so it stays an intention. Emitting
      // `ref('<unknown>')` would fail `dbt parse` and take the whole domain's project down.
      if (!model || !SAFE_COLUMN.test(model)) return null;
      return { relationships: { to: `ref('${model}')`, field: toColumn } };
    }
    default:
      return null;
  }
}

/** A dataset's checks → per-column test specs + the intentions that cannot be tests. */
export function checksToColumnTests(
  checks: DataCheck[] | undefined,
  resolveRef?: (datasetId: string) => string | null,
): { tests: Map<string, TestSpec[]>; intentions: string[] } {
  const tests = new Map<string, TestSpec[]>();
  const intentions: string[] = [];
  for (const check of checks ?? []) {
    const spec = checkToTest(check, resolveRef);
    if (!spec) {
      intentions.push(stripJinja(check.name));
      continue;
    }
    const col = check.column!.trim();
    tests.set(col, [...(tests.get(col) ?? []), spec]);
  }
  return { tests, intentions: intentions.sort() };
}

/** dbt `columns:` entries for a dataset: documented columns, with tests merged in when `withTests`. */
export function columnDocs(
  d: Dataset,
  withTests: boolean,
  resolveRef?: (datasetId: string) => string | null,
): { columns: Record<string, unknown>[]; intentions: string[] } {
  const columns = new Map<string, Record<string, unknown>>();
  for (const c of d.columns) {
    const name = stripJinja(c.name).trim();
    if (!name) continue;
    const description = stripJinja(c.description ?? '');
    columns.set(name, { name, ...(description ? { description } : {}) });
  }
  let intentions: string[] = [];
  if (withTests) {
    const ct = checksToColumnTests(d.checks, resolveRef);
    intentions = ct.intentions;
    for (const [col, specs] of ct.tests) {
      const entry = columns.get(col) ?? { name: col };
      entry.data_tests = [...((entry.data_tests as TestSpec[] | undefined) ?? []), ...specs];
      columns.set(col, entry);
    }
  }
  return { columns: [...columns.values()], intentions };
}

function modelDoc(m: ModelPlan, resolveRef: (datasetId: string) => string | null): Record<string, unknown> {
  const d: Dataset = m.dataset;
  const { columns, intentions } = columnDocs(d, m.tested, resolveRef);
  const description = [
    `${m.layer} layer of OS dataset ${d.id} ("${stripJinja(d.name)}")${d.origin === 'curated' ? ' — a composition of existing datasets' : ''}.`,
    stripJinja(d.description).trim(),
  ]
    .filter(Boolean)
    .join(' ');
  const meta: Record<string, unknown> = {
    os_dataset: d.id,
    os_layer: m.layer,
    os_tier: d.tier,
    os_owner: d.owner,
    ...(d.upstreams && d.upstreams.length ? { os_upstreams: d.upstreams.map((u) => u.datasetId).sort() } : {}),
    ...(intentions.length ? { os_intentions: intentions } : {}),
  };
  return {
    name: m.name,
    description,
    config: { meta },
    ...(columns.length ? { columns } : {}),
  };
}

/** Render `schema.yml` for every model directory → `Map<path, yaml>`. */
export function renderSchemas(models: ModelPlan[]): Map<string, string> {
  const byDir = new Map<string, ModelPlan[]>();
  for (const m of models) byDir.set(m.dir, [...(byDir.get(m.dir) ?? []), m]);
  // Built from the WHOLE plan, not the directory: a silver model may reference a gold one.
  const resolveRef = modelRefResolver(models);
  const out = new Map<string, string>();
  for (const [dir, ms] of byDir) {
    const docs = [...ms].sort((a, b) => a.name.localeCompare(b.name)).map((m) => modelDoc(m, resolveRef));
    out.set(`${dir}/schema.yml`, yml({ version: 2, models: docs }));
  }
  return out;
}
