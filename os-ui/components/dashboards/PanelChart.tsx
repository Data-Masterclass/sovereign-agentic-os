/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useRef } from 'react';
// Tree-shaken ECharts: register only the chart + renderer + components we use, so the
// dashboards bundle stays lean (Apache-2.0). A thin custom wrapper avoids echarts-for-react
// peer-dep friction with React 19.
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { type Panel, panelMetrics } from '@/lib/dashboards/model';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/** The leaf of a Cube member (`Sales.revenue` → `revenue`) for calm axis/label text. */
function leaf(member: string): string {
  const i = member.lastIndexOf('.');
  return i >= 0 ? member.slice(i + 1) : member;
}

/** A calm, compact number for KPIs (1.2M / 34.5k / 812). */
function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Read a themed CSS custom property (echarts needs concrete colors, not var()). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

type Row = Record<string, unknown>;

/** RFC-4180-ish CSV of the RENDERED rows — leaf-named headers, quoted/escaped fields.
 *  Exactly what the table shows (the governed, RLS-scoped result), nothing recomputed. */
function toCsv(cols: string[], rows: Row[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.map((c) => esc(leaf(c))).join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
  ].join('\n');
}

function downloadCsv(name: string, cols: string[], rows: Row[]) {
  const file = `${(name || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table'}.csv`;
  const blob = new Blob([toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.click();
  URL.revokeObjectURL(url);
}

/** The first dimension member present on the rows that isn't one of the measures. */
function dimOf(rows: Row[], measures: string[]): string | undefined {
  const first = rows[0] ?? {};
  return Object.keys(first).find((k) => !measures.includes(k));
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Build the ECharts option for a chart-shaped panel (line/area/bar/pie). Pure given the
 *  rows + theme colors — returns null for big_number/table (rendered as HTML instead). */
function chartOption(panel: Panel, rows: Row[], colors: { teal: string; gold: string; ink: string; line: string }): EChartsOption | null {
  const measures = panelMetrics(panel);
  const palette = [colors.teal, colors.gold, '#7c6cc4', '#c46c8a', '#6ca3c4'];
  const axisText = { color: colors.ink, fontSize: 11 };
  const splitLine = { lineStyle: { color: colors.line } };
  // A multi-measure legend gets ITS OWN top band (scroll, one line) and the plot grid
  // starts below it — the legend can never sit on top of the chart again.
  const legend = measures.length > 1
    ? ({ type: 'scroll', top: 0, itemGap: 12, textStyle: { color: colors.ink, fontSize: 11 } } as const)
    : undefined;
  const grid = { left: 8, right: 12, top: legend ? 34 : 24, bottom: 8, containLabel: true };

  if (panel.vizType === 'pie') {
    const dim = dimOf(rows, measures);
    const measure = measures[0];
    if (!dim || !measure) return null;
    return {
      tooltip: { trigger: 'item' },
      // ONE scrolling legend line at the bottom — many categories used to wrap over the pie.
      legend: { type: 'scroll', bottom: 0, itemGap: 10, textStyle: { color: colors.ink, fontSize: 11 } },
      color: palette,
      series: [{
        type: 'pie',
        // The pie sits above the legend band (center y 44%) so the two never collide.
        center: ['50%', '44%'],
        radius: ['36%', '60%'],
        itemStyle: { borderColor: cssVar('--panel', '#fff'), borderWidth: 2 },
        label: { color: colors.ink, fontSize: 11, overflow: 'truncate', width: 90 },
        labelLine: { length: 8, length2: 6 },
        // Colliding slice labels HIDE instead of overlapping (the tooltip still names them).
        labelLayout: { hideOverlap: true },
        data: rows.map((r) => ({ name: String(r[dim] ?? ''), value: num(r[measure]) })),
      }],
    };
  }

  if (panel.vizType === 'line' || panel.vizType === 'area') {
    const time = panel.timeDimension ?? dimOf(rows, measures);
    const cats = rows.map((r) => String((time && r[time]) ?? ''));
    return {
      tooltip: { trigger: 'axis' },
      legend,
      color: palette,
      grid,
      xAxis: {
        type: 'category',
        data: cats,
        axisLabel: { ...axisText, hideOverlap: true, width: 90, overflow: 'truncate' },
        axisLine: { lineStyle: { color: colors.line } },
      },
      yAxis: { type: 'value', axisLabel: axisText, splitLine },
      series: measures.map((m) => ({
        name: leaf(m),
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        areaStyle: panel.vizType === 'area' ? { opacity: 0.14 } : undefined,
        data: rows.map((r) => num(r[m])),
      })),
    };
  }

  // bar — grouped by the first dimension. Long/many category names rotate + truncate
  // instead of overlapping each other under the bars.
  const dim = dimOf(rows, measures);
  const cats = rows.map((r) => String((dim && r[dim]) ?? ''));
  return {
    tooltip: { trigger: 'axis' },
    legend,
    color: palette,
    grid,
    xAxis: {
      type: 'category',
      data: cats,
      axisLabel: { ...axisText, hideOverlap: true, rotate: cats.length > 6 ? 30 : 0, width: 100, overflow: 'truncate' },
      axisLine: { lineStyle: { color: colors.line } },
    },
    yAxis: { type: 'value', axisLabel: axisText, splitLine },
    series: measures.map((m) => ({
      name: leaf(m),
      type: 'bar',
      barMaxWidth: 42,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      data: rows.map((r) => num(r[m])),
    })),
  };
}

function EchartsCanvas({
  option,
  height,
  onPointClick,
}: {
  option: EChartsOption;
  height: number;
  /** Datapoint click (drill-down) — receives the clicked category name. */
  onPointClick?: (name: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    if (onPointClick) {
      chart.on('click', (params) => {
        const name = String((params as { name?: unknown }).name ?? '');
        if (name) onPointClick(name);
      });
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => { ro.disconnect(); chart.dispose(); };
  }, [option, onPointClick]);
  return <div ref={ref} style={{ width: '100%', height, cursor: onPointClick ? 'pointer' : undefined }} />;
}

/**
 * A single native dashboard panel, rendered with Apache ECharts (line/area/bar/pie) or a
 * calm HTML surface (big number KPI / table) on rows the caller already resolved from the
 * governed Cube layer (per-viewer RLS applied server-side). Degrades gracefully: a syncing
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
  const colors = useMemo(
    () => ({
      teal: cssVar('--teal', '#1f8f88'),
      gold: cssVar('--gold', '#c8a24a'),
      ink: cssVar('--text', '#2b2b2b'),
      line: cssVar('--border', 'rgba(0,0,0,0.08)'),
    }),
    [],
  );
  const measures = panelMetrics(panel);
  const isChart = panel.vizType === 'line' || panel.vizType === 'area' || panel.vizType === 'bar' || panel.vizType === 'pie';
  const option = useMemo(
    () => (isChart ? chartOption(panel, rows, colors) : null),
    [isChart, panel, rows, colors],
  );

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
    ? dimOf(rows, measures)
    : undefined;
  const pointDrill = onDrill && drillDim && drillDim !== panel.timeDimension
    ? (name: string) => onDrill({ member: drillDim, value: name })
    : undefined;
  return <EchartsCanvas option={option} height={height} onPointClick={pointDrill} />;
}
