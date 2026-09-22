/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect } from 'react';
import type { EmbedMode, Panel } from './shared';
import PanelChart from './PanelChart';

/** A panel viz that draws a graph (as opposed to a KPI or a table) — the expanded view
 *  puts the supporting data table BELOW a graph, but never under a table (that would be
 *  two identical tables) or a KPI (a single scalar has no rows worth tabulating). */
export function isGraphViz(vizType: Panel['vizType']): boolean {
  return vizType === 'line' || vizType === 'area' || vizType === 'bar' || vizType === 'pie';
}

/**
 * PanelExpand — a panel opened into a near-full-viewport view. It reuses the rows the tile
 * ALREADY fetched (same governed, RLS-scoped slice, same active cross-filters) rather than
 * re-querying: the host passes `panel` + `rows` straight down. A graph fills the width with
 * generous height; below it, the same rows appear as a data table (with the panel's ⬇ CSV).
 * When the panel IS a table, only the large table shows — never two tables. Dark scrim,
 * Esc / ✕ / scrim-click all close.
 */
export default function PanelExpand({
  panel,
  rows,
  pending,
  warning,
  mode,
  onClose,
}: {
  panel: Panel;
  rows: Record<string, unknown>[];
  pending?: boolean;
  warning?: string;
  /** The panel's resolved live/mock mode — the same honesty badge the tile carries. */
  mode?: EmbedMode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const graph = isGraphViz(panel.vizType);

  return (
    <div className="panel-expand-backdrop" onClick={onClose} role="presentation">
      <div
        className="panel-expand"
        role="dialog"
        aria-modal="true"
        aria-label={`${panel.name} — expanded`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-expand-head">
          <div className="row" style={{ alignItems: 'center', gap: 10, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{panel.name}</h3>
            {mode ? <span className={`badge ${mode === 'live' ? 'ok' : 'muted'}`}>{mode}</span> : null}
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close expanded view">✕ Close</button>
        </div>

        <div className="panel-expand-body">
          {/* The panel rendered LARGE — the same viz on the same rows. A graph gets a
              generous height; a table/KPI shows once at a comfortable size. */}
          <PanelChart
            panel={panel}
            rows={rows}
            pending={pending}
            warning={warning}
            height={graph ? Math.round(typeof window !== 'undefined' ? window.innerHeight * 0.5 : 440) : 360}
          />

          {/* BELOW a graph: the same rows as a data table (with the ⬇ CSV button). Never
              shown for a table (avoids a duplicate) or a KPI (no rows to tabulate). */}
          {graph && !warning && !pending && rows.length > 0 ? (
            <div className="panel-expand-table">
              <PanelChart panel={{ ...panel, vizType: 'table' }} rows={rows} height={320} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
