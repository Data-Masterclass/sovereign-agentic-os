/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one entry point of the Monitoring panels — Agents · Data · Platform
 * USER STORY: As a user or an MCP client I want the same panel payload for the same identity,
 *             whichever door I come through.
 * ARCHITECTURE: server-only; `monitoringPanels(user, view)` is called by
 *   `app/api/monitoring/panels/route.ts` and the `get_monitoring_panels` MCP tool.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { agentsView, type AgentsView } from '@tabs/monitoring/lib/panels/agents-panel';
import { dataView, type DataView } from '@tabs/monitoring/lib/panels/data-panel';
import { platformView, type PlatformView } from '@tabs/monitoring/lib/panels/platform-panel';

export const PANEL_VIEWS = ['agents', 'data', 'platform'] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];
export const isPanelView = (v: unknown): v is PanelView => typeof v === 'string' && (PANEL_VIEWS as readonly string[]).includes(v);

export type { AgentsView, DataView, PlatformView };
export { PlatformForbiddenError } from '@tabs/monitoring/lib/panels/platform-panel';

export function monitoringPanels(user: CurrentUser, view: PanelView): Promise<AgentsView | DataView | PlatformView> {
  if (view === 'agents') return agentsView(user);
  if (view === 'data') return dataView(user);
  return platformView(user);
}
