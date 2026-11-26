/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { truncationBanner, type ChatArtifact, type CitationArtifact, type TableArtifact } from '@core/runtime/chat-artifacts';
import { viewText, type Shown, type ViewText } from '@core/ui/chat-view';

/**
 * FEATURE:    The presentation logic behind the Ask-the-OS artifact renderers.
 *
 * USER STORY: As a user I want a chat answer's table to be readable and to tell me the
 *             truth about what I am looking at — whether the backend clipped the result,
 *             whether this view clipped it further, and whether the number is the governed
 *             one or an ad-hoc query.
 *
 * ARCHITECTURE:
 *   A test cannot import a `.tsx` (Node strips types but not JSX), so every decision the
 *   renderer makes lives here and `core/ui/AskArtifacts.tsx` is the shell that mounts it —
 *   the `core/ui/account-menu.ts` pattern.
 *
 *   TWO truncations, both honest. The BACKEND's (`truncated` / `rowLimit` / `message`) is
 *   the query-tool's own and is shown verbatim; THIS VIEW's row cap is ours and is labelled
 *   separately, because conflating them would let a 50-row view read as a 50-row result.
 *   Neither is ever silent.
 *
 *   No value is ever interpreted. A cell is clamped and rendered as a text node by the
 *   component — there is no markdown, no HTML and no SVG on this path, which is what makes
 *   the `dangerouslySetInnerHTML` guard test meaningful rather than aspirational.
 *
 *   I18N: every sentence this module writes is a `ViewText` key in the `home` namespace
 *   (`artifacts.*`), translated by the shell; the tool's own sentences (banner, warning) and the
 *   model's title stay verbatim.
 */

/** Rows this view shows before it says so. A chat drawer is not a data grid. */
export const VIEW_ROW_CAP = 50;
/** Characters a single cell shows before it is clamped with an ellipsis. */
export const CELL_CHAR_CAP = 160;

/** Clamp one cell for display. Returns the text and whether it was clamped. */
export function clampCell(value: string, cap: number = CELL_CHAR_CAP): { text: string; clamped: boolean } {
  if (value.length <= cap) return { text: value, clamped: false };
  return { text: `${value.slice(0, cap)}…`, clamped: true };
}

/** What the view decided to show for one table, and what it must say about it. */
export type TableView = {
  columns: string[];
  rows: string[][];
  /** The count the TOOL reported — the authoritative size of the result. */
  rowCount: number;
  /** True when THIS VIEW showed fewer rows than the artifact carried. */
  viewClipped: boolean;
  /** The backend's own truncation sentence, verbatim, or null when nothing was clipped. */
  banner: string | null;
  /**
   * The tool's OWN loud-degradation sentence, verbatim, or null. Kept SEPARATE from
   * `banner`: a result can be whole but not sliced as asked (a dropped dimension member),
   * or sliced correctly but clipped — and a surface that merges them loses one.
   */
  warning: string | null;
  /** The note about this view's own cap, or null. Never merged with `banner`. */
  viewNote: ViewText | null;
  /** The honest label for where the number came from. */
  sourceLabel: ViewText;
  /** Long-form caveat for an ad-hoc answer, or null for a governed one. */
  sourceCaveat: ViewText | null;
  /** The tool's title verbatim, or a catalog fallback. */
  title: Shown;
  sql: string | null;
  semanticQuery: string | null;
  mode: string | null;
};

/**
 * Project a `table` artifact into what the drawer shows. The source label is the C6
 * requirement made visible: an ad-hoc SQL answer says so on the artifact itself, where a
 * reader cannot miss it, rather than relying on the model to have mentioned it in prose.
 */
export function tableView(a: TableArtifact, rowCap: number = VIEW_ROW_CAP): TableView {
  const rows = a.rows.slice(0, rowCap);
  const viewClipped = a.rows.length > rows.length;
  const adHoc = a.source === 'ad-hoc-sql';
  return {
    columns: a.columns,
    rows,
    rowCount: a.rowCount,
    viewClipped,
    banner: truncationBanner(a),
    warning: a.warning || null,
    viewNote: viewClipped ? viewText('artifacts.viewNote', { shown: rows.length, total: a.rows.length }) : null,
    sourceLabel: adHoc ? viewText('artifacts.sourceAdHoc') : viewText('artifacts.sourceGoverned'),
    sourceCaveat: adHoc ? viewText('artifacts.caveatAdHoc') : null,
    title: a.title || (adHoc ? viewText('artifacts.titleQuery') : viewText('artifacts.titleMetric')),
    sql: a.sql || null,
    semanticQuery: a.semanticQuery || null,
    mode: a.mode || null,
  };
}

/** The in-app route a citation chip links to, or null when the OS has no page for it. */
export function citationHref(c: CitationArtifact): string | null {
  if (c.of === 'dataset') return '/data';
  if (c.of === 'metric') return '/metrics';
  if (c.of === 'dashboard') return '/dashboards';
  return null;
}

/** The chip label: the governed name where there is one, else the raw id (English: "KPI: Revenue"). */
export function citationLabel(c: CitationArtifact): ViewText {
  const key = c.of === 'metric' ? 'artifacts.cite.metric' : c.of === 'dataset' ? 'artifacts.cite.dataset' : 'artifacts.cite.dashboard';
  return viewText(key, { name: c.name || c.id });
}

/**
 * The secondary line on a chip: tier and owner, when the governed record carried them. Its parts, in order
 * (tier and freshness verbatim, the owner as a sentence); the shell joins them with " · ".
 */
export function citationDetail(c: CitationArtifact): Shown[] | null {
  const bits: Shown[] = [];
  if (c.tier) bits.push(c.tier);
  if (c.owner) bits.push(viewText('artifacts.owner', { owner: c.owner }));
  if (c.freshness) bits.push(c.freshness);
  return bits.length > 0 ? bits : null;
}

/**
 * Collapse duplicate citations, keeping first-seen order and the richest copy of each.
 * Several tools in one turn cite the same dataset; the chip row should not repeat it.
 */
export function dedupeCitations(list: CitationArtifact[]): CitationArtifact[] {
  const byKey = new Map<string, CitationArtifact>();
  for (const c of list) {
    const key = `${c.of}:${c.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    // Prefer the entry that carries more governance detail — a bare citation from one tool
    // must not displace the named, tiered one another tool produced.
    const score = (x: CitationArtifact) => [x.name, x.tier, x.owner, x.freshness].filter(Boolean).length;
    if (score(c) > score(prev)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/** The artifacts this build renders, split from the ones whose renderers land later. */
export type SplitArtifacts = {
  tables: TableArtifact[];
  citations: CitationArtifact[];
  /** Declared kinds we do not yet render. Counted, never silently discarded. */
  deferred: ChatArtifact[];
};

/**
 * Split a turn's artifacts into what the drawer can render today and what it cannot. The
 * deferred list is surfaced as an honest count rather than dropped: "2 charts this build
 * does not render yet" is information; silence is a bug that looks like a design.
 */
export function splitArtifacts(list: ChatArtifact[]): SplitArtifacts {
  const tables: TableArtifact[] = [];
  const citations: CitationArtifact[] = [];
  const deferred: ChatArtifact[] = [];
  for (const a of list) {
    if (a.kind === 'table') tables.push(a);
    else if (a.kind === 'citation') citations.push(a);
    else deferred.push(a);
  }
  return { tables, citations: dedupeCitations(citations), deferred };
}

const DEFERRED_KIND_KEYS: Record<string, string> = {
  chart: 'artifacts.kinds.chart',
  metric_draft: 'artifacts.kinds.metricDraft',
  dashboard_draft: 'artifacts.kinds.dashboardDraft',
  clarification: 'artifacts.kinds.clarification',
  table: 'artifacts.kinds.table',
  citation: 'artifacts.kinds.citation',
};

/**
 * A one-line, plural-correct note for the kinds this build defers: one counted phrase per kind
 * (`parts`, joined with ", " by the shell into `{list}`) inside the sentence `artifacts.deferred`.
 */
export function deferredNote(deferred: ChatArtifact[]): { parts: ViewText[]; count: number } | null {
  if (deferred.length === 0) return null;
  const counts = new Map<string, number>();
  for (const a of deferred) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) =>
    Object.hasOwn(DEFERRED_KIND_KEYS, kind)
      ? viewText(DEFERRED_KIND_KEYS[kind], { count: n })
      : viewText('artifacts.kinds.other', { count: n, kind: kind.replace(/_/g, ' ') }));
  return { parts, count: deferred.length };
}
