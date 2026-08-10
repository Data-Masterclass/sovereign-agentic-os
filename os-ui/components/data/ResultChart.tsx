/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ResultChart /> — the inline, NEVER-SAVED chart for a Talk-to-Data answer.
 *
 * It renders ONLY the real rows the answer is grounded in (an `AskGrid`: `columns` +
 * `rows: string[][]`), using the pure {@link ChartHint} the server already computed. A
 * Bar · Line · Pie · Table toggle switches the view; nothing is re-queried, re-aggregated,
 * interpolated, or invented — the SQL did all the aggregation and RLS/DLS ran server-side.
 *
 * Honesty on screen:
 *   • Blank / non-numeric cells are SKIPPED (`connectNulls`), never plotted as 0.
 *   • When the plotted rows are a capped subset, the caption says "first N of M rows".
 *
 * ECharts is tree-shaken (only the charts + components we use are registered) to match the
 * dashboards bundle discipline — a thin canvas wrapper avoids echarts-for-react friction
 * with React 19. This is the minimal shared leaf: `PanelChart` stays coupled to Cube panels
 * (metrics, drill-downs, big-number KPIs), while this one is a plain `{columns, rows}` view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { parseNumber, type ChartHint, type ChartType } from '@/lib/data/ask-chart';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

/** Read a themed CSS custom property (echarts needs concrete colors, not `var()`). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

type Colors = { gold: string; teal: string; ink: string; line: string; panel: string };

/** Build the ECharts option for the chosen chart type over the plotted rows. Pure given
 *  the rows + hint + theme colors. Non-numeric/blank cells become `null` (a gap). */
function buildOption(
  type: Exclude<ChartType, 'table'>,
  columns: string[],
  rows: string[][],
  hint: ChartHint,
  colors: Colors,
): EChartsOption {
  const palette = [colors.gold, colors.teal, '#7c6cc4', '#c46c8a', '#6ca3c4', '#b58b3a'];
  const axisText = { color: colors.ink, fontSize: 11 };
  const splitLine = { lineStyle: { color: colors.line } };
  const cats = rows.map((r) => String(r[hint.dimension] ?? ''));
  const seriesNames = hint.measures.map((m) => columns[m]);
  const legend =
    hint.measures.length > 1
      ? ({ type: 'scroll', top: 0, itemGap: 12, textStyle: { color: colors.ink, fontSize: 11 } } as const)
      : undefined;
  const grid = { left: 8, right: 12, top: legend ? 34 : 16, bottom: 8, containLabel: true };

  if (type === 'pie') {
    // Pie is only offered for a single measure (the heuristic guarantees it).
    const m = hint.measures[0];
    return {
      tooltip: { trigger: 'item' },
      legend: { type: 'scroll', bottom: 0, itemGap: 10, textStyle: { color: colors.ink, fontSize: 11 } },
      color: palette,
      series: [
        {
          type: 'pie',
          center: ['50%', '44%'],
          radius: ['36%', '60%'],
          itemStyle: { borderColor: colors.panel, borderWidth: 2 },
          label: { color: colors.ink, fontSize: 11, overflow: 'truncate', width: 90 },
          labelLine: { length: 8, length2: 6 },
          labelLayout: { hideOverlap: true },
          // Honest: rows whose measure cell is blank/non-numeric are dropped (a slice
          // needs a value), not shown as a zero wedge.
          data: rows
            .map((r) => ({ name: String(r[hint.dimension] ?? ''), value: parseNumber(r[m]) }))
            .filter((d): d is { name: string; value: number } => d.value !== null),
        },
      ],
    };
  }

  const isLine = type === 'line';
  return {
    tooltip: { trigger: 'axis' },
    legend,
    color: palette,
    grid,
    xAxis: {
      type: 'category',
      data: cats,
      axisLabel: {
        ...axisText,
        hideOverlap: true,
        rotate: !isLine && cats.length > 6 ? 30 : 0,
        width: 100,
        overflow: 'truncate',
      },
      axisLine: { lineStyle: { color: colors.line } },
    },
    yAxis: { type: 'value', axisLabel: axisText, splitLine },
    series: hint.measures.map((m, i) => ({
      name: seriesNames[i],
      type: isLine ? 'line' : 'bar',
      ...(isLine
        ? { smooth: true, symbol: 'circle', symbolSize: 6, connectNulls: false }
        : { barMaxWidth: 42, itemStyle: { borderRadius: [4, 4, 0, 0] } }),
      // `null` for a blank/non-numeric cell → the point is skipped, never plotted as 0.
      data: rows.map((r) => parseNumber(r[m])),
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
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

const TOGGLE_LABEL: Record<ChartType, string> = { bar: 'Bar', line: 'Line', pie: 'Pie', table: 'Table' };

export default function ResultChart({
  columns,
  rows,
  hint,
  height = 260,
}: {
  columns: string[];
  rows: string[][];
  hint: ChartHint;
  height?: number;
}) {
  const [type, setType] = useState<ChartType>(hint.defaultType);
  const colors = useMemo<Colors>(
    () => ({
      gold: cssVar('--gold', '#c8a24a'),
      teal: cssVar('--teal', '#1f8f88'),
      ink: cssVar('--text', '#2b2b2b'),
      line: cssVar('--border', 'rgba(0,0,0,0.08)'),
      panel: cssVar('--panel', '#fff'),
    }),
    [],
  );
  // Plot ONLY the capped subset the hint chose (the same real rows the caption counts).
  const plotted = useMemo(() => rows.slice(0, hint.plottedRows), [rows, hint.plottedRows]);
  const option = useMemo(
    () => (type === 'table' ? null : buildOption(type, columns, plotted, hint, colors)),
    [type, columns, plotted, hint, colors],
  );
  const truncated = hint.plottedRows < hint.totalRows;

  return (
    <div className="result-chart">
      <div className="rc-head">
        <div className="rc-toggle" role="group" aria-label="Chart type">
          {hint.allowedTypes.map((t) => (
            <button
              key={t}
              type="button"
              className={`rc-btn${t === type ? ' is-active' : ''}`}
              aria-pressed={t === type}
              onClick={() => setType(t)}
            >
              {TOGGLE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="rc-caption">
          {truncated
            ? `Chart shows the first ${hint.plottedRows} of ${hint.totalRows} rows.`
            : `Chart of all ${hint.totalRows} rows.`}
        </div>
      </div>

      {option ? (
        <EchartsCanvas option={option} height={height} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: height, overflow: 'auto' }}>
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plotted.map((r, i) => (
                <tr key={i}>
                  {columns.map((c, ci) => (
                    <td key={c}>{r[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style jsx>{`
        .result-chart {
          margin-top: 14px;
          border: 1px solid var(--border);
          border-radius: var(--radius, 10px);
          padding: 12px 12px 8px;
          background: var(--tile, var(--panel));
        }
        .rc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        .rc-toggle {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          background: var(--bg-elevated, var(--panel));
          border: 1px solid var(--border);
          border-radius: 999px;
        }
        .rc-btn {
          font: inherit;
          font-size: 0.78rem;
          color: var(--text-muted);
          background: transparent;
          border: none;
          border-radius: 999px;
          padding: 4px 12px;
          cursor: pointer;
          transition: color 0.15s ease, background 0.15s ease;
        }
        .rc-btn:hover {
          color: var(--text);
        }
        .rc-btn.is-active {
          color: var(--gold-text, var(--text));
          background: var(--gold-soft);
          box-shadow: inset 0 0 0 1px var(--gold-line);
        }
        .rc-caption {
          font-size: 0.74rem;
          color: var(--text-faint, var(--text-muted));
        }
      `}</style>
    </div>
  );
}
