/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, ColumnDoc } from './dataset-schema.ts';
import { domainSchema, physicalSlug } from './store-fqn.ts';

/**
 * The Metric handover to Cube (data-ui-ux.md §"Define a metric — the Cube handover",
 * §"Cube model format"). Metrics are defined on the GOLD version. We follow the
 * `cube_dbt` pattern: the Gold dbt mart is the contract — its columns become Cube
 * DIMENSIONS automatically (cube_dbt maps dbt data_type → Cube dim type; primary_key
 * → a PK dimension); the user only NAMES the MEASURE (+ picks the aggregation/column).
 * A matching dbt `exposure` is emitted per Cube view so the mart→metric edge lands in
 * OpenMetadata automatically (one exposure per view).
 *
 * Pure + tested so the panel preview, the stored artifact and the Build adapter
 * (Phase 6) all generate exactly the same YAML.
 */

export const MEASURE_TYPES = ['count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max', 'number'] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];
export type CubeDimType = 'string' | 'number' | 'time' | 'boolean';

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/**
 * #155 — the domain prefix that makes a cube identity unique per domain. A double
 * underscore SEPARATES the domain from the dataset slug so the scheme is obviously
 * reversible/inspectable (`sales__orders` = domain `sales`, dataset `orders`) and can
 * never be confused with a single-underscore word boundary inside either half.
 */
export function cubeDomainPrefix(d: Dataset): string {
  return slug(d.domain);
}

/**
 * The cube name (== the model file base). NAMESPACED for datasets created after #155
 * (`<domain>__<slug>`) so two domains can each name a dataset "Sales" without colliding
 * on one shared cube/model file. LEGACY (un-namespaced `slug(name)`) for every dataset
 * that predates #155 — so the LIVE Cube models keep their exact old name and there is no
 * migration. The `cubeNamespaced` marker on the dataset (set once at create) decides,
 * so a given dataset's identity is stable for its whole life.
 */
export function cubeName(d: Dataset): string {
  const s = physicalSlug(d); // FROZEN slug — a rename never moves the cube identity
  return d.cubeNamespaced ? `${cubeDomainPrefix(d)}__${s}` : s;
}

/** The physical VIEW base (a valid Cube identifier). It is the SAME frozen identity as
 *  `cubeName`: while the slug is still derivable (never renamed) it keeps the historical
 *  case-preserving transform of the name (byte-stable — live views don't churn); once a
 *  rename has FROZEN the slug it derives from that frozen slug, so the view identifier
 *  stays pinned to the physical table across a rename. */
function physicalViewBase(d: Dataset): string {
  if (d.slug) return d.slug; // decoupled: anchor the view to the frozen physical slug
  return d.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'View';
}

/** The Cube VIEW name dashboards + the agent metrics tool resolve. MUST be a valid
 *  Cube identifier — letters/digits/underscore, no spaces — or the WHOLE Cube schema
 *  fails to compile ("fails to match the identifier pattern"). Underscores, readable case.
 *  NAMESPACED (`<domain>__<View>`) for post-#155 datasets, LEGACY (bare View) otherwise —
 *  moves in lockstep with `cubeName` so the cube + its view are always the same scheme. */
export function cubeViewName(d: Dataset): string {
  const view = physicalViewBase(d);
  return d.cubeNamespaced ? `${cubeDomainPrefix(d)}__${view}` : view;
}

/** The un-namespaced (legacy) cube name a dataset WOULD have had before #155. The
 *  back-compat alias: a stored/hand-written reference using the old bare name still
 *  resolves to this dataset (see `cubeNameMatches`). For a legacy dataset this equals
 *  `cubeName(d)`; for a namespaced one it is the collision-prone name we deliberately
 *  moved off of, kept resolvable so nothing that referenced it breaks. */
export function legacyCubeName(d: Dataset): string {
  return physicalSlug(d);
}

/** The un-namespaced (legacy) view name a dataset WOULD have had before #155. */
export function legacyCubeViewName(d: Dataset): string {
  return physicalViewBase(d);
}

/** Back-compat resolver: does `name` refer to this dataset's cube — under EITHER its
 *  current (possibly namespaced) name OR its legacy un-namespaced name? Every reverse
 *  lookup (a persisted dashboard view, a hand-written Power BI/Cube query, a legacy
 *  metric member) resolves through this, so a namespaced dataset still answers to the
 *  old bare name and no existing reference breaks — zero migration. */
export function cubeNameMatches(d: Dataset, name: string): boolean {
  return name === cubeName(d) || name === legacyCubeName(d);
}

/** Back-compat resolver for the VIEW name (both current + legacy). */
export function cubeViewNameMatches(d: Dataset, view: string): boolean {
  return view === cubeViewName(d) || view === legacyCubeViewName(d);
}

/** The Gold mart FQN the cube binds to via `sql_table` (the handover contract). */
export function goldMartFqn(d: Dataset): string {
  return `iceberg.${domainSchema(d.domain)}.gold_${physicalSlug(d)}`;
}

/** The clear, single-source message a metric guard returns when the gold isn't governed. */
export const PROMOTE_FIRST_MESSAGE =
  'Promote this dataset to Shared first — a metric needs a governed Gold in the domain schema (Cube reads the domain mart, not your personal lane).';

/**
 * SQL-READY gate (the metrics→Trino migration, Phase 1): a metric now SERVES as governed
 * Trino SQL over the PHYSICAL gold mart run AS the viewer (OPA row/column security
 * applies), so define + preview + explore require ONLY a BUILT Gold — of ANY tier. A
 * personal dataset's gold lives in the owner's `personal_<uid>` lane and the owner reads
 * it AS themselves (Trino/OPA `is_owned_personal`), so a metric on personal gold is now
 * possible: no promotion needed to define or read it. Returns `{ ok:false, message }`
 * (never throws — callers decide 400 vs skip).
 */
export function metricSqlReady(d: Dataset): { ok: boolean; message?: string } {
  // Metrics are NOT offered on a LIVE connected dataset (lakehouse-import-exposure.md,
  // Phase 2 v1): a live-federated external table has no governed gold mart to bind a Cube
  // to, and honest sampling makes an aggregate approximate. Steer to a synced copy — the
  // ONE message the picker + define route both surface.
  if (d.connected && d.connected.mode === 'live') {
    return { ok: false, message: 'Define metrics on a synced copy — not a live connected dataset.' };
  }
  if (!d.versions.gold.built) {
    return { ok: false, message: 'Define a metric only on a built Gold version.' };
  }
  return { ok: true };
}

/**
 * FAIL-CLOSED metric/CUBE gate (#91): a Cube binds to `iceberg.<domain>.gold_<slug>`
 * — a table that exists ONLY once the dataset is a PROMOTED asset/product (the
 * governed CTAS landed the gold in the domain schema). Cube reads Trino as `cube-sales`,
 * entitled only to governed DOMAIN schemas, so a metric on an un-promoted personal
 * dataset points at a non-existent domain table and the cube can't compile/read.
 * Returns `{ ok:false, message }` (never throws — callers decide 400 vs skip) so a
 * broken cube is NEVER registered. Requires BOTH a built Gold AND a governed tier.
 *
 * This is the CUBE-REGISTRATION gate ONLY (scaffold/sidecar). Serving a metric no longer
 * needs it — see {@link metricSqlReady}. Cube stays on the dashboards path (Phase 2), so
 * the promote-first rule is preserved wherever a CUBE artifact would be produced.
 */
export function metricCubeReady(d: Dataset): { ok: boolean; message?: string } {
  const sql = metricSqlReady(d);
  if (!sql.ok) return sql;
  if (d.tier === 'dataset') return { ok: false, message: PROMOTE_FIRST_MESSAGE };
  return { ok: true };
}

/** @deprecated Back-compat alias for {@link metricCubeReady} (the Cube-registration rule).
 *  Callers on the metric READ/DEFINE path have moved to {@link metricSqlReady}. */
export const metricGoldReady = metricCubeReady;

/**
 * The ACTUAL columns of the built Gold table. A Gold built through the JOIN builder
 * projects `goldSpec.dimensions` — its output names (the `as` alias, else the source
 * column) can DIFFER from `d.columns` (which documents the base/Silver schema): a join
 * adds columns from other datasets, a projection drops some. Everything that reads the
 * gold mart (the metric builder's column palette, the Cube dims) must use THIS set, or
 * a joined column never appears and a dropped one 400s. Falls back to `d.columns` when
 * no gold spec projects anything (pass-through / single-table gold keeps the base).
 */
export function goldOutputColumns(d: Dataset): ColumnDoc[] {
  const dims = d.goldSpec?.dimensions ?? [];
  const derived = d.goldSpec?.derived ?? [];
  // A projection exists once the Gold spec names ANY dimension or derived column; only
  // then does the output shape differ from the base/Silver schema (`d.columns`).
  if (!d.versions.gold.built || (dims.length === 0 && derived.length === 0)) return d.columns;
  const docOf = new Map(d.columns.map((c) => [c.name, c.description]));
  const out: ColumnDoc[] = [];
  const seen = new Set<string>();
  for (const dim of dims) {
    const i = dim.source.indexOf('::');
    const src = i >= 0 ? dim.source.slice(i + 2) : dim.source;
    const name = dim.as?.trim() || src;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: docOf.get(name) ?? docOf.get(src) ?? '' });
  }
  // Derived columns are new row-level outputs — their `name` IS the output column.
  for (const der of derived) {
    const name = der.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: docOf.get(name) ?? '' });
  }
  return out.length ? out : d.columns;
}

/** cube_dbt's dbt data_type → Cube dimension type. We have no live manifest in kind,
 *  so infer the column's type from its documented name the way cube_dbt would from the
 *  mart schema. The first `*_id` (or the first column) becomes the primary key. */
export function inferDimType(name: string): CubeDimType {
  const n = name.toLowerCase();
  if (/(_at|_date|_ts|_time|date|timestamp)$/.test(n) || n === 'date') return 'time';
  if (/(_id|id|amount|qty|quantity|count|total|net|gross|price|value|num)$/.test(n)) return 'number';
  if (/^(is_|has_)/.test(n)) return 'boolean';
  return 'string';
}

function primaryKeyColumn(columns: ColumnDoc[]): string | null {
  const idCol = columns.find((c) => /(^|_)id$/.test(c.name.toLowerCase()));
  return idCol ? idCol.name : columns[0]?.name ?? null;
}

/** One measure's YAML block — the base (`name`/`type`/`sql`) plus, only when present,
 *  the richer Cube fields (filters / rolling_window / format / drill_members). A plain
 *  `{name,type,sql}` measure emits BYTE-FOR-BYTE what it did before these fields existed,
 *  so the live Cube auto-registration and every existing test are unchanged.
 *
 *  `knownMembers` is the reconciled set of members that ACTUALLY exist on this cube
 *  (mart columns + measure names). A `drill_members` entry naming a member NOT in the
 *  cube makes Cube reject the whole schema, so unknown drill members are DROPPED (#91):
 *  we never emit a reference to a column/member that isn't in the mart. */
function measureYaml(m: Measure, knownMembers: Set<string>): string {
  const out = [`      - name: ${m.name}`, `        type: ${m.type}`];
  if (m.sql && m.type !== 'count') out.push(`        sql: ${m.sql}`);
  if (m.filters && m.filters.length > 0) {
    out.push('        filters:');
    for (const f of m.filters) out.push(`          - sql: "${f.sql.replace(/"/g, '\\"')}"`);
  }
  if (m.rollingWindow && (m.rollingWindow.trailing || m.rollingWindow.leading || m.rollingWindow.offset)) {
    out.push('        rolling_window:');
    if (m.rollingWindow.trailing) out.push(`          trailing: ${m.rollingWindow.trailing}`);
    if (m.rollingWindow.leading) out.push(`          leading: ${m.rollingWindow.leading}`);
    if (m.rollingWindow.offset) out.push(`          offset: ${m.rollingWindow.offset}`);
  }
  if (m.format) out.push(`        format: ${m.format}`);
  if (m.drillMembers && m.drillMembers.length > 0) {
    // Reconcile: only drill into members that exist on this cube (drop unknown columns).
    const drill = m.drillMembers.filter((d) => knownMembers.has(d));
    if (drill.length > 0) out.push(`        drill_members: [${drill.join(', ')}]`);
  }
  return out.join('\n');
}

/** The EXACT set of members the Cube VIEW exposes (its `includes` list): every
 *  named measure + every gold dimension column EXCEPT the primary key. The PK is a
 *  cube dimension (for joins/drill) but is deliberately NOT in the view, so a metric
 *  slice on the PK would 400 ("not found for path <view>.<pk>"). Callers reconcile
 *  slice dimensions against this set (drop non-members) — mirrors the security
 *  scrub in lib/infra/governed.ts. Kept in lockstep with `scaffoldCubeYaml`. */
export function viewMembers(d: Dataset): Set<string> {
  const cols = goldOutputColumns(d);
  const pk = primaryKeyColumn(cols);
  const measureNames = new Set(d.measures.map((m) => m.name));
  const dimCols = cols.filter((c) => c.name === pk || !measureNames.has(c.name));
  return new Set<string>([
    ...d.measures.map((m) => m.name),
    ...dimCols.filter((c) => c.name !== pk).map((c) => c.name),
  ]);
}

/** The REGISTRY-derived dimension members of a dataset's Cube view (`View.column`),
 *  split into plain vs time dimensions exactly as `scaffoldCubeYaml` emits them (non-pk,
 *  measure-collision dropped, `inferDimType` decides time). The Northpeak fix uses this
 *  as the panel-builder palette FALLBACK when Cube does not (yet/anymore) serve the view —
 *  so a chart can still be created WITH its group-by spec (and flagged), instead of the
 *  palette silently emptying and the group-by being discarded at create time. */
export function registryDimensionMembers(d: Dataset): { dimensions: string[]; timeDimensions: string[] } {
  const view = cubeViewName(d);
  const cols = goldOutputColumns(d);
  const pk = primaryKeyColumn(cols);
  const measureNames = new Set(d.measures.map((m) => m.name));
  const dimCols = cols.filter((c) => c.name !== pk && !measureNames.has(c.name));
  const dimensions: string[] = [];
  const timeDimensions: string[] = [];
  for (const c of dimCols) {
    (inferDimType(c.name) === 'time' ? timeDimensions : dimensions).push(`${view}.${c.name}`);
  }
  return { dimensions, timeDimensions };
}

/** Build the Cube model YAML (cube + view) from the Gold columns + named measures —
 *  the file the Metric step would hand-write only the `measures:` block of. */
export function scaffoldCubeYaml(d: Dataset): string {
  const cube = cubeName(d);
  const cols = goldOutputColumns(d);
  const pk = primaryKeyColumn(cols);
  // A measure and a dimension may NOT share a name in a Cube (Cube rejects it with
  // "defined more than once" → the whole schema 500s). When a gold column is also a
  // measure name, the measure wins — skip the colliding dimension (keep the pk).
  const measureNames = new Set(d.measures.map((m) => m.name));
  const dimCols = cols.filter((c) => c.name === pk || !measureNames.has(c.name));
  const dims = dimCols.map((c) => {
    const type = c.name === pk ? 'number' : inferDimType(c.name);
    const pkLine = c.name === pk ? '\n        primary_key: true' : '';
    return `      - name: ${c.name}\n        sql: ${c.name}\n        type: ${type}${pkLine}`;
  });
  // The reconciled member set actually present on this cube: every emitted dimension
  // column + every measure name. Cube rejects the whole schema if a `drill_members`
  // entry names a member that isn't here — so measureYaml drops unknown drill members
  // against this set (never emit a reference to a column not in the mart, #91).
  const knownMembers = new Set<string>([...dimCols.map((c) => c.name), ...measureNames]);
  const measures = (d.measures.length ? d.measures : [{ name: 'count', type: 'count', sql: '' } as Measure]).map((m) => measureYaml(m, knownMembers));
  const includes = [...viewMembers(d)]; // the view's member set (measures + non-pk dims)
  // A measure-less dataset scaffolds the default cube-level `count` measure (above) —
  // include it in the view too, or the view exposes no measure at all (#142: empty
  // views like Northpeak_Campaigns).
  if (d.measures.length === 0 && !includes.includes('count')) includes.unshift('count');
  return [
    'cubes:',
    `  - name: ${cube}`,
    `    sql_table: ${goldMartFqn(d)}        # the dbt Gold mart (cube_dbt contract)`,
    '    measures:',
    ...measures,
    '    dimensions:',
    ...dims,
    '',
    'views:',
    `  - name: ${cubeViewName(d)}`,
    '    cubes:',
    `      - join_path: ${cube}`,
    `        includes: [${includes.join(', ')}]`,
    '',
  ].join('\n');
}

/** One dbt `exposure` per Cube view — rides in on the dbt artifacts so the
 *  mart→metric edge appears in OpenMetadata automatically (data-ui-ux.md §C). */
export function scaffoldExposureYaml(d: Dataset): string {
  const s = physicalSlug(d); // FROZEN — the dbt mart model name never moves on a rename
  // The exposure NAME namespaces with the cube (so two domains' exposures don't collide);
  // the dbt `ref('mart_<slug>')` still points at the dataset's dbt mart model (unchanged —
  // the dbt project owns that name; #155 is scoped to the cube identity). Legacy datasets
  // keep the bare `<slug>_metrics` name (cubeName === slug), so nothing existing churns.
  const base = cubeName(d);
  return [
    'exposures:',
    `  - name: ${base}_metrics`,
    '    type: analysis',
    `    label: ${cubeViewName(d)} metrics`,
    '    depends_on:',
    `      - ref('mart_${s}')`,
    '    owner:',
    `      name: ${d.owner}`,
    `    description: Cube view "${cubeViewName(d)}" + the agent metrics tool resolve here.`,
    '',
  ].join('\n');
}

/** A minimal Superset bundle on the Cube view (dataset + a chart) — imported via the
 *  Superset API on Build. Database Service Name = the query service (handover contract,
 *  so OM captures dashboard→mart lineage). */
export function scaffoldDashboardBundle(d: Dataset): string {
  const view = cubeViewName(d);
  const firstMeasure = d.measures[0]?.name ?? 'count';
  return JSON.stringify(
    {
      dashboard: `${view} Overview`,
      database_service_name: 'trino',
      dataset: { name: view, schema: 'cube', sql: `SELECT * FROM "${view}"` },
      charts: [{ name: `${view} — ${firstMeasure}`, viz_type: 'big_number_total', metric: firstMeasure }],
      depends_on_exposure: `${cubeName(d)}_metrics`,
    },
    null,
    2,
  );
}

/** The file-name base for a dataset's emitted artifacts — the SAME scheme as `cubeName`
 *  so the cube, its model file, its exposure and its dashboard bundle all namespace (or
 *  stay legacy) TOGETHER. Namespaced `<domain>__<slug>` post-#155; legacy `<slug>` before
 *  it (so live artifact paths are byte-stable and never re-written). */
export function artifactBase(d: Dataset): string {
  return cubeName(d);
}

export const CUBE_ARTIFACT = (d: Dataset) => `metrics/${artifactBase(d)}.cube.yml`;
export const EXPOSURE_ARTIFACT = 'models/exposures.yml';
export const DASHBOARD_ARTIFACT = (d: Dataset) => `dashboards/${artifactBase(d)}.json`;
