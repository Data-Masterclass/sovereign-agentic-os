/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The DASHBOARDS guided path as a shared-core staged model — Define · Design · Build ·
 * View · Govern. Pure and framework-free (mirrors the Agents `PHASES` array) so the
 * gating and ✓ rules are unit-testable on their own; the React skin is
 * components/dashboards/DashboardBuilder.tsx, riding components/core/StageShell.tsx.
 *
 * `enabled(ctx)` gates which stages are reachable — you can't Build without ≥1 chart,
 * can't View/Govern without a successful build, can't Govern a dashboard that was never
 * persisted. `completed(ctx)` is each stage's LIVE condition; a stage shows a ✓ only when
 * the user ALSO worked it this session (tracked by the StageState in the component). So a
 * freshly-opened dashboard shows no pre-marked checks, and a check clears if the user
 * later invalidates it (e.g. removes every chart).
 */

import type { StageDef } from '@/lib/core/stages';

export type DashStageId = 'define' | 'design' | 'build' | 'view' | 'govern';

/** The live state the dashboard stage gates/✓-conditions read — derived fresh each render. */
export type DashCtx = {
  /** Name given AND a Cube view chosen (charts all bind to one view). */
  defined: boolean;
  /** At least one chart tile, all from a single Cube view (the build guard). */
  hasCharts: boolean;
  /** The apply/verify build ran and every adapter row is ok. */
  builtOk: boolean;
  /** The embed is live in the browser, OR the viewer explicitly acknowledged offline. */
  viewed: boolean;
  /** The dashboard exists as a persisted, governable record (built at least once). */
  persisted: boolean;
};

/**
 * The five stages. Design needs a definition; Build needs charts; View/Govern need a
 * successful build. Govern additionally requires a persisted record so we never offer
 * promote/certify on a spec that was never saved.
 */
export const DASH_STAGES: StageDef<DashStageId, DashCtx>[] = [
  { id: 'define', title: 'Define', hint: 'Name it and pick the governed Cube view it reads.', completed: (c) => c.defined },
  { id: 'design', title: 'Design', hint: 'Add chart tiles on that view — big numbers, trends, tables.', enabled: (c) => c.defined, completed: (c) => c.hasCharts },
  { id: 'build', title: 'Build', hint: 'Apply and verify — Superset, embed, reports and alerts.', enabled: (c) => c.defined && c.hasCharts, completed: (c) => c.builtOk },
  { id: 'view', title: 'View', hint: 'Open it under your own row-level security; switch “View as” to compare.', enabled: (c) => c.builtOk, completed: (c) => c.viewed },
  { id: 'govern', title: 'Govern', hint: 'Schedule reports, promote or certify, archive or version.', enabled: (c) => c.builtOk && c.persisted, completed: (c) => c.persisted },
];
