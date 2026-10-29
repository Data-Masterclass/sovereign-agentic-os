/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure, ColumnDoc } from '@tabs/data/lib/dataset-schema';
import { domainSchema, physicalSlug } from '@tabs/data/lib/store-fqn';

/**
 * The metric model (data-ui-ux.md §"Define a metric"). Metrics are defined on the GOLD
 * version and SERVED as governed Trino SQL over the gold mart. The model keeps the
 * `cube_dbt`-style declaration as the metric's persisted YAML definition: the Gold mart is
 * the contract — its columns become DIMENSIONS automatically (data_type → dim type;
 * primary_key → a PK dimension); the user only NAMES the MEASURE (+ picks the
 * aggregation/column). The `<View>.<measure>` MEMBER is every metric's frozen identity
 * (dashboards, the agent `metrics` tool and the explorer all resolve it).
 *
 * Pure + tested so the panel preview and the stored artifact generate exactly the same YAML.
 */

export const MEASURE_TYPES = ['count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max', 'number'] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];
export type DimensionType = 'string' | 'number' | 'time' | 'boolean';

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/**
 * #155 — the domain prefix that makes a cube identity unique per domain. A double
 * underscore SEPARATES the domain from the dataset slug so the scheme is obviously
 * reversible/inspectable (`sales__orders` = domain `sales`, dataset `orders`) and can
 * never be confused with a single-underscore word boundary inside either half.
 */
export function viewDomainPrefix(d: Dataset): string {
  return slug(d.domain);
}

/**
 * The cube name (== the model file base). NAMESPACED for datasets created after #155
 * (`<domain>__<slug>`) so two domains can each name a dataset "Sales" without colliding
 * on one shared cube/model file. LEGACY (un-namespaced `slug(name)`) for every dataset
 * that predates #155 — so the LIVE Cube models keep their exact old name and there is no
 * migration. The `viewNamespaced` marker on the dataset (set once at create) decides,
 * so a given dataset's identity is stable for its whole life.
 */
export function modelName(d: Dataset): string {
  const s = physicalSlug(d); // FROZEN slug — a rename never moves the cube identity
  return d.viewNamespaced ? `${viewDomainPrefix(d)}__${s}` : s;
}

/** The physical VIEW base (a valid Cube identifier). It is the SAME frozen identity as
 *  `modelName`: while the slug is still derivable (never renamed) it keeps the historical
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
 *  moves in lockstep with `modelName` so the cube + its view are always the same scheme. */
/** Title-case an identifier's underscore segments: `service_centers` → `Service_Centers`.
 *  Cube identifiers are case-SENSITIVE, so this yields a distinct name while matching the
 *  existing view convention (`Northpeak_Goods_Receipts`). */
function titleCaseIdent(s: string): string {
  return s
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('_');
}

export function viewName(d: Dataset): string {
  const view = physicalViewBase(d);
  const name = d.viewNamespaced ? `${viewDomainPrefix(d)}__${view}` : view;
  // A view and a cube may NOT share a name: Cube rejects the WHOLE schema with
  // "Found conflicting cube and view name", so ONE bad model 500s /meta and takes every
  // dataset's build/promote down with it (2026-09-23 outage). This happens whenever the
  // view base is the FROZEN slug — `modelName` is built from that same slug. Disambiguate
  // ONLY on collision, so no other dataset's live view name churns.
  if (name !== modelName(d)) return name;
  const titled = d.viewNamespaced
    ? `${viewDomainPrefix(d)}__${titleCaseIdent(view)}`
    : titleCaseIdent(view);
  return titled !== modelName(d) ? titled : `${name}_view`;
}

/** The un-namespaced (legacy) cube name a dataset WOULD have had before #155. The
 *  back-compat alias: a stored/hand-written reference using the old bare name still
 *  resolves to this dataset (see `modelNameMatches`). For a legacy dataset this equals
 *  `modelName(d)`; for a namespaced one it is the collision-prone name we deliberately
 *  moved off of, kept resolvable so nothing that referenced it breaks. */
export function legacyModelName(d: Dataset): string {
  return physicalSlug(d);
}

/** The un-namespaced (legacy) view name a dataset WOULD have had before #155. */
export function legacyViewName(d: Dataset): string {
  return physicalViewBase(d);
}

/** Back-compat resolver: does `name` refer to this dataset's cube — under EITHER its
 *  current (possibly namespaced) name OR its legacy un-namespaced name? Every reverse
 *  lookup (a persisted dashboard view, a hand-written Power BI/Cube query, a legacy
 *  metric member) resolves through this, so a namespaced dataset still answers to the
 *  old bare name and no existing reference breaks — zero migration. */
export function modelNameMatches(d: Dataset, name: string): boolean {
  return name === modelName(d) || name === legacyModelName(d);
}

/** Back-compat resolver for the VIEW name (both current + legacy). */
export function viewNameMatches(d: Dataset, view: string): boolean {
  return view === viewName(d) || view === legacyViewName(d);
}

/** The Gold mart FQN the cube binds to via `sql_table` (the handover contract). */
export function goldMartFqn(d: Dataset): string {
  return `iceberg.${domainSchema(d.domain)}.gold_${physicalSlug(d)}`;
}

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
  // Phase 2 v1): a live-federated external table has no governed gold mart to serve the
  // metric from, and honest sampling makes an aggregate approximate. Steer to a synced
  // copy — the ONE message the picker + define route both surface.
  if (d.connected && d.connected.mode === 'live') {
    return { ok: false, message: 'Define metrics on a synced copy — not a live connected dataset.' };
  }
  if (!d.versions.gold.built) {
    return { ok: false, message: 'Define a metric only on a built Gold version.' };
  }
  return { ok: true };
}

/**
 * The ACTUAL columns of the built Gold table. A Gold built through the JOIN builder
 * projects `goldSpec.dimensions` — its output names (the `as` alias, else the source
 * column) can DIFFER from `d.columns` (which documents the base/Silver schema): a join
 * adds columns from other datasets, a projection drops some. Everything that reads the
 * gold mart (the metric builder's column palette, the view dims) must use THIS set, or
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

/** dbt data_type → dimension type. We have no live manifest in kind, so infer the
 *  column's type from its documented name the way cube_dbt would from the mart schema.
 *  The first `*_id` (or the first column) becomes the primary key. */
export function inferDimType(name: string): DimensionType {
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
 *  the richer fields (filters / rolling_window / format / drill_members). A plain
 *  `{name,type,sql}` measure emits BYTE-FOR-BYTE what it did before these fields existed.
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
 *  slice on the PK is not a view member. Callers reconcile slice dimensions against
 *  this set (drop non-members). Kept in lockstep with `scaffoldMetricYaml`. */
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

/** The REGISTRY-derived dimension members of a dataset's view (`View.column`), split
 *  into plain vs time dimensions exactly as `scaffoldMetricYaml` emits them (non-pk,
 *  measure-collision dropped, `inferDimType` decides time). THE panel-builder palette
 *  source: what the registry offers is exactly what the governed-SQL executor can compute. */
export function registryDimensionMembers(d: Dataset): { dimensions: string[]; timeDimensions: string[] } {
  const view = viewName(d);
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

/** Build the metric model YAML (cube + view declaration) from the Gold columns + named
 *  measures — the persisted definition the Metric step would hand-write only the
 *  `measures:` block of (the YAML door of define). */
export function scaffoldMetricYaml(d: Dataset): string {
  const cube = modelName(d);
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
    `  - name: ${viewName(d)}`,
    '    cubes:',
    `      - join_path: ${cube}`,
    `        includes: [${includes.join(', ')}]`,
    '',
  ].join('\n');
}

/** The file-name base for a dataset's emitted metric artifact — the SAME scheme as
 *  `modelName` so the model identity and its file namespace (or stay legacy) TOGETHER.
 *  Namespaced `<domain>__<slug>` post-#155; legacy `<slug>` before it (so stored artifact
 *  paths are byte-stable and never re-written). */
export function artifactBase(d: Dataset): string {
  return modelName(d);
}

export const CUBE_ARTIFACT = (d: Dataset) => `metrics/${artifactBase(d)}.cube.yml`;
