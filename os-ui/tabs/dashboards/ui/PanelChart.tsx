/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo } from 'react';
// The OS's ONE chart surface: a single ECharts registration, one theme bridge, one formatter
// module, one canvas shell and one pure spec→option builder (@core/ui/charts). This component
// registers nothing and formats nothing of its own — D1's whole point.
import Chart from '@core/ui/charts/Chart';
import { buildChartOption } from '@core/ui/charts/spec';
import { chartColors } from '@core/ui/charts/theme';
import { fileSlug, fmtCompact, leaf, num, toCsv } from '@core/ui/charts/format';
import { type Panel, panelMetrics } from '@tabs/dashboards/lib/model';
import { dimensionOf, isChartPanel, panelChartSpec } from '@tabs/dashboards/lib/chart-spec';

type Row = Record<string, unknown>;

/** Download the RENDERED rows (the governed, RLS-scoped result) as CSV — never a re-query. */
function downloadCsv(name: string, cols: string[], rows: Row[]) {
  const blob = new Blob([toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileSlug(name, 'table')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * A single native dashboard panel, rendered with Apache ECharts (line/area/bar/pie) or a
 * calm HTML surface (big number KPI / table) on rows the caller already resolved from the
 * governed metric layer (per-viewer RLS applied server-side). Degrades gracefully: a syncing
 * panel shows "syncing…", an empty result shows a quiet "no rows", never a hard error.
 */
/** The drill request a click produces: a category filter (`region = DE`), or `null` for
 *  an unfiltered breakdown (clicking a KPI number → "break this total down by …"). */
export type DrillRequest = { member: string; value: string } | null;

export default function PanelChart({
  panel,
  rows,
  pending,
  warning,
  height = 240,
  onDrill,
}: {
  panel: Panel;
  rows: Record<string, unknown>[];
  pending?: boolean;
  /** LOUD degradation notice (Northpeak fix): a requested member isn't in the served
   *  model — rendered as an inline warning, never a silently de-dimensioned chart. */
  warning?: string;
  height?: number;
  /** When set, datapoints become clickable: a bar/slice/table-row click drills into that
   *  category; a KPI click asks for an unfiltered breakdown. Absent = static chart. */
  onDrill?: (drill: DrillRequest) => void;
}) {
  const colors = useMemo(() => chartColors(), []);
  const measures = panelMetrics(panel);
  const isChart = isChartPanel(panel);
  const option = useMemo(() => {
    const spec = panelChartSpec(panel, rows, height);
    return spec ? buildChartOption(spec, colors) : null;
  }, [panel, rows, height, colors]);

  // Honest inline WARNING first (Northpeak fix): the panel's group-by/measure is not in
  // the served model. Louder than the quiet states below — silent single-bar is the bug.
  if (warning) {
    return (
      <div className="panel-state" style={{ height, padding: 12, textAlign: 'center' }}>
        <span className="error" role="alert">⚠ {warning}</span>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="panel-state" style={{ height }}>
        <span className="spin" /> <span className="hint" style={{ marginLeft: 8 }}>syncing…</span>
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="panel-state" style={{ height }}><span className="hint">No rows for this viewer.</span></div>;
  }

  // big number KPI — sum the first measure across the returned rows (a scalar total).
  // With a drill handler, clicking the number asks for its breakdown.
  if (panel.vizType === 'big_number' || panel.vizType === 'big_number_total') {
    const measure = measures[0];
    const total = rows.reduce((s, r) => s + num(r[measure]), 0);
    return (
      <div
        className="panel-kpi"
        style={{ height, cursor: onDrill ? 'pointer' : undefined }}
        onClick={onDrill ? () => onDrill(null) : undefined}
        title={onDrill ? 'Click to break this number down' : undefined}
        role={onDrill ? 'button' : undefined}
      >
        <div className="panel-kpi-value">{fmtCompact(total)}</div>
        <div className="panel-kpi-label">{measure ? leaf(measure) : ''}</div>
      </div>
    );
  }

  // table — a plain, calm result table (reuses the metrics explorer table styling).
  // A row click drills into that row's first dimension value.
  if (panel.vizType === 'table') {
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const dimCol = cols.find((c) => !measures.includes(c) && c !== panel.timeDimension);
    const rowDrill = onDrill && dimCol
      ? (r: Record<string, unknown>) => onDrill({ member: dimCol, value: String(r[dimCol] ?? '') })
      : undefined;
    return (
      <div>
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 4 }}>
          <button
            className="btn ghost sm"
            onClick={() => downloadCsv(panel.name, cols, rows)}
            title="Download these rows (your governed, row-level-secured result) as CSV"
          >⬇ CSV</button>
        </div>
        <div className="table-wrap" style={{ maxHeight: height, overflow: 'auto' }}>
          <table>
            <thead><tr>{cols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onClick={rowDrill ? () => rowDrill(r) : undefined}
                  style={rowDrill ? { cursor: 'pointer' } : undefined}
                  title={rowDrill ? 'Click to drill into this row' : undefined}
                >
                  {cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (!option) {
    return <div className="panel-state" style={{ height }}><span className="hint">Pick a dimension to chart this panel.</span></div>;
  }
  // Category drill: a bar/slice click narrows to that category. Only a PLAIN dimension
  // drills (a time bucket's rendered label can't faithfully filter the raw column).
  const drillDim = (panel.vizType === 'bar' || panel.vizType === 'pie')
    ? dimensionOf(rows, measures)
    : undefined;
  const pointDrill = onDrill && drillDim && drillDim !== panel.timeDimension
    ? (name: string) => onDrill({ member: drillDim, value: name })
    : undefined;
  return <Chart option={option as unknown as Record<string, unknown>} height={height} onPointClick={pointDrill} />;
}
