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
import { filesView, type FilesView } from '@tabs/monitoring/lib/panels/files-panel';
import { knowledgeView, type KnowledgeView } from '@tabs/monitoring/lib/panels/knowledge-panel';
import { kpisView, type KpisView } from '@tabs/monitoring/lib/panels/kpis-panel';
import { dashboardsView, type DashboardsView } from '@tabs/monitoring/lib/panels/dashboards-panel';
import { softwareView, type SoftwareView } from '@tabs/monitoring/lib/panels/software-panel';
import { workflowsView, type WorkflowsView } from '@tabs/monitoring/lib/panels/workflows-panel';

export const PANEL_VIEWS = ['agents', 'data', 'platform', 'files', 'knowledge', 'kpis', 'dashboards', 'software', 'workflows'] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];
export const isPanelView = (v: unknown): v is PanelView => typeof v === 'string' && (PANEL_VIEWS as readonly string[]).includes(v);

export type { AgentsView, DataView, PlatformView, FilesView, KnowledgeView, KpisView, DashboardsView, SoftwareView, WorkflowsView };
export { PlatformForbiddenError } from '@tabs/monitoring/lib/panels/platform-panel';

export function monitoringPanels(user: CurrentUser, view: PanelView): Promise<AgentsView | DataView | PlatformView | FilesView | KnowledgeView | KpisView | DashboardsView | SoftwareView | WorkflowsView> {
  if (view === 'agents') return agentsView(user);
  if (view === 'data') return dataView(user);
  if (view === 'files') return filesView(user);
  if (view === 'knowledge') return knowledgeView(user);
  if (view === 'kpis') return kpisView(user);
  if (view === 'dashboards') return dashboardsView(user);
  if (view === 'software') return softwareView(user);
  if (view === 'workflows') return workflowsView(user);
  return platformView(user);
}
