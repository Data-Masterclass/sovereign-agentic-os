/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

// Shared contract types + tiny pure helpers for the Big Bets UI. No 'use client'
// — this is a plain module imported by the client pages/components. Mirrors the
// finalized backend shapes from GET /api/big-bets and GET /api/big-bets/{id}.

export type Tab =
  | 'data' | 'metric' | 'dashboard' | 'software' | 'agent'
  | 'ml' | 'knowledge' | 'files' | 'connection';
export type Readiness = 'on-track' | 'at-risk' | 'blocked' | 'done';
export type DerivedStatus = 'planned' | 'in-progress' | 'completed';
export type ValueBasis = 'uplift' | 'absolute' | 'owner-declared';
export type AllocationMethod = 'manual' | 'usage' | 'equal';

export type Problem = { who: string; need: string; obstacle: string; impact: string };

export type BetSummary = {
  id: string; name: string; domain: string; owner: string; crossDomain: boolean;
  pillarId: string; problem: Problem; goLive: string; status: string;
  components: number; completion: { done: number; total: number; pct: number };
  signal: Readiness; goLiveRealistic: boolean; targetValue: number; realized: number;
};

export type ComponentRef = {
  id: string; artifactId: string; tab: Tab; start: string; plannedReady: string;
  dependsOn: string[]; weight: number;
  override?: { note: string; asserts?: string };
  origin: string; addedBy: string; addedAt: string;
};

export type ComponentStatus = {
  refId: string; derived: DerivedStatus; lifecycle: string; blocked: boolean;
  blockedBy: string[];
  override?: { note: string; asserts?: string; by: string; at: string };
  label: string;
};

export type Artifact = {
  id: string; tab: Tab; title: string; lifecycle: string; visibility: string;
  omFqn?: string; readyVerb: string;
};

export type BetComponent = {
  status: ComponentStatus; visible: boolean; artifact: Artifact | null;
};

export type RoadmapComp = {
  refId: string; start: string; plannedReady: string; readiness: Readiness;
  daysLate: number | null; dependsOn: string[];
};

export type DistributionRow = {
  refId: string | null; artifactId: string; tab: Tab; title: string;
  value: number; sharePct: number; upstreamCredit: number; upstream: boolean;
};

export type BetView = {
  bet: {
    id: string; name: string; domain: string; crossDomain: boolean; owner: string;
    members: string[]; pillarId: string; metricId: string; targetValue: number;
    valueBasis: ValueBasis; allocation: AllocationMethod; goLive: string; status: string;
    problem: Problem; components: ComponentRef[];
  };
  pillar: { id: string; name: string } | null;
  metric: { id: string; name: string } | null;
  components: BetComponent[];
  completion: { done: number; total: number; pct: number };
  roadmap: {
    components: RoadmapComp[]; pct: number; atRisk: number; blocked: number;
    goLive: string; goLiveRealistic: boolean; signal: Readiness;
  };
  value: {
    realized: {
      basis: ValueBasis; target: number; realized: number; baseline: number;
      current: number; unit: string; corroboration?: string;
    };
    distribution: {
      betValue: number; components: DistributionRow[];
      reconciles: boolean; residual: number; allocation: AllocationMethod;
    };
  };
  composition: {
    nodes: { id: string; tab: Tab; title: string; upstream: boolean; omFqn?: string }[];
    edges: { from: string; to: string }[];
  };
  sourceMode: 'live' | 'mock';
  audit: { id: string; at: string; actor: string; action: string; betId?: string; detail?: string }[];
  canEdit: boolean;
};

export type Pillar = {
  id: string; name: string; scope: string;
  metric: { id: string; name: string; unit: string } | null;
};

export type PlannerStep = {
  tab: Tab; title: string; dependsOn: number[]; offsetDays: number;
  consumes?: string[]; rationale: string;
};
export type ProposedPlan = { goal: string; template: string; steps: PlannerStep[] };

// ---- helpers -------------------------------------------------------------

/** Format a euro amount with thousands grouping, no cents. */
export function eur(n: number): string {
  return '€' + Math.round(n || 0).toLocaleString('en-US');
}

/** Parse a yyyy-mm-dd (or ISO) date to epoch ms; 0 when unparseable. */
export function day(iso: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Compact human date, e.g. "27 Jun 2026". */
export function fmtDate(iso: string): string {
  const t = day(iso);
  if (!t) return iso || '—';
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Weave the four-part problem statement into one readable line. */
export function problemLine(p: Problem): string {
  if (!p?.who && !p?.need) return 'No problem statement yet.';
  let s = `${p.who || 'A team'} needs ${p.need || 'an outcome'}`;
  if (p.obstacle) s += `, but ${p.obstacle}`;
  if (p.impact) s += ` — ${p.impact}`;
  return s + (s.endsWith('.') ? '' : '.');
}

export const SIGNAL_LABEL: Record<Readiness, string> = {
  done: 'done', 'on-track': 'on track', 'at-risk': 'at risk', blocked: 'blocked',
};
export const SIGNAL_BADGE: Record<Readiness, string> = {
  done: 'badge ok', 'on-track': 'badge ok', 'at-risk': 'badge warn', blocked: 'badge muted',
};

// Roadmap bar fills by readiness — gold for done, neutral on-track, amber
// at-risk, grey striped for blocked. No purple anywhere.
export const READY_FILL: Record<Readiness, string> = {
  done: 'linear-gradient(90deg, var(--gold-deep), var(--gold-light))',
  'on-track': 'var(--border-strong)',
  'at-risk': '#d9a441',
  blocked: 'repeating-linear-gradient(45deg, #cfc7b6 0 5px, #e6dfce 5px 10px)',
};

/** Shared JSON fetch helper. Throws Error(message) on non-2xx. */
export async function api(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}
