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
 *     authored description or name is template input. Every authored string this file emits is
 *     encoded by `literal.freeText` (no ASCII brace survives, so no Jinja delimiter can form);
 *     column names are validated identifiers (`literal.datasetLiteralIssues`, run by the generator
 *     before rendering) and carry dbt's documented `quote: true` when Trino reserves the word.
 */
import { isSafeCheckValue, type DataCheck, type Dataset } from '@tabs/data/lib/dataset-schema';
import { yml } from '@tabs/data/lib/dbt/emit';
import { freeText, needsQuote } from '@tabs/data/lib/dbt/literal';
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

/**
 * A canonical key for a test spec: two specs with the same key are the SAME dbt test. Object keys
 * are sorted so `{min, max}` and `{max, min}` agree — dbt derives the test's unique id from the
 * test name plus a hash of its arguments, so key order is not what tells two tests apart.
 */
export function testSpecKey(spec: TestSpec): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(spec));
}

/**
 * Append `spec` to `list` unless an identical test is already there.
 *
 * WHY (live incident 2026-11, track H): a quality rule recorded twice on the same column (e.g. a
 * proposed fix applied twice, or `define_quality_rules` re-run) used to be emitted twice, and dbt
 * REFUSES a project in which two tests share a unique id — `dbt found two data_tests with the name
 * "not_null_<model>_<column>" …` is a COMPILATION error of `dbt parse`, so ONE dataset's repeated
 * rule failed the whole domain's project and repo-sync kept Dagster on the last good commit (or on
 * nothing) for days. Two identical tests check exactly what one checks, so dropping the repeat
 * loses nothing. Non-identical tests of the same kind (`range: {min: 0}` next to
 * `range: {max: 0}`) get distinct ids from dbt and are kept.
 */
export function pushUniqueTest(list: TestSpec[], spec: TestSpec): TestSpec[] {
  const key = testSpecKey(spec);
  return list.some((t) => testSpecKey(t) === key) ? list : [...list, spec];
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
      intentions.push(freeText(check.name));
      continue;
    }
    const col = check.column!.trim();
    tests.set(col, pushUniqueTest(tests.get(col) ?? [], spec));
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
    const name = c.name.trim();
    if (!name) continue;
    const description = freeText(c.description ?? '');
    columns.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(needsQuote(name) ? { quote: true } : {}),
      // The original source header, when the physical name was normalised from it at ingest.
      ...(c.source && c.source !== name ? { meta: { os_source_name: freeText(c.source) } } : {}),
    });
  }
  let intentions: string[] = [];
  if (withTests) {
    const ct = checksToColumnTests(d.checks, resolveRef);
    intentions = ct.intentions;
    for (const [col, specs] of ct.tests) {
      const entry = columns.get(col) ?? { name: col, ...(needsQuote(col) ? { quote: true } : {}) };
      entry.data_tests = specs.reduce(pushUniqueTest, (entry.data_tests as TestSpec[] | undefined) ?? []);
      columns.set(col, entry);
    }
  }
  return { columns: [...columns.values()], intentions };
}

/** The sentence the generator puts IN FRONT of the author's description (encoded form). */
export function modelDescriptionPrefix(d: Pick<Dataset, 'id' | 'name' | 'origin'>, layer: string): string {
  return `${layer} layer of OS dataset ${d.id} ("${freeText(d.name)}")${d.origin === 'curated' ? ' — a composition of existing datasets' : ''}.`;
}

/** Any generator sentence (this dataset's, or one left by an older name or a previous growth). */
const GENERATED_SENTENCE = /^(?:bronze|silver|gold) layer of OS dataset ds_[A-Za-z0-9_]+ \("[^\n]*?"\)(?: — a composition of existing datasets)?\.(?:\s+|$)/;

/**
 * The AUTHOR'S description inside a model description read back from git (still encoded): the
 * generator's own sentence is removed — the exact current one first, then any older generated
 * sentence repeated at the front — so a push → read-back → regenerate round trip is stable
 * instead of prepending the sentence again on every push.
 */
export function authoredDescription(raw: string, d?: Pick<Dataset, 'id' | 'name' | 'origin'>, layer?: string): string {
  let rest = raw.trim();
  if (d && layer) {
    const prefix = modelDescriptionPrefix(d, layer);
    while (rest.startsWith(prefix)) rest = rest.slice(prefix.length).trim();
  }
  for (let m = GENERATED_SENTENCE.exec(rest); m; m = GENERATED_SENTENCE.exec(rest)) rest = rest.slice(m[0].length).trim();
  return rest;
}

function modelDoc(m: ModelPlan, resolveRef: (datasetId: string) => string | null): Record<string, unknown> {
  const d: Dataset = m.dataset;
  const { columns, intentions } = columnDocs(d, m.tested, resolveRef);
  const description = [
    modelDescriptionPrefix(d, m.layer),
    freeText(d.description).trim(),
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
