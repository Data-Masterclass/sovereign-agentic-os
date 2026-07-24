/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { getSystem } from '@/lib/agents/store';
import { getDataset, listDatasetVersions } from '@/lib/data/store';
import { lineageFor } from '@/lib/data/lineage';
import { latestRun, healthTrend, ensureHydrated as ensureDqHydrated } from '@/lib/data/dq-results';
import { agentTelemetryFor, type AgentRunRecord } from './adapters/agent-telemetry';
import {
  rollupAgentTelemetry,
  rollupDatasetTelemetry,
  summarizeDq,
  dailySeries,
  type AgentTelemetry,
  type DatasetTelemetry,
  type CheckVerdict,
  type DqSummary,
} from './telemetry-core';
import { LAYERS, type Layer } from '@/lib/data/dataset-schema';

/**
 * The big DIAGNOSIS-WINDOW payloads. Everything a user needs to diagnose ONE agent
 * system or ONE dataset in a single fetch — assembled from the SAME governed stores
 * the tiles use, so scope/visibility is enforced by `getSystem`/`getDataset` (a 403
 * from there is the caller's own scope, never widened here).
 */

// ------------------------------------------------------------------ agent detail --

export type AgentDetail = {
  id: string;
  name: string;
  domain: string;
  agentCount: number;
  running: boolean;
  scheduled: boolean;
  /** 7-day rollup for the header stats. */
  telemetry: AgentTelemetry;
  /** Per-day cost + token series for the trend chart (oldest→newest). */
  costSeries: { day: number; value: number }[];
  tokenSeries: { day: number; value: number }[];
  /** Run history, newest first (time · status · cost · tokens · model · duration). */
  runs: AgentRunRecord[];
  /** Recent error/warning log lines derived from the run history. */
  issues: { at: number; name: string; health: 'warn' | 'error'; detail: string }[];
  /** Honest telemetry provenance. */
  source: string;
  langfuseReachable: boolean;
  /** Deep-links for the footer. */
  links: { agent: string; langfuse: string };
};

export async function agentDetail(user: CurrentUser, systemId: string, nowMs: number): Promise<AgentDetail> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  const view = getSystem(systemId, principal); // enforces visibility (throws 403/404)
  let agentCount = 0;
  try {
    agentCount = view.system.agents.length;
  } catch {
    agentCount = 0;
  }

  const tele = await agentTelemetryFor(systemId, nowMs);
  const telemetry = rollupAgentTelemetry(tele.runs, nowMs);
  const costSeries = dailySeries(tele.runs, nowMs, (r) => r.costUsd ?? 0);
  const tokenSeries = dailySeries(tele.runs, nowMs, (r) => r.tokens ?? 0);
  const issues = tele.runs
    .filter((r) => r.health !== 'ok')
    .slice(0, 25)
    .map((r) => ({
      at: r.at,
      name: r.name,
      health: r.health as 'warn' | 'error',
      detail: r.decision ? `decision=${r.decision}` : r.health === 'error' ? 'run error' : 'held for approval',
    }));

  return {
    id: view.id,
    name: view.name,
    domain: view.domain,
    agentCount,
    running: view.running,
    scheduled: view.schedule.kind !== 'manual',
    telemetry,
    costSeries,
    tokenSeries,
    runs: tele.runs.slice(0, 100),
    issues,
    source: tele.source,
    langfuseReachable: tele.langfuseReachable,
    links: {
      agent: `/agents?focus=${view.id}`,
      langfuse: `${config.langfuseConsoleUrl}`,
    },
  };
}

// ---------------------------------------------------------------- dataset detail --

export type DatasetCheckRow = {
  id: string;
  label: string;
  /** Resolved verdict from the LAST persisted DQ run (honest; no re-run in this read view). */
  verdict: CheckVerdict;
  /** Violation count for a failed rule; null when not run. */
  violations: number | null;
  reason?: string;
};

export type DatasetDetail = {
  id: string;
  name: string;
  domain: string;
  tier: string;
  freshness: string | null;
  ageDays: number | null;
  telemetry: DatasetTelemetry;
  /** The Data-Quality dashboard block: last-run summary + trend + per-rule rows. */
  dq: {
    summary: DqSummary;
    /** When the persisted DQ run was recorded, or null if none. */
    ranAt: string | null;
    /** 0–100 health score of the last run, or null when nothing ran. */
    score: number | null;
    /** DQ health trend (oldest→newest) for the sparkline. */
    trend: { ranAt: string; score: number | null; badge: string }[];
    checks: DatasetCheckRow[];
  };
  /** Build/version timeline for the medallion layers (bronze→silver→gold). */
  layers: { layer: Layer; built: boolean; passThrough: boolean; quality: string; updatedAt: string | null }[];
  /** Snapshot version log (newest first): who/when/what. */
  versions: { version: number; at: string; author: string; summary: string }[];
  /** Lineage: upstreams + downstream metrics/dashboards. */
  lineage: {
    nodes: { id: string; kind: string; label: string; sublabel: string; built: boolean }[];
    edges: { from: string; to: string; kind: string }[];
  };
  links: { data: string };
};

function ageInDays(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

export async function datasetDetail(user: CurrentUser, datasetId: string, nowMs: number): Promise<DatasetDetail> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  const d = getDataset(datasetId, principal); // enforces visibility (throws 403/404)

  // Freshness = the furthest built layer's updatedAt.
  const built = LAYERS.filter((l) => d.versions[l].built);
  const freshness = built.length ? d.versions[built[built.length - 1]].updatedAt : null;
  const ageDays = ageInDays(freshness, nowMs);

  // REAL data-quality: the last persisted DQ run for this dataset (per-rule results
  // with violation counts). No run recorded ⇒ honest neutral (summary.hasRun=false),
  // never a fabricated green. This is the SAME store the Data tab's DQ stage writes.
  await ensureDqHydrated().catch(() => {});
  const last = latestRun(datasetId);
  const dqResults = last?.results ?? null;
  const summary = summarizeDq(
    dqResults && dqResults.map((r) => ({ id: r.id, label: r.label, status: r.status, violations: r.violations, reason: r.reason })),
  );
  const checks: DatasetCheckRow[] = (dqResults ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    verdict: r.status,
    violations: r.violations,
    reason: r.reason,
  }));
  const trend = healthTrend(datasetId);

  const checkVerdicts = checks.map((c): CheckVerdict => c.verdict);
  const tele = rollupDatasetTelemetry(checkVerdicts, {
    stalenessWarn: ageDays !== null && ageDays > 7 && ageDays <= 30,
    pipelineError: (ageDays !== null && ageDays > 30) || summary.violated > 0,
  });

  const g = lineageFor(d);
  const versions = listDatasetVersions(datasetId, principal).map((v) => ({
    version: v.version,
    at: v.at,
    author: v.author,
    summary: v.summary,
  }));

  return {
    id: d.id,
    name: d.name,
    domain: d.domain,
    tier: d.tier,
    freshness,
    ageDays,
    telemetry: tele,
    dq: {
      summary,
      ranAt: last?.ranAt ?? null,
      score: last?.healthScore ?? null,
      trend: trend.map((t) => ({ ranAt: t.ranAt, score: t.score, badge: t.badge })),
      checks,
    },
    layers: LAYERS.map((l) => ({
      layer: l,
      built: d.versions[l].built,
      passThrough: d.versions[l].passThrough,
      quality: d.versions[l].quality,
      updatedAt: d.versions[l].updatedAt,
    })),
    versions,
    lineage: {
      nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, sublabel: n.sublabel, built: n.built })),
      edges: g.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    },
    links: { data: `/data?focus=${d.id}` },
  };
}
