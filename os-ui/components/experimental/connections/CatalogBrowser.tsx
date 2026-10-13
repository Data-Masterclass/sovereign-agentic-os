/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <CatalogBrowser /> — the ONE shared catalog-browse surface for the lakehouse experience
 * (lakehouse-expose-experience.md). Expose mounts it in Catalog + Organize; the Data-tab
 * adopt browser will mount it over exposed-only tables with `readOnlyCategories` (Phase D).
 * Purely presentational + controlled: the parent owns the selection Set and hands it in;
 * every toggle calls `onSelection(next)` with a fresh Set.
 *
 * Two grouping modes over the SAME ≤ ~1k rows, with instant client-side search:
 *   • 'schema'   — grouped by schema, tri-state schema checkbox + per-table checkbox. Fully
 *                  implemented here (Phase A).
 *   • 'category' — grouped by the AI taxonomy in `classification` (Phase B). In Phase A the
 *                  classification is absent, so it FALLS BACK to schema grouping with a quiet
 *                  "AI organization arrives with the next release" note — still fully selectable.
 *
 * Row click (NOT the checkbox) expands a table → a lazy governed `DESCRIBE` via
 * `GET /api/connections/[id]/describe` with honest loading/error states. An unreachable
 * catalog shows the real error inline — columns are NEVER fabricated.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { keyOf, groupState, toggleGroupSelection, type TableRef } from './catalog-selection';
import { buildFolders, filterTables, UNSORTED, type Placement } from './category-tree';

export { keyOf } from './catalog-selection';
export type { TableRef } from './catalog-selection';
export type CatalogColumn = { name: string; type: string; comment?: string };

/** The AI taxonomy + per-table MERGED placement the browser reads in 'category' mode (Phase B). */
export type CatalogClassification = {
  taxonomy: { id: string; name: string }[];
  /** `schema.table` → its merged placement (override ?? AI ?? Unsorted). */
  placements: Record<string, Placement>;
  /** The honest last-run summary, shown once above the tree ("132 classified, 12 unsorted…"). */
  lastRunDetail?: string;
};

export type CatalogBrowserProps = {
  /** The connection whose columns the lazy DESCRIBE reads (load-bearing for expand). */
  connectionId: string;
  /** Every catalog row, already fetched (the snapshot's tables, or exposed-only for adopt). */
  tables: TableRef[];
  /** The AI taxonomy/placement (Phase B). Absent → 'category' mode falls back to schema. */
  classification?: CatalogClassification;
  /** The parent-owned selection of `schema.table` keys. */
  selection: ReadonlySet<string>;
  /** Called with a fresh Set on every toggle — the parent is the single owner. */
  onSelection: (next: Set<string>) => void;
  /** Which grouping to render. */
  mode: 'schema' | 'category';
  /** The instant client-side search term (matches schema, table, and category names). */
  search: string;
  /** Optional per-row trailing content (e.g. an "AI" chip, a drift flag). */
  renderRowExtras?: (t: TableRef) => ReactNode;
  /** Adopt-side: categories are read-only labels (no folder checkboxes drive selection). */
  readOnlyCategories?: boolean;
  /** Move a table (per-row) into a folder — enables the "⋯ → Move to ▸" affordance (Phase B). */
  onMove?: (fqn: string, category: string) => void;
  /** Developer view — show confidence values + model id + raw why on AI placements. */
  developer?: boolean;
};

type Group = { key: string; label: string; note?: string; tables: TableRef[] };

export default function CatalogBrowser({
  connectionId,
  tables,
  classification,
  selection,
  onSelection,
  mode,
  search,
  renderRowExtras,
  readOnlyCategories = false,
  onMove,
  developer = false,
}: CatalogBrowserProps) {
  // Category mode needs a real classification; without one we quietly fall back to schema.
  const useCategory = mode === 'category' && !!classification;

  const toggleTable = useCallback(
    (t: TableRef) => {
      const k = keyOf(t);
      const next = new Set(selection);
      if (next.has(k)) next.delete(k); else next.add(k);
      onSelection(next);
    },
    [selection, onSelection],
  );

  const toggleGroup = useCallback(
    (ts: TableRef[]) => onSelection(toggleGroupSelection(selection, ts)),
    [selection, onSelection],
  );

  if (useCategory && classification) {
    return (
      <CategoryTree
        connectionId={connectionId}
        tables={tables}
        classification={classification}
        selection={selection}
        onSelection={onSelection}
        toggleTable={toggleTable}
        toggleGroup={toggleGroup}
        search={search}
        renderRowExtras={renderRowExtras}
        readOnly={readOnlyCategories}
        onMove={onMove}
        developer={developer}
      />
    );
  }

  // ── Schema grouping (Phase A default, and the fallback for category-without-classification) ──
  const q = search.trim().toLowerCase();
  const filtered = q
    ? tables.filter((t) => t.table.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q))
    : tables;
  const bySchema = new Map<string, TableRef[]>();
  for (const t of filtered) {
    if (!bySchema.has(t.schema)) bySchema.set(t.schema, []);
    bySchema.get(t.schema)!.push(t);
  }
  const note =
    mode === 'category'
      ? 'Organize with AI to group these into folders — grouped by schema for now.'
      : undefined;
  const groups: Group[] = [...bySchema.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([schema, ts]) => ({ key: schema, label: schema, note, tables: ts }));

  return (
    <div>
      {note ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 6, fontSize: 11 }}>{note}</p>
      ) : null}
      <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
        {groups.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, padding: 8 }}>No tables match.</p>
        ) : (
          groups.map((g) => {
            const gs = groupState(selection, g.tables);
            return (
              <div key={g.key} style={{ marginBottom: 6 }}>
                <label className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={gs === 'all'}
                    ref={(el) => { if (el) el.indeterminate = gs === 'some'; }}
                    onChange={() => toggleGroup(g.tables)}
                  />
                  <span className="mono">{g.label}</span>
                  <span className="muted" style={{ fontWeight: 400 }}>({g.tables.length})</span>
                </label>
                <div style={{ paddingLeft: 20 }}>
                  {g.tables.map((t) => (
                    <TableRow
                      key={keyOf(t)}
                      connectionId={connectionId}
                      table={t}
                      checked={selection.has(keyOf(t))}
                      onToggle={() => toggleTable(t)}
                      extras={renderRowExtras?.(t)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── CategoryTree (category mode) ─────────────────────────── */

/**
 * The one folder level of the AI taxonomy: folders count-sorted with Unsorted last, tri-
 * state folder checkboxes feeding the shared selection Set, per-row Move + bulk Move, an
 * "AI" chip with hover-why on AI placements, and the honest "Organized by AI — suggested,
 * not verified" header. Adopt-side (`readOnly`) drops all move/checkbox affordances.
 */
function CategoryTree({
  connectionId, tables, classification, selection, onSelection, toggleTable, toggleGroup,
  search, renderRowExtras, readOnly, onMove, developer,
}: {
  connectionId: string;
  tables: TableRef[];
  classification: CatalogClassification;
  selection: ReadonlySet<string>;
  onSelection: (next: Set<string>) => void;
  toggleTable: (t: TableRef) => void;
  toggleGroup: (ts: TableRef[]) => void;
  search: string;
  renderRowExtras?: (t: TableRef) => ReactNode;
  readOnly: boolean;
  onMove?: (fqn: string, category: string) => void;
  developer: boolean;
}) {
  const { taxonomy, placements, lastRunDetail } = classification;
  const filtered = useMemo(
    () => filterTables(tables, search, taxonomy, placements),
    [tables, search, taxonomy, placements],
  );
  const folders = useMemo(
    () => buildFolders(filtered, taxonomy, placements),
    [filtered, taxonomy, placements],
  );

  // The other folders a table can move TO (for the per-row + bulk menus).
  const moveTargets = taxonomy;
  const selectedCount = selection.size;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
        <span className="hint" style={{ margin: 0, fontSize: 11 }}>Organized by AI — suggested, not verified.</span>
        {!readOnly && onMove && selectedCount > 0 ? (
          <MoveMenu
            label={`Move ${selectedCount} selected to`}
            targets={moveTargets}
            onPick={(cat) => {
              for (const fqn of selection) onMove(fqn, cat);
            }}
          />
        ) : null}
      </div>
      {lastRunDetail ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 6, fontSize: 11 }}>{lastRunDetail}</p>
      ) : null}

      <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
        {folders.every((f) => f.tables.length === 0) ? (
          <p className="muted" style={{ fontSize: 12, padding: 8 }}>No tables match.</p>
        ) : (
          folders.map((f) => {
            if (f.tables.length === 0 && search.trim()) return null; // hide empty folders while searching
            const gs = groupState(selection, f.tables);
            return (
              <div key={f.id} style={{ marginBottom: 6 }}>
                <label className="row" style={{ gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 12.5 }}>
                  {!readOnly ? (
                    <input
                      type="checkbox"
                      checked={gs === 'all' && f.tables.length > 0}
                      ref={(el) => { if (el) el.indeterminate = gs === 'some'; }}
                      onChange={() => toggleGroup(f.tables)}
                      disabled={f.tables.length === 0}
                    />
                  ) : null}
                  <span>{f.name}</span>
                  <span className="muted" style={{ fontWeight: 400 }}>({f.tables.length})</span>
                </label>
                <div style={{ paddingLeft: readOnly ? 6 : 20 }}>
                  {f.tables.map((t) => (
                    <TableRow
                      key={keyOf(t)}
                      connectionId={connectionId}
                      table={t}
                      checked={selection.has(keyOf(t))}
                      onToggle={() => toggleTable(t)}
                      hideCheckbox={readOnly}
                      extras={
                        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                          <PlacementChip placement={placements[keyOf(t)]} developer={developer} />
                          {renderRowExtras?.(t)}
                          {!readOnly && onMove ? (
                            <MoveMenu label="⋯" compact targets={moveTargets} onPick={(cat) => onMove(keyOf(t), cat)} />
                          ) : null}
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The "AI" chip (AI placement) with hover-why, or nothing for a human move / not-classified.
 *  Developer view appends the confidence + model id. A moved table shows no chip (human fact). */
function PlacementChip({ placement, developer }: { placement?: Placement; developer: boolean }) {
  if (!placement || placement.source !== 'ai') return null;
  const conf = typeof placement.confidence === 'number' ? Math.round(placement.confidence * 100) : null;
  const title = [placement.why, developer && placement.model ? `model: ${placement.model}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="badge muted" style={{ fontSize: 10 }} title={title || 'AI-suggested'}>
      AI{developer && conf !== null ? ` ${conf}%` : ''}
    </span>
  );
}

/** A tiny "Move to ▸" menu — a folder picker rendered as a native select for zero-dep a11y. */
function MoveMenu({
  label, targets, onPick, compact = false,
}: {
  label: string;
  targets: { id: string; name: string }[];
  onPick: (category: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn ghost"
        style={{ padding: compact ? '1px 6px' : '2px 8px', fontSize: compact ? 12 : 11.5 }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Move to a folder"
      >
        {label}{compact ? '' : ' ▸'}
      </button>
      {open ? (
        <span
          role="listbox"
          className="card"
          style={{ position: 'absolute', right: 0, top: '100%', zIndex: 5, minWidth: 160, padding: 4, maxHeight: 200, overflow: 'auto' }}
        >
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={false}
              className="link-quiet"
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '4px 8px', font: 'inherit', cursor: 'pointer', color: 'inherit' }}
              onClick={() => { onPick(t.id); setOpen(false); }}
            >
              {t.name}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** One table row: checkbox (selection) + a click-to-expand name that lazily DESCRIBEs. */
function TableRow({
  connectionId,
  table,
  checked,
  onToggle,
  extras,
  hideCheckbox = false,
}: {
  connectionId: string;
  table: TableRef;
  checked: boolean;
  onToggle: () => void;
  extras?: ReactNode;
  hideCheckbox?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState<CatalogColumn[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const expand = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || cols || loading) return;
    setLoading(true); setErr('');
    try {
      const res = await fetch(
        `/api/connections/${connectionId}/describe?schema=${encodeURIComponent(table.schema)}&table=${encodeURIComponent(table.table)}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr((data.error as string) ?? 'Could not read columns.'); return; }
      setCols((data.columns as CatalogColumn[]) ?? []);
    } catch (e) {
      setErr((e as Error).message || 'Could not reach the catalog.');
    } finally {
      setLoading(false);
    }
  }, [open, cols, loading, connectionId, table]);

  return (
    <div>
      <div className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12 }}>
        {!hideCheckbox ? (
          <input type="checkbox" checked={checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
        ) : null}
        <button
          type="button"
          onClick={expand}
          className="link-quiet"
          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', color: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
          aria-expanded={open}
        >
          <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▾' : '▸'}</span>
          <span className="mono">{table.table}</span>
        </button>
        {extras ? <span style={{ marginLeft: 'auto' }}>{extras}</span> : null}
      </div>
      {open ? (
        <div style={{ paddingLeft: 24, marginBottom: 4 }}>
          {loading ? (
            <span className="muted" style={{ fontSize: 11.5 }}><span className="spin" /> reading columns…</span>
          ) : err ? (
            <span className="error" style={{ fontSize: 11.5 }}>{err}</span>
          ) : cols && cols.length > 0 ? (
            <table style={{ fontSize: 11.5 }}>
              <tbody>
                {cols.map((c) => (
                  <tr key={c.name}>
                    <td className="mono" style={{ paddingRight: 10 }}>{c.name}</td>
                    <td className="muted mono" style={{ paddingRight: 10 }}>{c.type}</td>
                    {c.comment ? <td className="muted" style={{ fontStyle: 'italic' }}>{c.comment}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <span className="muted" style={{ fontSize: 11.5 }}>No columns reported.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
