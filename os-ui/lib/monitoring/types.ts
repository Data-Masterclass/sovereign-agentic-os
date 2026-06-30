/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Monitoring tab — the READ/OBSERVE plane (monitoring-golden-path.md).
 *
 * One contract shared by the five read-only adapters, the OPA-scoped aggregation
 * spine, the trace/lineage correlation, and the UI. Everything here is
 * read-only: Monitoring SHOWS health, WATCHES spend, and TRACES runs — it never
 * sets policy or caps (that is Governance) and never watches business KPIs (that
 * is Dashboards). Each item carries the `owner` + `domain` it belongs to so the
 * SAME scope filter (the viewer's Ory→OPA identity) applies to every lens.
 */

/** Health roll-up. `unknown` = source unreachable AND no mock (kept honest). */
export type Health = 'red' | 'amber' | 'green' | 'unknown';

/**
 * The lens vocabulary. `system` (infra/cluster health) is part of the type
 * because the correlation engine + Platform→Components still reason about it,
 * but it is NOT one of the lenses Monitoring renders: Monitoring is the user's
 * artifact-observability plane (agents/runs · pipelines · spend · drift). The
 * `system` lens moved to Platform Admin → Components (the infrastructure home).
 */
export type LensId = 'runs' | 'pipelines' | 'cost' | 'system' | 'artifacts';

/** The lenses Monitoring renders (system/infra deliberately excluded). */
export const LENS_IDS: LensId[] = ['runs', 'pipelines', 'cost', 'artifacts'];

export const LENS_LABEL: Record<LensId, string> = {
  runs: 'Agent & run observability',
  pipelines: 'Data-pipeline health',
  cost: 'Cost & usage',
  system: 'System & cluster health',
  artifacts: 'Artifacts (all tabs incl. ML)',
};

/**
 * Viewer scope, derived from the Ory identity (role + domains) the same way every
 * other tab scopes. The read plane shows ONLY what this identity is entitled to:
 *   • user    — own runs / cost / artifacts                (level 'user')
 *   • builder — everything in their domains                (level 'builder')
 *   • admin   — tenant + cluster (incl. node/self-heal)    (level 'admin')
 */
export type ScopeLevel = 'user' | 'builder' | 'admin';

export type Scope = {
  level: ScopeLevel;
  /** The viewer's own principal (login id) — the unit of `user` scope. */
  principal: string;
  /** Domains the viewer may observe (builder/admin). */
  domains: string[];
  /** Admin-only: may see node/cluster + self-heal status. */
  cluster: boolean;
  /** Honest marker: how the scope was resolved (OPA live vs identity-derived). */
  via: 'opa' | 'identity';
};

/** Cross-lens correlation + Governance cross-links carried on every item. */
export type Links = {
  runId?: string;
  pipelineId?: string;
  systemId?: string;
  artifactId?: string;
  /** → its Governance audit entry (a trace's audit record). */
  auditRef?: string;
  /** → the Governance cap this spend is measured against (read, never set). */
  capRef?: string;
};

/**
 * A single health signal surfaced in a lens. `owner` + `domain` drive scoping;
 * `source` keeps the dual live/offline-mock pattern honest in the UI.
 */
export type HealthItem = {
  id: string;
  lens: LensId;
  title: string;
  health: Health;
  detail: string;
  /** Owning principal (the unit of `user` scope). */
  owner: string;
  /** Owning domain (the unit of `builder` scope). */
  domain: string;
  /** True only for tenant/cluster-wide signals (admin-only — e.g. a node). */
  cluster?: boolean;
  ts?: string;
  /** Lens-specific scalar (spend $, latency ms, drift score…). */
  metric?: number;
  /** Optional small series for the lens chart (e.g. spend over time). */
  series?: { t: string; v: number }[];
  /** System lens: what healed itself vs what needs a human. */
  selfHeal?: string;
  /** Cost lens: the cap this is measured against (informational; read-only). */
  cap?: { id: string; limitUsd: number; spentUsd: number };
  links?: Links;
  /** 'live' = read from the real backend; 'mock' = offline fixture (kept honest). */
  source: 'live' | 'mock';
};

/** One drill step inside a Langfuse trace (steps · tool calls · in/out · tokens). */
export type TraceStep = {
  name: string;
  kind: 'llm' | 'tool' | 'span' | 'event';
  input?: string;
  output?: string;
  tokens?: number;
  costUsd?: number;
  ms?: number;
  status?: 'ok' | 'error';
};

/** The full drill-into-trace payload (the core promise). */
export type TraceDetail = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  health: Health;
  ts?: string;
  /** The context pack handed to the run (retrieved passages / inputs). */
  contextPack: string[];
  steps: TraceStep[];
  /** Tail of logs (OpenSearch) for this run. */
  logs: string[];
  links?: Links;
  source: 'live' | 'mock';
};

/** Per-lens roll-up for the overview header. */
export type LensSummary = {
  id: LensId;
  label: string;
  health: Health;
  counts: { red: number; amber: number; green: number; unknown: number };
  items: HealthItem[];
};

/** The whole scoped overview the UI renders in one fetch (attention-first). */
export type Overview = {
  scope: Scope;
  lenses: LensSummary[];
  /** The few things needing attention, worst-first (NOT a wall of green). */
  attention: HealthItem[];
  generatedAt: string;
  /** Operational alerts (system/run health only — never business KPIs). */
  alerts: Alert[];
};

/**
 * An operational alert — system/run health only. Self-heal where possible, else
 * notify. KPI/business alerts live in Dashboards and MUST NOT appear here.
 */
export type Alert = {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  domain: string;
  owner: string;
  cluster?: boolean;
  /** 'self-healed' | 'notified' — what happened (notify channels are email/chat/in-app). */
  disposition: 'self-healed' | 'notified';
  links?: Links;
  source: 'live' | 'mock';
};

/** The correlation chain: a run tied to its pipeline → system → artifact. */
export type Correlation = {
  anchor: LensId;
  run?: HealthItem;
  pipeline?: HealthItem;
  system?: HealthItem;
  artifact?: HealthItem;
  /** Cross-links surfaced for the drawer (→ Governance audit / cap). */
  auditRef?: string;
  capRef?: string;
};
