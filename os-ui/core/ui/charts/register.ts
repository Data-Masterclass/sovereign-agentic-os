/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS's ONE Apache-ECharts registration surface
 * USER STORY: As a developer I want to add a chart anywhere in the OS and have it look, format and
 *             behave identically, so a number never renders two ways in two tabs (D-R1.1, D1).
 * ARCHITECTURE:
 *   - The ONLY module in os-ui that may `import … from 'echarts…'`. A ratchet test
 *     (`echarts-surface.test.ts`) greps the whole tree and fails on a second registration — three
 *     independent `echarts.use([…])` call sites is how a chart becomes inconsistent in two places
 *     at once (plan D7).
 *   - Tree-shaken on purpose: exactly the charts, components and renderer the OS actually draws
 *     (line, bar, pie · grid, tooltip, legend · canvas). Adding a viz type means adding its
 *     registration HERE and nowhere else.
 *   - A thin `initChart` wrapper (rather than `echarts-for-react`) keeps the React-19 peer-dep
 *     friction out of the tree; the React component is `Chart.tsx`, which is a shell over this.
 *   - Client-side only: ECharts measures DOM. Never import this from a server module or a test —
 *     `theme.ts`, `format.ts` and `spec.ts` hold the pure parts, and those are what tests exercise.
 */
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export type { EChartsOption };

/** The initialised chart handle (ECharts' own instance type, without naming its module twice). */
export type ChartInstance = ReturnType<typeof echarts.init>;

/** Initialise a canvas chart on `node`. The ONE place `echarts.init` is called. */
export function initChart(node: HTMLElement): ChartInstance {
  return echarts.init(node, undefined, { renderer: 'canvas' });
}
