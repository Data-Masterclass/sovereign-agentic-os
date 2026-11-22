/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The other tabs' readers the Monitoring panels need — injected, never imported
 * USER STORY: As a maintainer I want Monitoring to read the viewer's agent systems and datasets
 *             through the Agents and Data tabs' own scoped lists without a tab importing another
 *             tab (GLUE-9), so each tab can change its internals freely.
 * ARCHITECTURE:
 *   - A port. `monitoring-sources.ts` (beside instrumentation.ts, the one place that may know every
 *     tab) registers the implementation at boot; tests register their own.
 *   - Not registered ⇒ `monitoringSources()` is null and the panels report `sources.inventory` as
 *     unavailable — an empty list is then labelled as "could not be listed", never as "none".
 */
export type ScopeGroup = 'mine' | 'domain' | 'marketplace';
export type PanelPrincipal = { id: string; domains: string[]; role: string };

export type TestRecord = {
  source: 'dagster' | 'os' | null;
  ranAt: string | null;
  results: { id: string; label: string; status: 'pass' | 'fail' | 'not_run' | string; violations: number | null }[];
};

/** One file of the Files tab's scoped list with what Docling and the index run recorded for it. */
export type FileRow = {
  id: string;
  name: string;
  domain: string;
  scope: ScopeGroup;
  kind: string;
  bytes: number;
  mode: 'indexed' | 'stored-only';
  /** Docling's recorded answer (absent = no conversion was needed or asked). */
  extraction: { status: 'extracted' | 'pending' | 'failed'; code?: string; reason?: string; at?: string } | null;
  /** The recorded result of the last index run (absent = none recorded). */
  outcome: { status: 'indexed' | 'empty' | 'failed'; chunks?: number; reason?: string; at?: string } | null;
};

/** One connected drive (a Files `ConnectorSource`) with the health of the Connection it syncs with. */
export type DriveRow = {
  id: string;
  provider: 'google-drive' | 'onedrive';
  label: string;
  domain: string;
  owner: string;
  mode: 'copy' | 'reference';
  connectionId: string | null;
  /** The Connections store's own `health`, mapped; `unknown` when it could not be read. */
  connectionHealth: 'healthy' | 'needs-reconnect' | 'unknown';
  /** Remote files recorded in the import ledger (their content landed). */
  imported: number;
  initialDone: boolean;
  createdAt: string;
  paused: { reason: string; at: string } | null;
  /** The bounded run history, oldest first. */
  runs: { at: string; endedAt: string; durationMs: number; trigger: 'manual' | 'schedule'; ok: boolean; added: number; changed: number; unchanged: number; error?: string }[];
};

/** One knowledge workflow of the Knowledge tab's scoped list. */
export type KnowledgeRow = {
  id: string;
  title: string;
  domain: string;
  scope: ScopeGroup;
  status: 'draft' | 'live';
  updatedAt: string;
  publishedAt: string | null;
  certified: boolean;
};

/** One governed metric of the Metrics tab's scoped list. `error` is the registry's own load error (fail-soft). */
export type MetricRow = { id: string; name: string; member: string; datasetId: string; datasetName: string; domain: string; scope: ScopeGroup; error?: string };

/** One alert rule the viewer may see (creator own · builder own + domain · admin all), as stored with its last evaluation. */
export type AlertRuleRow = { id: string; member: string; comparator: string; threshold: number; owner: string; domain: string; lastEvaluated?: string; lastBreached?: boolean; lastValue?: number };

/** One dashboard of the Dashboards tab's scoped list; each panel's members were checked by the tab against the served model. */
export type DashboardRow = {
  id: string;
  name: string;
  domain: string;
  scope: ScopeGroup;
  view: string;
  /** False when the served model has no such view at all. */
  viewServed: boolean;
  panels: { name: string; members: string[]; missing: string[] }[];
};

export type MonitoringSources = {
  /** The Agents store's scoped list of agent systems for this principal. */
  agentSystems(p: PanelPrincipal): Promise<{ id: string; name: string; scope: ScopeGroup }[]>;
  /** The Data store's scoped list of datasets for this principal. */
  datasets(p: PanelPrincipal): Promise<{ id: string; name: string; domain: string; scope: ScopeGroup }[]>;
  /** The Data tab's latest quality record per dataset (Dagster asset checks, or the labelled OS probe). */
  latestTests(ds: { id: string; domain: string }[]): Promise<Map<string, TestRecord | null>>;
  /** The dataset's own Dagster asset keys from its generated dbt project; absent when the project is not in git. */
  assetKeys(ds: { id: string; domain: string }[]): Promise<Map<string, { tested: string[] | null; models: string[][] }>>;
  /** The Files tab's scoped list (`listFiles`), with each file's recorded Docling and index outcome. */
  files?(p: PanelPrincipal): Promise<FileRow[]>;
  /** Every connected drive (the reader need not scope; the panel does, with the Files rule). */
  driveSources?(p: PanelPrincipal): Promise<DriveRow[]>;
  /** The Knowledge tab's scoped list of workflows (`listWorkflows`). */
  knowledge?(p: PanelPrincipal): Promise<KnowledgeRow[]>;
  /** The Metrics tab's scoped list (`listMetrics`). */
  metrics?(p: PanelPrincipal): Promise<MetricRow[]>;
  /** The alert rules the viewer may see. */
  alertRules?(p: PanelPrincipal): Promise<AlertRuleRow[]>;
  /** The Dashboards tab's scoped list with the served-model check of each panel. */
  dashboards?(p: PanelPrincipal): Promise<DashboardRow[]>;
};

const slot = globalThis as unknown as { __osMonitoringSources?: MonitoringSources };

export function registerMonitoringSources(s: MonitoringSources): void {
  slot.__osMonitoringSources = s;
}

export const SOURCES_MISSING = 'the Agents/Data readers are not registered in this process (monitoring-sources.ts at boot)';

export function monitoringSources(): MonitoringSources | null {
  return slot.__osMonitoringSources ?? null;
}
