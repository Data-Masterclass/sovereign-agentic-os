/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * FEATURE:    The chat ARTIFACT protocol — one typed payload rendered by the Ask-the-OS
 *             drawer and returned, byte-identical, as the `structuredContent` of the
 *             governed read tools an external MCP client calls.
 *
 * USER STORY: As a user I want every answer about my data to carry the thing it is about —
 *             the rows, the SQL that produced them, the dataset or metric it came from, and
 *             a verbatim banner when the result was clipped — instead of a paragraph of
 *             prose I have to take on trust.
 *
 * ARCHITECTURE:
 *   D14: artifacts ride the MCP standard, not a bespoke envelope. A tool declares an
 *   `outputSchema` ({@link ARTIFACT_OUTPUT_SCHEMA}) and returns `{ artifacts: [...] }` as
 *   `structuredContent`; the UI drawer renders the identical payload. One serialiser, so
 *   UI parity and external-client parity cannot drift.
 *
 *   Six kinds, generalising the `StageSuggestions` family rather than paralleling it:
 *     table · chart · metric_draft · dashboard_draft · citation · clarification
 *   Tonight the `table` and `citation` renderers ship; the other three are declared so the
 *   schema and the protocol are complete and the renderers are additive.
 *
 *   Invariants this module exists to enforce:
 *     • A `table` artifact carries `truncated` / `rowLimit` / `message` VERBATIM from
 *       `core/infra/governed.ts`'s `QueryResult`. {@link tableArtifact} cannot drop them and
 *       a guard test proves it. Rows at a `rowLimit` are the FIRST n, never a sample.
 *     • Every value is DATA, rendered as a text node. No HTML, SVG, JS or markdown is ever
 *       carried in an artifact, so there is nothing for a renderer to interpret. The guard
 *       test in `chat-artifacts.test.ts` pins the absence of `dangerouslySetInnerHTML`,
 *       `eval` and `new Function` on the whole chat path.
 *     • A number in an artifact comes from a governed tool result. The mappers below are
 *       pure projections of a tool's own return value — they never compute, round or total.
 *
 *   PURE: no `server-only`, no transport, no React. The tab MCP tools (data, metrics,
 *   dashboards, admin) import the mappers; the drawer imports the types. Inputs are
 *   duck-typed structural shapes so the kernel never has to know a tab's module exists.
 */

// ---------------------------------------------------------------- the six kinds ----

/** The scope ladder label a citation shows, when the governed record carries one. */
export type ArtifactTier = string;

/**
 * A bounded result table. `rows` are ALWAYS `string[][]` aligned to `columns` — the wire
 * shape `queryRun` already returns, so nothing is re-typed on the way through.
 */
export type TableArtifact = {
  kind: 'table';
  /** Column headers, in row order. */
  columns: string[];
  /** The rows as the governed query path returned them. */
  rows: string[][];
  /** The row count the tool reported — NOT `rows.length` when the result was clipped. */
  rowCount: number;
  /** True when the query-tool clipped the result at its ceiling. The rows are the FIRST n. */
  truncated?: boolean;
  /** The ceiling that clipped it. */
  rowLimit?: number;
  /** The query-tool's OWN sentence about the truncation, shown verbatim. */
  message?: string;
  /** The SQL that ran, when the answer came from SQL (collapsed in the UI). */
  sql?: string;
  /** The compiled semantic query, when the answer came from the semantic layer. */
  semanticQuery?: string;
  /** How the number was produced: the governed semantic layer, or ad-hoc SQL. */
  source: 'semantic-layer' | 'ad-hoc-sql';
  /** The resolver mode the tool reported (`live`, `live (sql)`, `offline-mock`, …). */
  mode?: string;
  /** A short title for the table (the metric member, or the tool name). */
  title?: string;
};

/**
 * A chart to render. The payload is a dashboards `Panel` plus the governed view it binds
 * to; the client POSTs it to `/api/dashboards/panel-query` and mounts the existing
 * `PanelChart`, so the chart in chat is byte-identical to the chart on the dashboard and
 * carries the viewer's own row-level security. `panel` is deliberately opaque here — the
 * kernel must not import the dashboards tab's model.
 */
export type ChartArtifact = {
  kind: 'chart';
  view: string;
  panel: Record<string, unknown>;
  title?: string;
};

/** A proposed metric definition, not yet persisted. The confirm step is the user's. */
export type MetricDraftArtifact = {
  kind: 'metric_draft';
  datasetId: string;
  /** The ready-to-define form `define_metric` accepts (aggregation + real column + dims). */
  form: Record<string, unknown>;
  previewRows?: string[][];
  previewColumns?: string[];
  previewMode?: string;
  previewSql?: string;
  /** The generated semantic-layer YAML, when the tool returned it. */
  definitionYaml?: string;
};

/** A proposed dashboard, not yet persisted. */
export type DashboardDraftArtifact = {
  kind: 'dashboard_draft';
  id?: string;
  name: string;
  view: string;
  charts: Record<string, unknown>[];
  /** The tool's own missing-member warnings, carried verbatim — never swallowed. */
  warnings?: string[];
};

/** What an answer is grounded in: the dataset, metric or dashboard it read. */
export type CitationArtifact = {
  kind: 'citation';
  of: 'dataset' | 'metric' | 'dashboard';
  id: string;
  name?: string;
  tier?: ArtifactTier;
  owner?: string;
  /** A freshness note the governed record carried (e.g. the gold build time). */
  freshness?: string;
};

/** A question back to the user, with one-click options. Never a free-text guess. */
export type ClarificationArtifact = {
  kind: 'clarification';
  question: string;
  options: { label: string; value: string }[];
};

export type ChatArtifact =
  | TableArtifact
  | ChartArtifact
  | MetricDraftArtifact
  | DashboardDraftArtifact
  | CitationArtifact
  | ClarificationArtifact;

export const ARTIFACT_KINDS = [
  'table',
  'chart',
  'metric_draft',
  'dashboard_draft',
  'citation',
  'clarification',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The envelope a tool returns as `structuredContent` and the route returns as `artifacts[]`. */
export type ArtifactEnvelope = { artifacts: ChatArtifact[] };

// ------------------------------------------------------------------ outputSchema ----

/**
 * The MCP `outputSchema` every artifact-producing read tool declares. The spec requires a
 * server's `structuredContent` to CONFORM to the schema it declared, and clients SHOULD
 * validate — so this is the contract, not documentation. Deliberately
 * `additionalProperties: true` on each artifact so a later kind's new field is not a
 * breaking change for a client validating today's payload.
 */
export const ARTIFACT_OUTPUT_SCHEMA = {
  type: 'object' as const,
  description:
    'A typed artifact payload the client RENDERS: tables carry their own truncation banner and the ' +
    'SQL or semantic query that produced them; citations name the governed record the answer is ' +
    'grounded in. The client renders values as text — no markup is ever carried here.',
  properties: {
    artifacts: {
      type: 'array',
      description: 'Zero or more artifacts, in the order they should be shown.',
      items: {
        type: 'object',
        required: ['kind'],
        additionalProperties: true,
        properties: {
          kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          rowCount: { type: 'number' },
          truncated: { type: 'boolean', description: 'The rows are the FIRST n at `rowLimit`, not a sample.' },
          rowLimit: { type: 'number' },
          message: { type: 'string', description: "The query-tool's own truncation sentence, verbatim." },
          sql: { type: 'string' },
          semanticQuery: { type: 'string' },
          source: { type: 'string', enum: ['semantic-layer', 'ad-hoc-sql'] },
          mode: { type: 'string' },
          title: { type: 'string' },
          view: { type: 'string' },
          panel: { type: 'object' },
          datasetId: { type: 'string' },
          form: { type: 'object' },
          previewRows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          previewColumns: { type: 'array', items: { type: 'string' } },
          previewMode: { type: 'string' },
          previewSql: { type: 'string' },
          definitionYaml: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          charts: { type: 'array', items: { type: 'object' } },
          warnings: { type: 'array', items: { type: 'string' } },
          of: { type: 'string', enum: ['dataset', 'metric', 'dashboard'] },
          tier: { type: 'string' },
          owner: { type: 'string' },
          freshness: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } },
          },
        },
      },
    },
  },
  required: ['artifacts'],
} as const;

// ------------------------------------------------------------------- the mappers ----

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Coerce one cell to the wire's string shape. `null`/`undefined` become `''`, never "null". */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function stringRows(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Array.isArray).map((r) => (r as unknown[]).map(cell));
}

/** The truncation fields, lifted off any `QueryResult`-shaped value. Never dropped. */
export type TruncationFields = { truncated?: boolean; rowLimit?: number; message?: string };

/**
 * Lift `truncated` / `rowLimit` / `message` off a governed query result. The ONE place the
 * chat path reads them, so the guard test has a single thing to pin. A value that is not
 * truncated contributes no keys at all (never `truncated: false`, which reads as a claim).
 */
export function truncationOf(result: unknown): TruncationFields {
  const r = (result ?? {}) as Record<string, unknown>;
  const out: TruncationFields = {};
  if (r.truncated === true) out.truncated = true;
  const limit = n(r.rowLimit);
  if (limit !== undefined) out.rowLimit = limit;
  const msg = s(r.message);
  if (msg) out.message = msg;
  return out;
}

/**
 * Build a `table` artifact from a governed query result. `source` is the caller's
 * declaration of which path produced it — the semantic layer or ad-hoc SQL — because the
 * UI labels an ad-hoc answer as unverified (C6).
 */
export function tableArtifact(
  result: unknown,
  opts: { source: TableArtifact['source']; sql?: string; semanticQuery?: string; title?: string; mode?: string },
): TableArtifact {
  const r = (result ?? {}) as Record<string, unknown>;
  const rows = stringRows(r.rows);
  const columns = Array.isArray(r.columns) ? (r.columns as unknown[]).map(cell) : [];
  const artifact: TableArtifact = {
    kind: 'table',
    columns,
    rows,
    // The tool's own count when it reported one. Falling back to `rows.length` would
    // UNDERSTATE a clipped result, which is the exact lie this module exists to prevent.
    rowCount: n(r.rowCount) ?? rows.length,
    source: opts.source,
    ...truncationOf(result),
  };
  if (opts.sql) artifact.sql = opts.sql;
  if (opts.semanticQuery) artifact.semanticQuery = opts.semanticQuery;
  if (opts.title) artifact.title = opts.title;
  const mode = opts.mode ?? s(r.mode);
  if (mode) artifact.mode = mode;
  return artifact;
}

/**
 * Build a `table` artifact from a semantic-layer result whose rows are OBJECTS keyed by
 * member name (`query_metric` / `preview_metric` / `exploreMetric` shape) rather than the
 * query-tool's positional `string[][]`. Columns are the union of the keys, in first-seen
 * order, so a grouped result keeps its dimension columns.
 */
export function tableArtifactFromObjectRows(
  rows: unknown,
  opts: { source: TableArtifact['source']; title?: string; mode?: string; semanticQuery?: string; sql?: string },
): TableArtifact {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const columns: string[] = [];
  for (const row of list) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const matrix = list.map((row) => columns.map((c) => cell((row as Record<string, unknown>)[c])));
  const artifact: TableArtifact = {
    kind: 'table',
    columns,
    rows: matrix,
    rowCount: matrix.length,
    source: opts.source,
  };
  if (opts.title) artifact.title = opts.title;
  if (opts.mode) artifact.mode = opts.mode;
  if (opts.semanticQuery) artifact.semanticQuery = opts.semanticQuery;
  if (opts.sql) artifact.sql = opts.sql;
  return artifact;
}

/** A citation chip for the governed record an answer was grounded in. */
export function citationArtifact(
  of: CitationArtifact['of'],
  id: string,
  extra: { name?: string; tier?: string; owner?: string; freshness?: string } = {},
): CitationArtifact {
  const c: CitationArtifact = { kind: 'citation', of, id };
  if (extra.name) c.name = extra.name;
  if (extra.tier) c.tier = extra.tier;
  if (extra.owner) c.owner = extra.owner;
  if (extra.freshness) c.freshness = extra.freshness;
  return c;
}

/** Wrap artifacts in the envelope a tool returns as `structuredContent`. */
export function envelope(artifacts: ChatArtifact[]): ArtifactEnvelope {
  return { artifacts };
}

// --------------------------------------------------------------------- round-trip ----

function isKind(v: unknown): v is ArtifactKind {
  return typeof v === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(v);
}

/**
 * Validate and narrow an unknown value (a tool's `structuredContent`, read back off the
 * wire) into artifacts. Unknown kinds and malformed entries are DROPPED rather than
 * rendered — a client must never be asked to render something it does not understand, and
 * a partial payload is better than a thrown route.
 */
export function parseArtifacts(raw: unknown): ChatArtifact[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(list)) return [];
  const out: ChatArtifact[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = (entry as { kind?: unknown }).kind;
    if (!isKind(kind)) continue;
    if (kind === 'table') {
      const t = entry as Partial<TableArtifact>;
      out.push({
        ...t,
        kind: 'table',
        columns: Array.isArray(t.columns) ? t.columns.map(cell) : [],
        rows: stringRows(t.rows),
        rowCount: n(t.rowCount) ?? (Array.isArray(t.rows) ? t.rows.length : 0),
        source: t.source === 'semantic-layer' ? 'semantic-layer' : 'ad-hoc-sql',
      });
      continue;
    }
    if (kind === 'citation') {
      const c = entry as Partial<CitationArtifact>;
      const of = c.of === 'dataset' || c.of === 'metric' || c.of === 'dashboard' ? c.of : undefined;
      if (!of || !s(c.id)) continue;
      out.push({ ...c, kind: 'citation', of, id: s(c.id) });
      continue;
    }
    if (kind === 'clarification') {
      const q = entry as Partial<ClarificationArtifact>;
      if (!s(q.question)) continue;
      out.push({
        kind: 'clarification',
        question: s(q.question),
        options: Array.isArray(q.options)
          ? q.options
              .filter((o) => o && typeof o === 'object')
              .map((o) => ({ label: s((o as { label?: unknown }).label), value: s((o as { value?: unknown }).value) }))
              .filter((o) => o.label.length > 0)
          : [],
      });
      continue;
    }
    // chart / metric_draft / dashboard_draft: carried through for the renderers that land
    // next, structurally validated only on their required identity fields.
    if (kind === 'chart') {
      const c = entry as Partial<ChartArtifact>;
      if (!s(c.view) || !c.panel || typeof c.panel !== 'object') continue;
      out.push({ ...c, kind: 'chart', view: s(c.view), panel: c.panel as Record<string, unknown> });
      continue;
    }
    if (kind === 'metric_draft') {
      const d = entry as Partial<MetricDraftArtifact>;
      if (!s(d.datasetId) || !d.form || typeof d.form !== 'object') continue;
      out.push({ ...d, kind: 'metric_draft', datasetId: s(d.datasetId), form: d.form as Record<string, unknown> });
      continue;
    }
    const d = entry as Partial<DashboardDraftArtifact>;
    if (!s(d.name) || !s(d.view)) continue;
    out.push({
      ...d,
      kind: 'dashboard_draft',
      name: s(d.name),
      view: s(d.view),
      charts: Array.isArray(d.charts) ? (d.charts.filter((c) => c && typeof c === 'object') as Record<string, unknown>[]) : [],
    });
  }
  return out;
}

/**
 * The human-readable truncation banner. Prefers the query-tool's OWN sentence verbatim and
 * only falls back to a sentence of our own when it sent none — a surface that paraphrases
 * the backend's wording is how a row bound gets quietly lost.
 */
export function truncationBanner(a: TableArtifact): string | null {
  if (!a.truncated) return null;
  if (a.message) return a.message;
  const bound = a.rowLimit !== undefined ? ` at the ${a.rowLimit}-row ceiling` : '';
  return `This result was clipped${bound}. These are the FIRST rows, not a sample — do not total them.`;
}
