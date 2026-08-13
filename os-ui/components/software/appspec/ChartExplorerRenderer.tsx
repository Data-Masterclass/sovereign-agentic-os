/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
// Tree-shaken ECharts (same registration surface the dashboards use — no new dependency).
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { Alert, Select, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import type { ChartExplorerConfig } from '@/lib/software/appspec/patterns.ts';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/** The leaf of a Cube member (`Orders.revenue` → `revenue`) for calm axis/label text. */
function leaf(member: string): string {
  const i = member.lastIndexOf('.');
  return i >= 0 ? member.slice(i + 1) : member;
}

/** Read a themed CSS custom property (echarts needs concrete colors, not var()). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function EchartsCanvas({ option, height }: { option: EChartsOption; height: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

/**
 * Render the `chart-explorer` pattern: query a GOVERNED metric via `os.metrics.query` (per-viewer
 * Cube RLS applies server-side) and chart it with ECharts. Simple controls let the viewer swap the
 * time grain (when a time dimension is configured) between the config default and a few common
 * grains; the chart kind (line/bar/area) is the author's. The measure is the metric's leaf; the
 * category axis is the configured time/dimension column. Honest states: loading → Spinner, error →
 * Alert(error), no rows → Alert(info). Never a fabricated point.
 */
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;

export function ChartExplorerRenderer({ view, os }: { view: ChartExplorerConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });
  const [grain, setGrain] = useState<string>(view.granularity ?? 'month');

  const measure = leaf(view.metric.metricId);
  // The category axis column: the configured time dimension, else the first configured dimension.
  const categoryMember = view.timeDimension ?? view.dimensions?.[0];

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    os.metrics
      .query(view.metric.metricId, {
        ...(view.dimensions ? { dimensions: view.dimensions } : {}),
        ...(view.timeDimension ? { timeDimension: view.timeDimension, granularity: grain } : {}),
      })
      .then((result) => {
        if (alive) setState({ status: 'ready', result });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [os, view.metric.metricId, view.dimensions, view.timeDimension, grain]);

  const colors = useMemo(
    () => ({
      teal: cssVar('--sb-teal', '#1f8f88'),
      gold: cssVar('--sb-gold', '#c8a24a'),
      ink: cssVar('--sb-text', '#2b2b2b'),
      line: cssVar('--sb-border', 'rgba(0,0,0,0.08)'),
    }),
    [],
  );

  const option: EChartsOption | null = useMemo(() => {
    const result = state.result;
    if (!result) return null;
    // Resolve the measure + category columns BY NAME against the metric grid's members.
    const measureIdx = result.columns.findIndex((c) => leaf(c) === measure);
    const catIdx = categoryMember
      ? result.columns.findIndex((c) => c === categoryMember || leaf(c) === leaf(categoryMember))
      : result.columns.findIndex((c) => leaf(c) !== measure);
    if (measureIdx < 0) return null;

    const cats = result.rows.map((r) => (catIdx >= 0 ? r[catIdx] ?? '' : ''));
    const vals = result.rows.map((r) => num(r[measureIdx] ?? ''));
    const axisText = { color: colors.ink, fontSize: 11 };
    const isArea = view.chart === 'area';
    const type = view.chart === 'bar' ? 'bar' : 'line';
    return {
      tooltip: { trigger: 'axis' },
      color: [colors.teal, colors.gold],
      grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: cats,
        axisLabel: { ...axisText, hideOverlap: true, rotate: cats.length > 8 ? 30 : 0, width: 100, overflow: 'truncate' },
        axisLine: { lineStyle: { color: colors.line } },
      },
      yAxis: { type: 'value', axisLabel: axisText, splitLine: { lineStyle: { color: colors.line } } },
      series: [
        {
          name: measure,
          type,
          smooth: type === 'line',
          symbol: 'circle',
          symbolSize: 6,
          barMaxWidth: 42,
          itemStyle: type === 'bar' ? { borderRadius: [4, 4, 0, 0] } : undefined,
          areaStyle: isArea ? { opacity: 0.14 } : undefined,
          data: vals,
        },
      ],
    };
  }, [state.result, measure, categoryMember, view.chart, colors]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') return <Alert variant="error">Could not load this chart: {state.error}</Alert>;
  if (!state.result || state.result.rows.length === 0) return <Alert variant="info">No data for this metric.</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {view.timeDimension && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ color: 'var(--sb-text-muted)' }}>Grain</span>
          <Select value={grain} onChange={(e) => setGrain(e.target.value)} aria-label="Time grain" style={{ maxWidth: 160 }}>
            {GRAINS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </div>
      )}
      {option ? (
        <EchartsCanvas option={option} height={300} />
      ) : (
        <Alert variant="info">The metric “{measure}” is not in the served result.</Alert>
      )}
    </div>
  );
}
