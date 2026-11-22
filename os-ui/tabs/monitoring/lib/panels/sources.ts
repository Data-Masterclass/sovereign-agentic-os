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

/** The security scan of an app's newest review card, as the review recorded it. */
export type ScanFacts = {
  mode: string;
  /** The engine that produced the result (`trivy`); null when none ran. */
  engine: string | null;
  passed: boolean;
  /** True when NO engine ran: `passed` is false for that reason, not a finding. */
  unavailable: boolean;
  reason: string | null;
  /** Categories no engine covered — a zero there is not "clean". */
  notRun: string[];
  /** The review capped its finding list; severity counts are then of the listed findings only. */
  truncated: boolean;
  scannedAt: string;
  byCategory: Record<string, number>;
  bySeverity: Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>;
};

/** One app of the Software tab's scoped list with its newest review card. */
export type SoftwareRow = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  scope: ScopeGroup;
  serveMode: 'spec' | 'runtime' | 'image';
  /** The runner's object name (`app-<slug>`) for an image app — the pod label — else null (no pod exists). */
  runner: string | null;
  /** `deployStatusOf` — the one honest status word. */
  status: { label: string; servedUrl: string | null };
  review: { requestedAt: string; decision: string; decidedAt: string | null; scan: ScanFacts } | null;
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
  /** The Software tab's scoped list of apps (`listAppsForUser`) with each app's newest review card. */
  software?(p: PanelPrincipal): Promise<SoftwareRow[]>;
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
