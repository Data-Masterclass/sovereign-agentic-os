/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The DATA-PLAN model (0.6.101) — the pure, client-safe core of the Software builder's
 * explicit data-resolution step. Today the builder discovers an app's data needs
 * MID-BUILD and fails cryptically (a story needs employee data, the app has zero granted
 * datasets, the build model refuses with an empty commit). Instead, the Design assistant
 * proposes a DATA PLAN — one item per data ENTITY the app needs — and the user RESOLVES
 * each need up front by (a) binding an existing dataset (the `suggestedGrants` path),
 * (b) creating a new EMPTY dataset (schema only), or (c) creating a new dataset with
 * AI-generated realistic DUMMY rows so the story is demoable.
 *
 * This file is PURE (no server-only / Next imports) so the unit tests and both seams
 * (the assistant normalize step + the server resolve action) share ONE source of truth:
 *   • {@link SuggestedDataset} — the create-new suggestion shape the assistant emits;
 *   • {@link normalizeSuggestedDatasets} — the defensive validator (drops malformed;
 *     a real column list is REQUIRED);
 *   • {@link dummyGridFromRows} — fold AI-produced row objects into the Grid the bronze
 *     ingest path lands (all_varchar; bronze stays raw);
 *   • {@link DUMMY_ROWS_DEFAULT}/{@link DUMMY_ROWS_MAX} — the bounded row count;
 *   • {@link storyImpliesData}/{@link unresolvedDataNeedWarning} — the build gate that
 *     replaces the cryptic empty-commit with an honest, actionable message.
 *
 * The materialization itself (createDataset → bronze ingest → grant) lives in the
 * server twin `data-plan-server.ts`; this module never touches the store.
 */

/** A column the app's data need requires: a name + a coarse logical type (advisory). */
export type SuggestedColumn = {
  name: string;
  /** Coarse logical type — advisory only; bronze lands raw (all_varchar). */
  type: string;
};

/** How a create-new dataset need should be filled. */
export type DatasetFill = 'empty' | 'dummy';

/**
 * A CREATE-NEW dataset the Design assistant proposes for a data need. Distinct from
 * `suggestedGrants` (which BINDS an existing dataset) — this MAKES a new governed dataset
 * in the user's personal lane, either empty (schema only) or with AI dummy rows.
 */
export type SuggestedDataset = {
  /** The dataset name (also the entity: "employees", "cases", "service centers"). */
  name: string;
  /** A short human purpose — which story/need this dataset serves. */
  purpose?: string;
  /** The inferred schema — REQUIRED and non-empty (a create-new need must have columns). */
  columns: SuggestedColumn[];
  /** 'empty' = schema only (0 rows); 'dummy' = persist N realistic AI-generated rows. */
  fill: DatasetFill;
  /** For 'dummy': how many rows to generate (bounded on apply). Ignored for 'empty'. */
  rows?: number;
};

/** Default dummy-row count when the assistant omits one. */
export const DUMMY_ROWS_DEFAULT = 25;
/** Hard cap on dummy rows — keeps generation bounded + cheap (this is not a data engine). */
export const DUMMY_ROWS_MAX = 100;

/** Clamp a requested dummy-row count into [1, {@link DUMMY_ROWS_MAX}], defaulting when absent. */
export function boundDummyRows(rows: number | undefined): number {
  if (typeof rows !== 'number' || !Number.isFinite(rows)) return DUMMY_ROWS_DEFAULT;
  return Math.max(1, Math.min(DUMMY_ROWS_MAX, Math.floor(rows)));
}

// ---------------------------------------------------------------- validation --

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Shape-guard a raw columns blob into a non-empty {name,type}[] (or null if none valid). */
function normalizeColumns(raw: unknown): SuggestedColumn[] | null {
  if (!Array.isArray(raw)) return null;
  const cols: SuggestedColumn[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const name = str(o.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // a column name maps to ONE physical column — de-dup.
    seen.add(key);
    cols.push({ name, type: str(o.type).trim() || 'string' });
  }
  return cols.length > 0 ? cols : null;
}

/**
 * Defensively normalise the raw `suggestedDatasets` array from a model reply into a
 * clean {@link SuggestedDataset}[]. A malformed item degrades to "dropped" (never
 * throws): an item MUST have a non-empty name AND a real (non-empty) column list; an
 * unknown `fill` defaults to 'empty' (the safe, no-generation choice). Returns undefined
 * when nothing valid remains, so the caller omits the field entirely.
 */
export function normalizeSuggestedDatasets(raw: unknown): SuggestedDataset[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SuggestedDataset[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const name = str(o.name).trim();
    if (!name) continue;
    const columns = normalizeColumns(o.columns);
    if (!columns) continue; // a real column list is REQUIRED — no columns ⇒ drop.
    const fill: DatasetFill = o.fill === 'dummy' ? 'dummy' : 'empty';
    const rowsRaw = o.rows;
    const rows = typeof rowsRaw === 'number' && Number.isFinite(rowsRaw) ? boundDummyRows(rowsRaw) : undefined;
    out.push({
      name,
      purpose: str(o.purpose).trim() || undefined,
      columns,
      fill,
      ...(fill === 'dummy' && rows !== undefined ? { rows } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

// ------------------------------------------------------------- dummy → Grid ---

/** A plain grid the bronze ingest path lands (columns + string cells; bronze stays raw). */
export type Grid = { columns: string[]; rows: string[][] };

/**
 * Fold AI-produced ROW OBJECTS (each a `{ [column]: value }` record) into the {@link Grid}
 * the bronze ingest lands — one string cell per declared column, in COLUMN ORDER, so the
 * physical table matches the schema exactly. Missing keys become '' (empty), extra keys
 * are ignored, and every value is stringified (bronze is all_varchar — no coercion). The
 * count is bounded to `max` so a chatty model can't blow the row budget.
 */
export function dummyGridFromRows(
  columns: SuggestedColumn[],
  rawRows: unknown,
  max: number = DUMMY_ROWS_MAX,
): Grid {
  const names = columns.map((c) => c.name);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  };
  const rows: string[][] = [];
  const list = Array.isArray(rawRows) ? rawRows : [];
  for (const r of list) {
    if (rows.length >= max) break;
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    rows.push(names.map((n) => cell(rec[n])));
  }
  return { columns: names, rows };
}

// ------------------------------------------------------------- build gate -----

/** The minimal story/spec shape the data-need gate reads. */
export type GateStory = {
  title?: string;
  iWant?: string;
  soThat?: string;
  acceptance?: string;
  spec?: { features?: string[]; nfrs?: string[]; rules?: string[] };
};

/**
 * DATA-SIGNAL words: verbs/nouns whose presence in a story STRONGLY implies the story
 * reads or writes rows of a governed entity (so it needs a dataset). Deliberately
 * conservative — a WARNING, not a hard block (a false positive must not reject a good
 * build), so we key on words that almost always mean "there is a table behind this".
 */
const DATA_SIGNAL =
  /\b(list|table|records?|rows?|dataset|database|employees?|customers?|orders?|cases?|invoices?|tickets?|inventory|catalog(?:ue)?|report|dashboard|filter|search|sort|export|import|entries|directory|roster|ledger)\b/i;

/** Whether ONE story's text/spec implies it needs data (a governed entity behind it). */
export function storyImpliesData(story: GateStory): boolean {
  const hay = [
    story.title,
    story.iWant,
    story.soThat,
    story.acceptance,
    ...(story.spec?.features ?? []),
    ...(story.spec?.rules ?? []),
  ]
    .filter(Boolean)
    .join(' \n ');
  return DATA_SIGNAL.test(hay);
}

/** The stories (by title) across all epics that imply a data need. */
export function storiesImplyingData(
  epics: { stories?: GateStory[] }[],
): string[] {
  const out: string[] = [];
  for (const e of epics) {
    for (const s of e.stories ?? []) {
      if (storyImpliesData(s)) out.push((s.title ?? '').trim() || '(untitled story)');
    }
  }
  return out;
}

/**
 * The build-gate WARNING — '' when there is nothing to warn about. Fires ONLY when the
 * app has ZERO granted datasets (`grantedDataCount === 0`) AND at least one story implies
 * a data need. Mirrors the 0.6.97 ungranted-dataset guard: a loud, actionable message
 * that NAMES the need and the fix, never a silent empty commit. It is a warning (not a
 * hard block) — the conservative signal could false-positive, so a good build must never
 * be rejected on the heuristic alone.
 */
export function unresolvedDataNeedWarning(
  epics: { stories?: GateStory[] }[],
  grantedDataCount: number,
  serveMode?: 'spec' | 'code',
): string {
  if (grantedDataCount > 0) return ''; // some dataset is bound — nothing to warn.
  const needy = storiesImplyingData(epics);
  if (needy.length === 0) return '';
  const shown = needy.slice(0, 8);
  const more = needy.length - shown.length;
  // A DECLARATIVE (spec) app is authored by non-coders and served with no model/agent — the
  // "no schema to write against" framing is coded-path language and is wrong here. Speak in
  // terms of tabs: read-tabs need a granted dataset; input-only tabs don't.
  const closing = serveMode === 'spec'
    ? 'Resolve it in Choose Context — bind an existing dataset or create one (empty, or with sample data). ' +
      'Tabs that read data need a granted dataset; tabs that only collect input don’t.'
    : 'Resolve it in Choose Context — bind an existing dataset or create one (empty, or with sample data) — then build. ' +
      'Building now would fail: the model has no schema to write against.';
  return [
    `${needy.length} stor${needy.length === 1 ? 'y needs' : 'ies need'} data, but no dataset is bound to this app:`,
    shown.map((t) => `  • ${t}`).join('\n') + (more > 0 ? `\n  • …and ${more} more` : ''),
    closing,
  ].join('\n');
}
