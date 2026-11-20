/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — a dashboard as native dbt + Vega-Lite files, and the reader the OS draws from
 * USER STORY: As an engineer I want each dashboard in my domain repo as dbt `saved_queries:` + one
 *             dbt `exposures:` entry (`dashboards/<slug>/semantic.yml`) and one Vega-Lite v5 spec per
 *             panel (`dashboards/<slug>/panels/<panel>.vl.json`), so `dbt parse` and `vl-convert`
 *             accept them with no OS present — and I want the OS to draw the dashboard from exactly
 *             those files (artifact contract 11 §3.1, A16).
 * ARCHITECTURE:
 *   - Three files per dashboard, three owners:
 *       semantic.yml      dbt (https://docs.getdbt.com/docs/build/saved-queries, .../exposures):
 *                         the NUMBERS. One saved query per panel (`query_params.metrics / group_by /
 *                         where`), written in MetricFlow's own syntax against the project's CURRENT
 *                         `metrics:` entries, so the same file serves WP-20's MetricFlow unchanged.
 *       panels/*.vl.json  Vega-Lite v5 (https://vega.github.io/vega-lite/docs/): the PICTURE. Its
 *                         named data source is the saved query; its fields are MetricFlow's output
 *                         column names (`revenue`, `orders__region`, `orders__order_date__month`).
 *       os.yaml           the OS layer only: id, owner token, tier, folder, grid positions, panel
 *                         order, dashboard default chips, and panels that are not native yet.
 *   - The semantic index is read from the COMMITTED dbt YAML (`metrics:` `config.meta.os_member`,
 *     `semantic_models:` entities and dimensions). A panel is written as a saved query only when
 *     every member resolves there; otherwise it is `pending` in os.yaml with the reason, because one
 *     saved query naming a missing metric makes `dbt parse` fail for the whole domain.
 *   - The reader is the inverse: numbers from the saved query, chart type from the Vega-Lite mark,
 *     layout from os.yaml. A saved query or a spec that does not resolve is a typed refusal naming
 *     the file, never a silent fallback to the registry.
 *   - PURE and byte-stable, like `generate.ts`: same snapshot + same dbt YAML ⇒ same bytes.
 */
import { dump, load } from 'js-yaml';
import type { DashTier } from '@tabs/dashboards/lib/governance';
import { PANEL_TIME_GRAINS, VIZ_TYPES, isServableTimeGrain, type DashboardSpec, type Panel, type PanelFilter, type VizType } from '@tabs/dashboards/lib/model';
import { API_VERSION, DASHBOARDS_PREFIX, ownerRef, placeDashboards, renderIndex, type PlacedDashboard } from '@tabs/dashboards/lib/git/generate';
import { DashboardFileError, assertNoQueryKeys, bad, filters as parseFilters, gridPos as parseGridPos, str } from '@tabs/dashboards/lib/git/parse';
import type { DashboardProjectSnapshot, SnapshotDashboard, SnapshotPanel } from '@tabs/dashboards/lib/git/snapshot';

export const NATIVE_SEMANTIC_FILE = 'semantic.yml';
export const NATIVE_OS_FILE = 'os.yaml';
export const NATIVE_PANELS_DIR = 'panels';
export const NATIVE_KIND = 'DashboardLayer';
export const VEGA_LITE_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json';

// ---------------------------------------------------------------- semantic index ---

export type SemanticDimension = { name: string; type: 'time' | 'categorical'; column: string; qualified: string };
type SemModel = { name: string; entity: string; dims: SemanticDimension[] };

export type SemanticIndex = {
  /** OS member (`View.measure`) → dbt metric name. */
  metricByMember: Map<string, string>;
  /** dbt metric name → OS member and OS metric id (`config.meta.os_member` / `os_metric`). */
  metrics: Map<string, { member: string; osMetric: string | null }>;
  /** The dimension of a governed view, by its column (or dimension name). */
  dimension(view: string, column: string): SemanticDimension | null;
  /** A MetricFlow-qualified dimension (`orders__region`) → its view and dimension. */
  byQualified(qualified: string): { view: string; dim: SemanticDimension } | null;
};

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Is this repo path a dbt property file under a dbt `models/` tree (v1 root or v2 `data/dbt/`)? */
function isDbtModelYaml(path: string): boolean {
  return /(^|\/)models\/.*\.ya?ml$/.test(path) && !path.startsWith(DASHBOARDS_PREFIX);
}

function viewOf(member: string): string {
  const i = member.lastIndexOf('.');
  return i > 0 ? member.slice(0, i) : '';
}

/**
 * Build the index from the repo's committed dbt YAML. `files` is path → content; anything that is
 * not a dbt property file is ignored. Unparseable YAML is skipped here — `dbt parse` is the judge
 * of the dbt project; this index only needs the names the dbt files actually declare.
 */
export function buildSemanticIndex(files: Map<string, string>): SemanticIndex {
  const models = new Map<string, SemModel>();
  const measureModel = new Map<string, string>();
  const metrics = new Map<string, { member: string; osMetric: string | null; measure: string }>();
  for (const [path, text] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isDbtModelYaml(path) || !/(semantic_models|metrics):/.test(text)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = asObj(load(text));
    } catch {
      continue;
    }
    for (const raw of asArr(doc.semantic_models)) {
      const m = asObj(raw);
      const entity = asArr(m.entities).map(asObj).find((e) => e.type === 'primary');
      if (!s(m.name) || !entity || !s(entity.name)) continue;
      const dims = asArr(m.dimensions).map(asObj).filter((d) => s(d.name)).map((d) => ({
        name: s(d.name),
        type: (d.type === 'time' ? 'time' : 'categorical') as SemanticDimension['type'],
        column: s(d.expr) || s(d.name),
        qualified: `${s(entity.name)}__${s(d.name)}`,
      }));
      models.set(s(m.name), { name: s(m.name), entity: s(entity.name), dims });
      for (const meas of asArr(m.measures).map(asObj)) if (s(meas.name)) measureModel.set(s(meas.name), s(m.name));
    }
    for (const raw of asArr(doc.metrics)) {
      const m = asObj(raw);
      const meta = { ...asObj(m.meta), ...asObj(asObj(m.config).meta) };
      if (!s(m.name) || !s(meta.os_member)) continue;
      const tp = asObj(m.type_params);
      const measure = typeof tp.measure === 'string' ? tp.measure : s(asObj(tp.measure).name);
      metrics.set(s(m.name), { member: s(meta.os_member), osMetric: s(meta.os_metric) || null, measure });
    }
  }
  // A view's semantic model is the one that owns the measures of its simple / cumulative metrics.
  const modelByView = new Map<string, SemModel>();
  for (const m of metrics.values()) {
    const model = models.get(measureModel.get(m.measure) ?? '');
    if (model && !modelByView.has(viewOf(m.member))) modelByView.set(viewOf(m.member), model);
  }
  const byQualified = new Map<string, { view: string; dim: SemanticDimension }>();
  for (const [view, model] of modelByView) for (const dim of model.dims) byQualified.set(dim.qualified, { view, dim });
  return {
    metricByMember: new Map([...metrics.entries()].map(([name, m]) => [m.member, name])),
    metrics: new Map([...metrics.entries()].map(([name, m]) => [name, { member: m.member, osMetric: m.osMetric }])),
    dimension: (view, column) => modelByView.get(view)?.dims.find((d) => d.column === column || d.name === column) ?? null,
    byQualified: (q) => byQualified.get(q) ?? null,
  };
}

// ---------------------------------------------------------------- names ---

/** A dbt resource name: lower-case letters, digits and single underscores, starting with a letter. */
export function dbtName(raw: string): string {
  let out = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(out)) out = `d_${out}`.replace(/_+$/, '');
  return out.length >= 2 ? out : `${out}_x`;
}

/** The exposure name of a placed dashboard: its directory below `dashboards/`. */
export function exposureName(placed: PlacedDashboard): string {
  return dbtName(placed.dir.slice(DASHBOARDS_PREFIX.length));
}

/** The saved-query name of one panel. */
export function savedQueryName(placed: PlacedDashboard, panelId: string): string {
  return dbtName(`${exposureName(placed)}_${panelId.replace(/^p_/, '')}`);
}

// ---------------------------------------------------------------- panel → native ---

type NativeQuery = {
  metrics: string[];
  dims: SemanticDimension[];
  time?: { dim: SemanticDimension; grain: string };
  where: string[];
};

const leaf = (member: string) => member.slice(member.lastIndexOf('.') + 1);

/** A SQL string literal for a MetricFlow where template. A value that could leave the template is refused. */
function literal(v: string): string | null {
  if (/[{}\\\n\r]/.test(v)) return null;
  return `'${v.replace(/'/g, "''")}'`;
}

/** Resolve a panel against the dbt project, or say exactly why it cannot be native yet. */
function nativeQuery(p: SnapshotPanel, index: SemanticIndex): { ok: true; q: NativeQuery } | { ok: false; reason: string } {
  const metrics: string[] = [];
  for (const m of p.metrics) {
    const name = index.metricByMember.get(m.member);
    if (!name) return { ok: false, reason: `member ${m.member} has no dbt metric in this project yet` };
    metrics.push(name);
  }
  const dimOf = (member: string, want?: 'time') => {
    const d = index.dimension(viewOf(member), leaf(member));
    if (!d) return { err: `dimension ${member} is not a dimension of a dbt semantic model` };
    if (want === 'time' && d.type !== 'time') return { err: `${member} is not a time dimension in the dbt semantic model` };
    return { d };
  };
  const dims: SemanticDimension[] = [];
  for (const member of p.dimensions) {
    const r = dimOf(member);
    if (!r.d) return { ok: false, reason: r.err! };
    dims.push(r.d);
  }
  let time: NativeQuery['time'];
  if (p.timeDimension) {
    const r = dimOf(p.timeDimension, 'time');
    if (!r.d) return { ok: false, reason: r.err! };
    time = { dim: r.d, grain: p.timeGrain ?? 'day' };
  }
  const where: string[] = [];
  for (const f of p.filters) {
    const r = dimOf(f.member);
    if (!r.d) return { ok: false, reason: r.err! };
    const lits = f.values.map(literal);
    if (lits.some((l) => l === null) || lits.length === 0) return { ok: false, reason: `a filter value on ${f.member} cannot be written as a MetricFlow where clause` };
    const lhs = `{{ Dimension('${r.d.qualified}') }}`;
    where.push(f.operator === 'equals' && lits.length === 1 ? `${lhs} = ${lits[0]}` : `${lhs} IN (${lits.join(', ')})`);
  }
  return { ok: true, q: { metrics, dims, ...(time ? { time } : {}), where } };
}

/** The MetricFlow output column of a time dimension at a grain (`orders__order_date__month`). */
const timeColumn = (t: { dim: SemanticDimension; grain: string }) => `${t.dim.qualified}__${t.grain}`;

/** The Vega-Lite v5 spec of one panel. Fields are MetricFlow's column names; data is the saved query. */
export function vegaLiteSpec(p: SnapshotPanel, dataName: string, fields: { metrics: string[]; dims: string[]; time?: string }): Record<string, unknown> {
  const multi = fields.metrics.length > 1;
  const fold = multi ? { transform: [{ fold: fields.metrics, as: ['metric', 'value'] }] } : {};
  const value = { field: multi ? 'value' : fields.metrics[0], type: 'quantitative' };
  const category = fields.dims[0] ? { field: fields.dims[0], type: 'nominal' } : undefined;
  const timeX = fields.time ? { field: fields.time, type: 'temporal' } : undefined;
  const color = multi ? { field: 'metric', type: 'nominal' } : fields.time && category ? category : undefined;
  const base = { $schema: VEGA_LITE_SCHEMA, title: p.name, data: { name: dataName } };
  const viz = p.viz === 'big_number_total' ? 'big_number' : p.viz;
  switch (viz) {
    case 'line':
    case 'area':
    case 'bar': {
      const x = viz === 'bar' ? (category ?? timeX) : (timeX ?? category);
      return { ...base, ...fold, mark: { type: viz }, encoding: { ...(x ? { x } : {}), y: value, ...(color && color !== x ? { color } : {}) } };
    }
    case 'pie':
      return { ...base, ...fold, mark: { type: 'arc' }, encoding: { theta: value, ...(category ?? timeX ? { color: category ?? timeX } : {}) } };
    case 'table':
      return {
        ...base,
        ...fold,
        mark: { type: 'text' },
        encoding: { y: category ?? timeX ?? { field: multi ? 'metric' : fields.metrics[0], type: 'nominal' }, ...(multi ? { x: { field: 'metric', type: 'nominal' } } : {}), text: value },
      };
    default:
      return { ...base, ...fold, mark: { type: 'text' }, encoding: { text: value } };
  }
}

/** The OS viz a Vega-Lite spec draws as (the renderer follows the file). */
export function vizFromVegaLite(spec: Record<string, unknown>, file: string): VizType {
  const mark = asObj(spec.mark).type ?? spec.mark;
  const enc = asObj(spec.encoding);
  switch (mark) {
    case 'line':
    case 'area':
    case 'bar':
      return mark;
    case 'arc':
      return 'pie';
    case 'text':
      return enc.y || enc.x ? 'table' : 'big_number';
    default:
      return bad(`\`mark\` is “${String(mark)}”; the OS draws the Vega-Lite subset line | area | bar | arc | text`, file);
  }
}

// ---------------------------------------------------------------- render ---

const yamlOf = (doc: unknown) => dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });

type RenderedPanel = { panel: SnapshotPanel; sq?: string; q?: NativeQuery; pending?: string };

function renderPanels(placed: PlacedDashboard, index: SemanticIndex): RenderedPanel[] {
  const taken = new Set<string>();
  return placed.dashboard.panels.map((panel) => {
    const r = nativeQuery(panel, index);
    if (!r.ok) return { panel, pending: r.reason };
    let name = savedQueryName(placed, panel.id);
    for (let i = 2; taken.has(name); i += 1) name = dbtName(`${savedQueryName(placed, panel.id)}_${i}`);
    taken.add(name);
    return { panel, sq: name, q: r.q };
  });
}

function renderSemanticYaml(placed: PlacedDashboard, panels: RenderedPanel[]): string {
  const d = placed.dashboard;
  const saved = panels.filter((p) => p.sq).map(({ panel, sq, q }) => ({
    name: sq,
    label: panel.name,
    description: `Panel “${panel.name}” of the dashboard “${d.name}”.`,
    query_params: {
      metrics: q!.metrics,
      ...(q!.dims.length || q!.time
        ? { group_by: [...q!.dims.map((x) => `Dimension('${x.qualified}')`), ...(q!.time ? [`TimeDimension('${q!.time.dim.qualified}', '${q!.time.grain}')`] : [])] }
        : {}),
      ...(q!.where.length ? { where: q!.where } : {}),
    },
    config: { meta: { os_dashboard: d.id, os_panel: panel.id } },
  }));
  const deps = [...new Set(panels.flatMap((p) => p.q?.metrics ?? []))].sort().map((m) => `metric('${m}')`);
  const doc = {
    version: 2,
    ...(saved.length ? { saved_queries: saved } : {}),
    exposures: [
      {
        name: exposureName(placed),
        label: d.name,
        type: 'dashboard',
        description: `Sovereign OS dashboard “${d.name}”. Each panel is a saved query above; its chart is panels/<panel>.vl.json (Vega-Lite v5).`,
        owner: { name: ownerRef(d) },
        ...(deps.length ? { depends_on: deps } : {}),
        meta: { os_dashboard: d.id },
      },
    ],
  };
  return `# dbt saved queries (one per panel) and the dbt exposure for this dashboard. Generated by\n# Sovereign OS; \`dbt parse\` validates it. Identity lives only in \`meta\`.\n${yamlOf(doc)}`;
}

function renderOsYaml(placed: PlacedDashboard, domain: string, panels: RenderedPanel[]): string {
  const d = placed.dashboard;
  const doc = {
    apiVersion: API_VERSION,
    kind: NATIVE_KIND,
    metadata: {
      id: d.id,
      name: d.name,
      domain,
      owner: ownerRef(d),
      tier: d.tier,
      folder: d.folder,
      ...(d.lifecycle ? { lifecycle: d.lifecycle } : {}),
    },
    spec: {
      view: d.view,
      ...(d.viewRef ? { viewRef: d.viewRef } : {}),
      ...(d.filters.length ? { filters: d.filters } : {}),
      panels: panels.map(({ panel, sq, pending }) => ({
        id: panel.id,
        name: panel.name,
        ...(sq ? { savedQuery: sq } : {}),
        chart: `${NATIVE_PANELS_DIR}/${panel.id}.vl.json`,
        ...(panel.gridPos ? { gridPos: panel.gridPos } : {}),
        ...(pending
          ? {
              pending: {
                reason: pending,
                metrics: panel.metrics.map((m) => ({ member: m.member, ...(m.ref ? { ref: m.ref } : {}) })),
                ...(panel.dimensions.length ? { dimensions: panel.dimensions } : {}),
                ...(panel.timeDimension ? { timeDimension: panel.timeDimension } : {}),
                ...(panel.timeGrain ? { timeGrain: panel.timeGrain } : {}),
                ...(panel.filters.length ? { filters: panel.filters } : {}),
              },
            }
          : {}),
      })),
    },
  };
  return `# The OS layer of this dashboard: identity, audience, layout. dbt and Vega-Lite never read it;\n# delete it and \`dbt parse\` + \`vl-convert\` still work (artifact contract 11, AT-f).\n${yamlOf(doc)}`;
}

function renderNativeReadme(placed: PlacedDashboard, domain: string, panels: RenderedPanel[]): string {
  const d = placed.dashboard;
  const out = [
    `# ${d.name}`,
    '',
    `- **Id** \`${d.id}\` · **Domain** \`${domain}\` · **Audience** \`${d.tier}\` · **Owner** \`${ownerRef(d)}\` (opaque token)`,
    '',
    '| Panel | Chart | dbt saved query |',
    '|---|---|---|',
    ...panels.map(({ panel, sq, pending }) => `| ${panel.name} | \`${NATIVE_PANELS_DIR}/${panel.id}.vl.json\` | ${sq ? `\`${sq}\`` : `not yet a dbt saved query — ${pending}`} |`),
    '',
    '## Run it without the OS',
    '',
    '```sh',
    'dbt parse                                   # validates semantic.yml against the project\'s metrics',
    `mf query --saved-query <name> --csv out.csv  # MetricFlow (once the project runs it)`,
    `vl-convert vl2png -i ${placed.dir}/${NATIVE_PANELS_DIR}/<panel>.vl.json -o panel.png  # data inlined from out.csv`,
    '```',
    '',
    'Inside the OS every number is still queried **as the viewer**, so row-level security applies.',
    '`os.yaml` is the OS layer (identity, audience, layout) and is not read by dbt or Vega-Lite.',
    '',
    'Upstream docs: https://docs.getdbt.com/docs/build/saved-queries · https://docs.getdbt.com/docs/build/exposures · https://vega.github.io/vega-lite/docs/',
    '',
  ];
  return out.join('\n');
}

/** Every native file of one dashboard. */
export function generateNativeDashboardDir(placed: PlacedDashboard, domain: string, index: SemanticIndex): Map<string, string> {
  const panels = renderPanels(placed, index);
  const files = new Map<string, string>();
  files.set(`${placed.dir}/${NATIVE_SEMANTIC_FILE}`, renderSemanticYaml(placed, panels));
  files.set(`${placed.dir}/${NATIVE_OS_FILE}`, renderOsYaml(placed, domain, panels));
  files.set(`${placed.dir}/README.md`, renderNativeReadme(placed, domain, panels));
  for (const { panel, sq, q } of panels) {
    const fields = q
      ? { metrics: q.metrics, dims: q.dims.map((x) => x.qualified), ...(q.time ? { time: timeColumn(q.time) } : {}) }
      : { metrics: panel.metrics.map((m) => dbtName(leaf(m.member))), dims: panel.dimensions.map((x) => dbtName(leaf(x))), ...(panel.timeDimension ? { time: dbtName(leaf(panel.timeDimension)) } : {}) };
    const spec = vegaLiteSpec(panel, sq ?? savedQueryName(placed, panel.id), fields);
    files.set(`${placed.dir}/${NATIVE_PANELS_DIR}/${panel.id}.vl.json`, `${JSON.stringify(spec, null, 2)}\n`);
  }
  return files;
}

/** The complete native `dashboards/` subtree: index + one native directory per dashboard. */
export function generateNativeDashboardFiles(snapshot: DashboardProjectSnapshot, index: SemanticIndex): Map<string, string> {
  const placed = placeDashboards(snapshot);
  const files = new Map<string, string>();
  files.set(`${DASHBOARDS_PREFIX}index.yml`, renderIndex(snapshot, placed));
  for (const p of placed) for (const [k, v] of generateNativeDashboardDir(p, snapshot.domain, index)) files.set(k, v);
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------- read back ---

/** Vega-Lite v5 top-level keys the OS emits or accepts. Anything else (an `os:` block, SQL) is refused. */
const VL_TOP_LEVEL = new Set(['$schema', 'title', 'description', 'data', 'mark', 'encoding', 'transform', 'width', 'height', 'config', 'autosize', 'background', 'padding', 'params', 'name', 'usermeta']);

/** Parse and shape-check one Vega-Lite file. Full v5 JSON-Schema validation runs in CI (eject test). */
export function parseVegaLite(text: string, file: string): Record<string, unknown> {
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (e) {
    bad(`not valid JSON — ${e instanceof Error ? e.message : String(e)}`, file);
  }
  const o = asObj(spec);
  if (o.$schema !== VEGA_LITE_SCHEMA) bad(`\`$schema\` must be ${VEGA_LITE_SCHEMA}`, file);
  for (const k of Object.keys(o)) {
    if (!VL_TOP_LEVEL.has(k)) bad(`\`${k}\` is not a Vega-Lite top-level property this OS accepts (OS metadata belongs in os.yaml)`, file);
  }
  assertNoQueryKeys(o.encoding, 'encoding', file);
  return o;
}

const DIM_RE = /^Dimension\('([a-z0-9_]+)'\)$/;
const TIME_RE = /^TimeDimension\('([a-z0-9_]+)', '([a-z]+)'\)$/;
const WHERE_RE = /^\{\{ Dimension\('([a-z0-9_]+)'\) \}\} (=|IN) (.+)$/;

function parseLiterals(raw: string, file: string): string[] {
  const body = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw;
  const out: string[] = [];
  const re = /\s*'((?:[^']|'')*)'\s*(,|$)/y;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < body.length && (m = re.exec(body))) {
    out.push(m[1].replace(/''/g, "'"));
    at = re.lastIndex;
  }
  if (at !== body.length || out.length === 0) bad(`where clause values \`${raw.slice(0, 60)}\` are not a list of string literals`, file);
  return out;
}

/**
 * Read one dashboard back from its native directory (`files` keys are RELATIVE to `dir`). Numbers
 * come from the saved queries, chart types from the Vega-Lite marks, layout from os.yaml.
 */
export function parseNativeDashboardDir(files: Map<string, string>, index: SemanticIndex, dir: string): SnapshotDashboard {
  const osFile = `${dir}/${NATIVE_OS_FILE}`;
  const semFile = `${dir}/${NATIVE_SEMANTIC_FILE}`;
  const osText = files.get(NATIVE_OS_FILE);
  if (osText === undefined) bad('the dashboard directory has no os.yaml', dir);
  let os: Record<string, unknown>;
  try {
    os = asObj(load(osText!));
  } catch (e) {
    bad(`not valid YAML — ${e instanceof Error ? e.message : String(e)}`, osFile);
  }
  if (os!.apiVersion !== API_VERSION || os!.kind !== NATIVE_KIND) bad(`must be \`apiVersion: ${API_VERSION}\`, \`kind: ${NATIVE_KIND}\``, osFile);
  const meta = asObj(os!.metadata);
  const spec = asObj(os!.spec);
  assertNoQueryKeys(spec, 'spec', osFile);
  const tier = str(meta.tier, 'metadata.tier', osFile) as DashTier;
  if (!['personal', 'domain', 'marketplace'].includes(tier)) bad('`metadata.tier` must be personal | domain | marketplace', osFile);

  const savedByName = new Map<string, Record<string, unknown>>();
  const semText = files.get(NATIVE_SEMANTIC_FILE);
  if (semText !== undefined) {
    let sem: Record<string, unknown>;
    try {
      sem = asObj(load(semText));
    } catch (e) {
      bad(`not valid YAML — ${e instanceof Error ? e.message : String(e)}`, semFile);
    }
    for (const k of Object.keys(sem!)) if (!['version', 'saved_queries', 'exposures'].includes(k)) bad(`\`${k}\` does not belong in a dashboard's semantic.yml`, semFile);
    for (const raw of asArr(sem!.saved_queries)) savedByName.set(s(asObj(raw).name), asObj(raw));
  }

  const panels: SnapshotPanel[] = asArr(spec.panels).map((raw, i) => {
    const p = asObj(raw);
    const where = `spec.panels[${i}]`;
    const id = str(p.id, `${where}.id`, osFile);
    const chartPath = str(p.chart, `${where}.chart`, osFile);
    const chartText = files.get(chartPath);
    if (chartText === undefined) bad(`panel “${id}” names chart ${chartPath}, which is not in the directory`, osFile);
    const viz = vizFromVegaLite(parseVegaLite(chartText!, `${dir}/${chartPath}`), `${dir}/${chartPath}`);
    if (!(VIZ_TYPES as readonly string[]).includes(viz)) bad(`unknown viz ${viz}`, osFile);
    const gridPos = parseGridPos(p.gridPos, `${where}.gridPos`, osFile);
    const common = { id, name: str(p.name, `${where}.name`, osFile), viz, ...(gridPos ? { gridPos } : {}) };

    if (p.pending !== undefined) {
      const pend = asObj(p.pending);
      const grain = pend.timeGrain === undefined ? undefined : str(pend.timeGrain, `${where}.pending.timeGrain`, osFile);
      if (grain !== undefined && !isServableTimeGrain(grain)) bad(`\`${where}.pending.timeGrain\` must be one of ${PANEL_TIME_GRAINS.join(', ')}`, osFile);
      return {
        ...common,
        metrics: asArr(pend.metrics).map((m, j) => ({ member: str(asObj(m).member, `${where}.pending.metrics[${j}].member`, osFile), ref: s(asObj(m).ref) || null })),
        dimensions: asArr(pend.dimensions).map((x, j) => str(x, `${where}.pending.dimensions[${j}]`, osFile)),
        ...(pend.timeDimension ? { timeDimension: str(pend.timeDimension, `${where}.pending.timeDimension`, osFile) } : {}),
        ...(grain ? { timeGrain: grain } : {}),
        filters: parseFilters(pend.filters, `${where}.pending.filters`, osFile),
      };
    }

    const sqName = str(p.savedQuery, `${where}.savedQuery`, osFile);
    const sq = savedByName.get(sqName);
    if (!sq) bad(`panel “${id}” names saved query \`${sqName}\`, which ${NATIVE_SEMANTIC_FILE} does not define`, osFile);
    const qp = asObj(sq!.query_params);
    const metrics = asArr(qp.metrics).map((m) => {
      const hit = index.metrics.get(s(m));
      if (!hit) bad(`saved query \`${sqName}\` names metric \`${s(m)}\`, which the dbt project does not define`, semFile);
      return { member: hit!.member, ref: hit!.osMetric ? `metric:${hit!.osMetric}` : null };
    });
    if (metrics.length === 0) bad(`saved query \`${sqName}\` names no metric`, semFile);
    const dimension = (q: string) => {
      const hit = index.byQualified(q);
      if (!hit) bad(`saved query \`${sqName}\` groups by \`${q}\`, which is not a dimension of the dbt project`, semFile);
      return `${hit!.view}.${hit!.dim.column}`;
    };
    const dimensions: string[] = [];
    let timeDimension: string | undefined;
    let timeGrain: string | undefined;
    for (const g of asArr(qp.group_by).map(s)) {
      const t = TIME_RE.exec(g);
      const dm = DIM_RE.exec(g);
      if (t) {
        if (!isServableTimeGrain(t[2])) bad(`grain \`${t[2]}\` is not one the OS serves (${PANEL_TIME_GRAINS.join(', ')})`, semFile);
        timeDimension = dimension(t[1]);
        timeGrain = t[2];
      } else if (dm) dimensions.push(dimension(dm[1]));
      else bad(`group_by \`${g}\` is not \`Dimension('<entity>__<dim>')\` or \`TimeDimension('<entity>__<dim>', '<grain>')\``, semFile);
    }
    const filters: PanelFilter[] = asArr(qp.where).map((w) => {
      const m = WHERE_RE.exec(s(w));
      if (!m) bad(`where \`${s(w).slice(0, 60)}\` is not \`{{ Dimension('<entity>__<dim>') }} = '<v>'\` or \`IN ('<v>', …)\``, semFile);
      const values = parseLiterals(m![3], semFile);
      return { member: dimension(m![1]), operator: m![2] === '=' && !m![3].startsWith('(') ? 'equals' : 'in', values };
    });
    return { ...common, metrics, dimensions, ...(timeDimension ? { timeDimension } : {}), ...(timeGrain ? { timeGrain } : {}), filters };
  });

  const lifecycle = asObj(meta.lifecycle);
  const lc = Object.fromEntries((['draft', 'testing', 'live'] as const).filter((k) => s(lifecycle[k])).map((k) => [k, s(lifecycle[k])]));
  return {
    id: str(meta.id, 'metadata.id', osFile),
    name: str(meta.name, 'metadata.name', osFile),
    view: str(spec.view, 'spec.view', osFile),
    viewRef: s(spec.viewRef) || null,
    owner: str(meta.owner, 'metadata.owner', osFile),
    ownerIsToken: true,
    tier,
    folder: s(meta.folder).trim() || '/',
    archived: false,
    filters: parseFilters(spec.filters, 'spec.filters', osFile),
    panels,
    ...(Object.keys(lc).length ? { lifecycle: lc } : {}),
  };
}

/** Every native dashboard directory in a tree (path → content, repo-relative), read back. */
export function readNativeDashboards(tree: Map<string, string>, index: SemanticIndex = buildSemanticIndex(tree)): { dir: string; dashboard: SnapshotDashboard }[] {
  const dirs = [...tree.keys()].filter((p) => p.startsWith(DASHBOARDS_PREFIX) && p.endsWith(`/${NATIVE_OS_FILE}`)).map((p) => p.slice(0, -NATIVE_OS_FILE.length - 1)).sort();
  return dirs.map((dir) => {
    const rel = new Map([...tree.entries()].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, c]) => [p.slice(dir.length + 1), c]));
    return { dir, dashboard: parseNativeDashboardDir(rel, index, dir) };
  });
}

export { DashboardFileError };

/** A dashboard read back from its native files, as the spec the OS draws (panels in file order). */
export function nativeToSpec(doc: SnapshotDashboard): DashboardSpec {
  const charts: Panel[] = doc.panels.map((p) => ({
    name: p.name,
    vizType: p.viz,
    metrics: p.metrics.map((m) => m.member),
    ...(p.dimensions.length ? { dimensions: p.dimensions } : {}),
    ...(p.timeDimension ? { timeDimension: p.timeDimension } : {}),
    ...(p.timeGrain ? { timeGrain: p.timeGrain as Panel['timeGrain'] } : {}),
    ...(p.filters.length ? { filters: p.filters } : {}),
    ...(p.gridPos ? { gridPos: p.gridPos } : {}),
  }));
  return { name: doc.name, view: doc.view, charts, ...(doc.filters.length ? { filters: doc.filters } : {}) };
}
