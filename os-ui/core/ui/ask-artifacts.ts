/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { truncationBanner, type ChatArtifact, type CitationArtifact, type TableArtifact } from '@core/runtime/chat-artifacts';

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
  /** The note about this view's own cap, or null. Never merged with `banner`. */
  viewNote: string | null;
  /** The honest label for where the number came from. */
  sourceLabel: string;
  /** Long-form caveat for an ad-hoc answer, or null for a governed one. */
  sourceCaveat: string | null;
  title: string;
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
    viewNote: viewClipped
      ? `Showing the first ${rows.length} of the ${a.rows.length} rows returned (this view's own limit).`
      : null,
    sourceLabel: adHoc ? 'Ad hoc SQL — unverified' : 'Governed metric — semantic layer',
    sourceCaveat: adHoc
      ? 'This number came from a query written for this question, not from a governed metric definition. The aggregation and the joins were not reviewed by anyone.'
      : null,
    title: a.title || (adHoc ? 'Query result' : 'Metric result'),
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

/** The chip label: the governed name where there is one, else the raw id. */
export function citationLabel(c: CitationArtifact): string {
  const what = c.of === 'metric' ? 'KPI' : c.of === 'dataset' ? 'Data product' : 'Dashboard';
  return `${what}: ${c.name || c.id}`;
}

/** The secondary line on a chip: tier and owner, when the governed record carried them. */
export function citationDetail(c: CitationArtifact): string | null {
  const bits = [c.tier, c.owner ? `owner ${c.owner}` : '', c.freshness].filter((b): b is string => !!b);
  return bits.length > 0 ? bits.join(' · ') : null;
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

/** A one-line, plural-correct note for the kinds this build defers. */
export function deferredNote(deferred: ChatArtifact[]): string | null {
  if (deferred.length === 0) return null;
  const counts = new Map<string, number>();
  for (const a of deferred) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}${n === 1 ? '' : 's'}`);
  return `${parts.join(', ')} — this build does not render ${deferred.length === 1 ? 'it' : 'them'} yet.`;
}
