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

import { TIER_BADGE_CLASS } from '@/lib/core/scopes';

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
  /** Source domain — set on shared/marketplace metrics for provenance display. */
  domain?: string;
  /** The folder this metric lives in (normalised path; `'/'` = root). Rides the metric
   *  lifecycle overlay — a metric has no store row of its own. Defaults to `'/'`. */
  folder: string;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
  /** COMPOSITE metric (a formula over other metrics) — the transparency badge. */
  composite?: boolean;
  /** Plain-language "what does this metric mean?" — a muted line under the member on the
   *  tile. Absent ⇒ no line (layout unchanged). */
  description?: string;
  /** FAIL-SOFT: set when this metric's model couldn't load — rendered inline so the
   *  rest of the registry still shows (one bad cube never 500s the whole surface). */
  error?: string;
};
export type MetricGroups = { mine: MetricSummary[]; domain: MetricSummary[]; marketplace: MetricSummary[] };

export type CheckRow = { name: string; ok: boolean; detail: string };
export type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
export type Mode = 'live' | 'live (sql)' | 'offline-mock' | 'unavailable';

export type DefineResult = {
  datasetId: string;
  measure: { name: string; type: string; sql: string };
  member: string;
  convergence: { ok: boolean; rows: CheckRow[] };
  build: { rows: BuildRow[]; ok: boolean; member: string; mode: Mode; pending?: boolean };
  /** Saved, but its live value hasn't sync'd to the query engine yet (not an error). */
  pending?: boolean;
  cube: string;
};

export type ExploreResult = {
  metricId: string;
  member: string;
  rows: Record<string, unknown>[];
  securityContext: Record<string, unknown>;
  sql: string;
  mode: Mode;
  /** Honest degradation notices from the server resolver (dropped slice members, or
   *  an unreachable semantic layer). Present ⇒ show it; never silently swallow. */
  warning?: string;
  /** True when a real deployment's Cube is unreachable — no number, an honest outage. */
  unavailable?: boolean;
  /** True when Cube is up but the measure hasn't sync'd yet (soft "syncing"). */
  pending?: boolean;
};

export type GovernResult = {
  ok: boolean;
  metricId?: string;
  tier?: MetricTier;
  reason?: string;
  consistency: { ok?: boolean; member?: string | null; rows: CheckRow[] };
};

/** A dataset summary as the Data tab serves it — only Gold asset/product may host a metric.
 *  `tier` is typed tolerantly (any string) so a future dataset kind (e.g. "curated") can be
 *  served without breaking the picker — {@link datasetLayerLabel} degrades to the raw kind. */
export type DatasetTile = { id: string; name: string; tier: string; owner: string; connected?: { mode: 'live' | 'sync'; status: string } };
export type DatasetGroups = { mine: DatasetTile[]; domain: DatasetTile[]; marketplace: DatasetTile[] };

/**
 * The friendly LAYER label for a dataset tier — CENTRALISED + tolerant. A metric lives on
 * a governed Gold asset/product; a private `dataset` is a personal draft. An UNKNOWN kind
 * (e.g. an upcoming "curated") is shown verbatim instead of crashing on a missing map key
 * (watch-point 2 — the local `tierLabel` map used to throw for any new kind).
 */
const DATASET_LAYER_LABEL: Record<string, string> = { dataset: 'private', asset: 'asset', product: 'product' };
export function datasetLayerLabel(tier: string): string {
  return DATASET_LAYER_LABEL[tier] ?? tier;
}

// The badge CLASS per tier is OS-wide (lib/core/scopes) — only the tier VOCABULARY
// differs per tab, so map this tab's keys onto the shared class map.
export const TIER_BADGE: Record<MetricTier, string> = {
  personal: TIER_BADGE_CLASS.personal,
  domain: TIER_BADGE_CLASS.shared,
  marketplace: TIER_BADGE_CLASS.certified,
};
export const TIER_WORD: Record<MetricTier, string> = {
  personal: 'Personal',
  domain: 'Domain',
  marketplace: 'Company',
};

/** The leaf of a Cube member — `DailyRevenue.region` → `region`. */
export function leaf(member: string): string {
  return member.includes('.') ? member.split('.').pop()! : member;
}

// ---------------------------------------------------------------------- alerts ---
// An alert is a threshold on a governed metric member — it lives with Metrics.

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte';
/** In-app is the only alert channel (email/Slack were UI fiction with no delivery path). */
export type Channel = 'in_app';
export type Notification = { channel: Channel; message: string };
export type AgentRun = { systemId: string; agent: string; preset: string; reason: string; traced: true };
export type AlertResponse = {
  breached: boolean;
  value: number;
  notifications: Notification[];
  agentRun: AgentRun | null;
  traced: boolean;
};

export const CHANNELS: Channel[] = ['in_app'];

/** Flatten the grouped metric payload into one palette (member pickers). */
export function flatMetrics(g: MetricGroups | null): MetricSummary[] {
  return g ? [...g.mine, ...g.domain, ...g.marketplace] : [];
}

/** POST JSON and surface the route's `error` field as a thrown Error. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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

/** The honest live / live (sql) / offline-mock label (gold when live, quiet otherwise). */
export function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`badge ${mode.startsWith('live') ? 'ok' : 'muted'}`}>{mode}</span>;
}

/** The metric Build report (cube → metric-explorer, apply→verify) + its mode.
 *  When the build is `pending` (Cube is up but the model-sync sidecar hasn't pushed the
 *  just-defined measure yet), a not-yet-resolved row is SYNC LAG, not a failure — so it
 *  renders as "syncing" (⟳), never a hard "✗ Build failed". The metric is already saved. */
export function BuildRowsView({ build }: { build: DefineResult['build'] }) {
  const header = build.ok ? '✓ Build passed' : build.pending ? '⟳ Build syncing' : '✗ Build failed';
  return (
    <div className="build-report">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{header}</strong>
        <ModeBadge mode={build.mode} />
      </div>
      {build.rows.map((r) => {
        // A failing row under a pending build is a sync-lag non-resolution, not an error.
        const syncing = build.pending && r.status === 'fail';
        return (
          <div key={r.tool} className={`build-row ${syncing ? 'ok' : r.status}`}>
            <span className="build-tool">{r.status === 'ok' ? '✓' : syncing ? '⟳' : '✗'} {r.tool}</span>
            <span className="muted" style={{ fontSize: 12 }}>{syncing ? 'syncing — resolves shortly' : (r.error ?? r.detail)}</span>
          </div>
        );
      })}
    </div>
  );
}
