/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * Shared types + tiny presentational parts for the Metrics tab. The route contracts
 * (lib/metrics/*) are the source of truth — these mirror them read-only so the four
 * surfaces (registry / define / explore / govern) speak one language without re-deriving
 * the same shapes five times.
 */

export type MetricTier = 'personal' | 'domain' | 'marketplace';

export type MetricSummary = {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  member: string;
  tier: MetricTier;
  owner: string;
  type: string;
};
export type MetricGroups = { mine: MetricSummary[]; domain: MetricSummary[]; marketplace: MetricSummary[] };

export type CheckRow = { name: string; ok: boolean; detail: string };
export type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
export type Mode = 'live' | 'offline-mock';

export type DefineResult = {
  datasetId: string;
  measure: { name: string; type: string; sql: string };
  member: string;
  convergence: { ok: boolean; rows: CheckRow[] };
  build: { rows: BuildRow[]; ok: boolean; member: string; mode: Mode };
  cube: string;
};

export type ExploreResult = {
  metricId: string;
  member: string;
  rows: Record<string, unknown>[];
  securityContext: Record<string, unknown>;
  sql: string;
  mode: Mode;
};

export type GovernResult = {
  ok: boolean;
  metricId?: string;
  tier?: MetricTier;
  reason?: string;
  consistency: { ok?: boolean; member?: string | null; rows: CheckRow[] };
};

/** A dataset summary as the Data tab serves it — only Gold asset/product may host a metric. */
export type DatasetTile = { id: string; name: string; tier: 'dataset' | 'asset' | 'product'; owner: string };
export type DatasetGroups = { mine: DatasetTile[]; domain: DatasetTile[]; marketplace: DatasetTile[] };

export const TIER_BADGE: Record<MetricTier, string> = {
  personal: 'vis-personal',
  domain: 'vis-shared',
  marketplace: 'vis-certified',
};
export const TIER_WORD: Record<MetricTier, string> = {
  personal: 'Personal',
  domain: 'Domain',
  marketplace: 'Marketplace',
};

/** The leaf of a Cube member — `DailyRevenue.region` → `region`. */
export function leaf(member: string): string {
  return member.includes('.') ? member.split('.').pop()! : member;
}

/** The ✓/✗ check rows shared by define-convergence and the govern consistency gate. */
export function ChecksList({ rows }: { rows: CheckRow[] }) {
  return (
    <div className="build-report">
      {rows.map((r) => (
        <div key={r.name} className={`build-row ${r.ok ? 'ok' : 'fail'}`}>
          <span className="build-tool">{r.ok ? '✓' : '✗'} {r.name}</span>
          <span className="muted" style={{ fontSize: 12 }}>{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** The honest live / offline-mock label (gold when live, quiet otherwise). */
export function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`badge ${mode === 'live' ? 'ok' : 'muted'}`}>{mode}</span>;
}

/** The metric Build report (cube → metric-explorer, apply→verify) + its mode. */
export function BuildRowsView({ build }: { build: DefineResult['build'] }) {
  return (
    <div className="build-report">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{build.ok ? '✓ Build passed' : '✗ Build failed'}</strong>
        <ModeBadge mode={build.mode} />
      </div>
      {build.rows.map((r) => (
        <div key={r.tool} className={`build-row ${r.status}`}>
          <span className="build-tool">{r.status === 'ok' ? '✓' : '✗'} {r.tool}</span>
          <span className="muted" style={{ fontSize: 12 }}>{r.error ?? r.detail}</span>
        </div>
      ))}
    </div>
  );
}
