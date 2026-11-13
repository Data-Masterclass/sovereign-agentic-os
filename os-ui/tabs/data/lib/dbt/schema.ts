/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `schema.yml` per model directory — descriptions + quality rules as dbt tests
 * USER STORY: As a data engineer I want the OS's quality rules to be `schema.yml` tests
 *             (`not_null`, `unique`, `accepted_values`, plus the generator-shipped `range` and
 *             `not_blank`) so `dbt test` runs them and a violated rule fails the build (checklist D5).
 * ARCHITECTURE:
 *   - Pure renderer over the planner's models. One `schema.yml` per directory; a dataset's checks
 *     attach to its FURTHEST model (the layer the OS runs its checks on today). When that layer was
 *     built out of band (a source, not a model) the planner attaches the same tests to the source.
 *   - `data_tests` (dbt ≥ 1.8). Free-text intentions (checks without a `rule`) are recorded as
 *     `meta.os_intentions`, never faked as tests.
 *   - SAFETY (review M1/L7): a column name is interpolated UNQUOTED into test SQL by dbt, so a check
 *     whose column is not a plain identifier — or an `accepted_values` with no values — is recorded
 *     as an intention, never emitted as a test. The store refuses such columns at the gate too.
 */
import type { DataCheck, Dataset } from '@tabs/data/lib/dataset-schema';
import { yml } from '@tabs/data/lib/dbt/emit';
import type { ModelPlan } from '@tabs/data/lib/dbt/models';

export type TestSpec = string | Record<string, unknown>;

/** The same rule the store enforces (`SAFE_COLUMN_RE`): letters, digits, underscore, not leading digit. */
export const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One check → one dbt test spec (null for a free-text intention or an unsafe / empty rule). */
export function checkToTest(check: DataCheck): TestSpec | null {
  if (!check.rule || !check.column || !SAFE_COLUMN.test(check.column.trim())) return null;
  switch (check.rule) {
    case 'not_null':
      return 'not_null';
    case 'unique':
      return 'unique';
    case 'not_blank':
      return 'not_blank';
    case 'accepted_values': {
      const values = (check.values ?? []).map((v) => String(v).trim()).filter(Boolean);
      return values.length ? { accepted_values: { values } } : null;
    }
    case 'range': {
      const args: Record<string, number> = {};
      if (typeof check.min === 'number') args.min = check.min;
      if (typeof check.max === 'number') args.max = check.max;
      return Object.keys(args).length ? { range: args } : null;
    }
    default:
      return null;
  }
}

/** A dataset's checks → per-column test specs + the intentions that cannot be tests. */
export function checksToColumnTests(checks: DataCheck[] | undefined): { tests: Map<string, TestSpec[]>; intentions: string[] } {
  const tests = new Map<string, TestSpec[]>();
  const intentions: string[] = [];
  for (const check of checks ?? []) {
    const spec = checkToTest(check);
    if (!spec) {
      intentions.push(check.name);
      continue;
    }
    const col = check.column!.trim();
    tests.set(col, [...(tests.get(col) ?? []), spec]);
  }
  return { tests, intentions: intentions.sort() };
}

/** dbt `columns:` entries for a dataset: documented columns, with tests merged in when `withTests`. */
export function columnDocs(d: Dataset, withTests: boolean): { columns: Record<string, unknown>[]; intentions: string[] } {
  const columns = new Map<string, Record<string, unknown>>();
  for (const c of d.columns) {
    const name = c.name.trim();
    if (!name) continue;
    columns.set(name, { name, ...(c.description ? { description: c.description } : {}) });
  }
  let intentions: string[] = [];
  if (withTests) {
    const ct = checksToColumnTests(d.checks);
    intentions = ct.intentions;
    for (const [col, specs] of ct.tests) {
      const entry = columns.get(col) ?? { name: col };
      entry.data_tests = [...((entry.data_tests as TestSpec[] | undefined) ?? []), ...specs];
      columns.set(col, entry);
    }
  }
  return { columns: [...columns.values()], intentions };
}

function modelDoc(m: ModelPlan): Record<string, unknown> {
  const d: Dataset = m.dataset;
  const { columns, intentions } = columnDocs(d, m.tested);
  const description = [
    `${m.layer} layer of OS dataset ${d.id} ("${d.name}")${d.origin === 'curated' ? ' — a composition of existing datasets' : ''}.`,
    d.description.trim(),
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
  const out = new Map<string, string>();
  for (const [dir, ms] of byDir) {
    const docs = [...ms].sort((a, b) => a.name.localeCompare(b.name)).map(modelDoc);
    out.set(`${dir}/schema.yml`, yml({ version: 2, models: docs }));
  }
  return out;
}
