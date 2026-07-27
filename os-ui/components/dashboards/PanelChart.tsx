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
  const grid = { left: 8, right: 12, top: 24, bottom: 8, containLabel: true };
  const axisText = { color: colors.ink, fontSize: 11 };
  const splitLine = { lineStyle: { color: colors.line } };

  if (panel.vizType === 'pie') {
    const dim = dimOf(rows, measures);
    const measure = measures[0];
    if (!dim || !measure) return null;
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: colors.ink } },
      color: palette,
      series: [{
        type: 'pie',
        radius: ['42%', '68%'],
        itemStyle: { borderColor: cssVar('--panel', '#fff'), borderWidth: 2 },
        label: { color: colors.ink },
        data: rows.map((r) => ({ name: String(r[dim] ?? ''), value: num(r[measure]) })),
      }],
    };
  }

  if (panel.vizType === 'line' || panel.vizType === 'area') {
    const time = panel.timeDimension ?? dimOf(rows, measures);
    const cats = rows.map((r) => String((time && r[time]) ?? ''));
    return {
      tooltip: { trigger: 'axis' },
      legend: measures.length > 1 ? { top: 0, textStyle: { color: colors.ink } } : undefined,
      color: palette,
      grid,
      xAxis: { type: 'category', data: cats, axisLabel: axisText, axisLine: { lineStyle: { color: colors.line } } },
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

  // bar — grouped by the first dimension.
  const dim = dimOf(rows, measures);
  const cats = rows.map((r) => String((dim && r[dim]) ?? ''));
  return {
    tooltip: { trigger: 'axis' },
    legend: measures.length > 1 ? { top: 0, textStyle: { color: colors.ink } } : undefined,
    color: palette,
    grid,
    xAxis: { type: 'category', data: cats, axisLabel: axisText, axisLine: { lineStyle: { color: colors.line } } },
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

function EchartsCanvas({ option, height }: { option: EChartsOption; height: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => { ro.disconnect(); chart.dispose(); };
  }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

/**
 * A single native dashboard panel, rendered with Apache ECharts (line/area/bar/pie) or a
 * calm HTML surface (big number KPI / table) on rows the caller already resolved from the
 * governed Cube layer (per-viewer RLS applied server-side). Degrades gracefully: a syncing
 * panel shows "syncing…", an empty result shows a quiet "no rows", never a hard error.
 */
export default function PanelChart({
  panel,
  rows,
  pending,
  warning,
  height = 240,
}: {
  panel: Panel;
  rows: Record<string, unknown>[];
  pending?: boolean;
  /** LOUD degradation notice (Northpeak fix): a requested member isn't in the served
   *  model — rendered as an inline warning, never a silently de-dimensioned chart. */
  warning?: string;
  height?: number;
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
  if (panel.vizType === 'big_number' || panel.vizType === 'big_number_total') {
    const measure = measures[0];
    const total = rows.reduce((s, r) => s + num(r[measure]), 0);
    return (
      <div className="panel-kpi" style={{ height }}>
        <div className="panel-kpi-value">{fmtCompact(total)}</div>
        <div className="panel-kpi-label">{measure ? leaf(measure) : ''}</div>
      </div>
    );
  }

  // table — a plain, calm result table (reuses the metrics explorer table styling).
  if (panel.vizType === 'table') {
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    return (
      <div className="table-wrap" style={{ maxHeight: height, overflow: 'auto' }}>
        <table>
          <thead><tr>{cols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!option) {
    return <div className="panel-state" style={{ height }}><span className="hint">Pick a dimension to chart this panel.</span></div>;
  }
  return <EchartsCanvas option={option} height={height} />;
}
