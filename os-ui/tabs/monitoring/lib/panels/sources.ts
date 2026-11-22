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

export type MonitoringSources = {
  /** The Agents store's scoped list of agent systems for this principal. */
  agentSystems(p: PanelPrincipal): Promise<{ id: string; name: string; scope: ScopeGroup }[]>;
  /** The Data store's scoped list of datasets for this principal. */
  datasets(p: PanelPrincipal): Promise<{ id: string; name: string; domain: string; scope: ScopeGroup }[]>;
  /** The Data tab's latest quality record per dataset (Dagster asset checks, or the labelled OS probe). */
  latestTests(ds: { id: string; domain: string }[]): Promise<Map<string, TestRecord | null>>;
  /** The Dagster schedule name of every dataset whose sync is enabled: what the OS expects to be running. */
  syncSchedules(): Promise<{ schedule: string; domain: string; owner: string; datasetId: string }[]>;
  /** The Trino catalog each live warehouse connection uses (the Connections tab's own list). */
  connectionCatalogs(): Promise<{ catalog: string; connectionId: string; name: string; domain: string }[]>;
  /** The dataset's own Dagster asset keys from its generated dbt project; absent when the project is not in git. */
  assetKeys(ds: { id: string; domain: string }[]): Promise<Map<string, { tested: string[] | null; models: string[][] }>>;
  /** The Files tab's scoped list (`listFiles`), with each file's recorded Docling and index outcome. */
  files?(p: PanelPrincipal): Promise<FileRow[]>;
  /** The Knowledge tab's scoped list of workflows (`listWorkflows`). */
  knowledge?(p: PanelPrincipal): Promise<KnowledgeRow[]>;
};

const slot = globalThis as unknown as { __osMonitoringSources?: MonitoringSources };

export function registerMonitoringSources(s: MonitoringSources): void {
  slot.__osMonitoringSources = s;
}

export const SOURCES_MISSING = 'the Agents/Data readers are not registered in this process (monitoring-sources.ts at boot)';

export function monitoringSources(): MonitoringSources | null {
  return slot.__osMonitoringSources ?? null;
}
