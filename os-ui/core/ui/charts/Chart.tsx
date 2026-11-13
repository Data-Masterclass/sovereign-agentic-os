/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `<Chart option />` — the one ECharts React wrapper in the OS
 * USER STORY: As a developer I want to mount a chart with one component that resizes, disposes and
 *             reports clicks the same way everywhere, so three tabs cannot each grow their own
 *             canvas lifecycle (D-R1.1, D1).
 * ARCHITECTURE:
 *   - A SHELL. No option building, no formatting, no theme reading — those are `spec.ts`,
 *     `format.ts` and `theme.ts`, which are `.ts` and therefore testable. This file holds only the
 *     imperative canvas lifecycle, which a unit test cannot see anyway.
 *   - Registration comes from `register.ts` (the single `echarts.use`). This component never
 *     registers a chart type of its own.
 *   - `ResizeObserver` + `dispose` on unmount: an undisposed ECharts instance keeps its canvas and
 *     its listeners, and a dashboard remounts its panels on every filter change.
 */
'use client';

import { useEffect, useRef } from 'react';
import { initChart } from '@core/ui/charts/register';

export default function Chart({
  option,
  height,
  onPointClick,
}: {
  /** A built option — from `buildChartOption` or a host's own builder. Structural by design. */
  option: Record<string, unknown>;
  height: number;
  /** Datapoint click (drill-down): receives the clicked category name. */
  onPointClick?: (name: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = initChart(node);
    chart.setOption(option);
    if (onPointClick) {
      chart.on('click', (params) => {
        const name = String((params as { name?: unknown }).name ?? '');
        if (name) onPointClick(name);
      });
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option, onPointClick]);
  return <div ref={ref} style={{ width: '100%', height, cursor: onPointClick ? 'pointer' : undefined }} />;
}
