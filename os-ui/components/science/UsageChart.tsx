/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { usageToSeries, bandLabel } from '@/lib/science/ui-format';
import type { ModelUsage } from './shared';

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

/**
 * A minimal, honest score-distribution chart for a model's REAL usage — the count of allowed
 * scored predictions per score band (deciles for classification, coarse value bands otherwise),
 * summed across the days seen. It follows the OS's own thin ECharts wrapper pattern
 * (components/dashboards/PanelChart's EchartsCanvas — tree-shaken core + a ResizeObserver) rather
 * than a heavyweight panel. When nothing has been scored the caller renders an empty state and
 * never mounts this — there is no fabricated distribution.
 */
export default function UsageChart({ usage, height = 200 }: { usage: ModelUsage; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { bands, totalsByBand } = usageToSeries(usage);
  const kind = usage.bandKind;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: 'canvas' });
    const gold = getVar(node, '--gold', '#c8a24a');
    const grid = getVar(node, '--border', 'rgba(0,0,0,0.1)');
    const text = getVar(node, '--text-muted', '#888');
    const option: EChartsOption = {
      grid: { left: 8, right: 12, top: 12, bottom: 24, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: bands.map((b) => bandLabel(kind, b)),
        axisLabel: { color: text, fontSize: 10 },
        axisLine: { lineStyle: { color: grid } },
        name: kind === 'decile' ? 'score band' : 'value band',
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: { color: text, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: text, fontSize: 10 },
        splitLine: { lineStyle: { color: grid } },
      },
      series: [{ type: 'bar', data: totalsByBand, itemStyle: { color: gold, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 34 }],
    };
    chart.setOption(option);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => { ro.disconnect(); chart.dispose(); };
  }, [bands, totalsByBand, kind]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

/** Read a CSS custom property off the node (falls back to a sane default for the canvas). */
function getVar(node: Element, name: string, fallback: string): string {
  const v = getComputedStyle(node).getPropertyValue(name).trim();
  return v || fallback;
}
