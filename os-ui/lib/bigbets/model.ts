/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Big Bets — the domain model + the cross-tab interfaces.
 *
 * A **Big Bet** is a goal + roadmap that *references* (never copies) real
 * artifacts that live in their own tabs (Data, Agents, Dashboards, …). This
 * module is the single contract every adapter, API route and the UI share:
 *
 *   - the registry objects (BigBet, ComponentRef, dependency edges, overrides);
 *   - the **ComponentSource** interface every tab's governed create-flow +
 *     lifecycle is read through (live or offline-mock);
 *   - the Strategy-pillar + business-metric shapes the value model rolls up to.
 *
 * Kept free of `server-only`/Next imports so the whole spine is unit-testable
 * directly with `node --test`; the API routes are the server boundary.
 */

// ----------------------------------------------------------------- identity ---

// Single-sourced from the session module (itself pure/edge-safe, so this file
// stays free of `server-only`/Next imports and unit-testable).
export { roleAtLeast, type Role } from '../session.ts';
import type { Role as R } from '../session.ts';
export type Principal = { id: string; domains: string[]; role: R };

/**
 * The planner runs as a *system* principal. It can scaffold (draft-level
 * create) but the store + sources REJECT it for any promote/certify/go-live
 * transition — the "planner never self-promotes" invariant, enforced in code,
 * not just convention. `kind === 'planner'` is the tell.
 */
export type Actor = Principal & { kind?: 'human' | 'planner' };

// --------------------------------------------------------------- the tabs -----

/** The nine component-bearing tabs a bet can reference, plus their single-letter glyphs. */
export type Tab =
  | 'data'
  | 'metric'
  | 'dashboard'
  | 'software'
  | 'agent'
  | 'ml'
  | 'knowledge'
  | 'files'
  | 'connection';

export const TAB_LABEL: Record<Tab, string> = {
  data: 'Data product',
  metric: 'Metric',
  dashboard: 'Dashboard',
  software: 'Software app',
  agent: 'Agent',
  ml: 'ML model',
  knowledge: 'Knowledge',
  files: 'Files',
  connection: 'Connection',
};

/**
 * Which tabs *generate* value at the leaves (dashboards/agents/software/ML) vs
 * which are *upstream foundational assets* that earn value by downstream usage
 * (data/knowledge/connections/metrics). Drives equal-split + upstream credit.
 */
export const LEAF_TABS: Tab[] = ['dashboard', 'agent', 'software', 'ml'];
export const UPSTREAM_TABS: Tab[] = ['data', 'knowledge', 'connection', 'metric'];

// ------------------------------------------------------- artifact lifecycle ---

/**
 * The RAW per-tab lifecycle token an artifact carries in its own tab. Status is
 * DERIVED from this (see status.ts) — never hand-set on the bet. `planned` is a
 * real registry state: a scaffolded reference whose artifact stub exists but
 * holds no work yet. The "ready" tokens (certified/promoted/…) are tab-specific
 * but all map to `completed`.
 */
export type Lifecycle =
  | 'planned' // scaffolded reference; nothing built yet
  | 'building' // work started (data product building / model training)
  | 'draft' // has a draft (dashboard/agent/knowledge/metric defined-not-promoted)
  | 'staging' // ML registered in Staging
  | 'untested' // connection added, not tested
  | 'certified'
  | 'promoted'
  | 'published'
  | 'deployed'
  | 'live'
  | 'production'
  | 'tested-governed';

/** The three derived states every component rolls up to + the dependency gate. */
export type DerivedStatus = 'planned' | 'in-progress' | 'completed';

/** An artifact as the bet sees it across the tabs (read through a ComponentSource). */
export type Artifact = {
  id: string;
  tab: Tab;
  title: string;
  domain: string;
  /** Visibility tier — drives OPA/RLS: a not-yet-shared artifact is members-only. */
  visibility: 'personal' | 'shared' | 'marketplace' | 'certified';
  lifecycle: Lifecycle;
  /** Upstream artifact ids this one *builds on* (registry consume-edges). */
  consumes: string[];
  /** Bets this artifact is tagged to (a component can belong to many bets). */
  bigBetIds: string[];
  /** Best-effort monthly usage signal for usage-based allocation. */
  usage30d: number;
  /** OpenMetadata FQN for the lineage deep-link (mock locally). */
  omFqn?: string;
};

// ----------------------------------------------------- the registry objects ---

/**
 * Problem statement. `need` carries the single free-form problem statement the
 * create form captures; `who` carries the bet's business Owner. `obstacle` and
 * `impact` are legacy sub-fields kept for back-compat (older bets + the value
 * model tests) — the current UI no longer collects them.
 */
export type ProblemStatement = {
  who: string;
  need: string;
  obstacle: string;
  impact: string;
};

/**
 * Derive a short, human bet name from its problem statement — used when the
 * create form no longer collects a separate name (the problem statement is the
 * identity). Trims to the first sentence/line, capped to ~70 chars.
 */
export function deriveBetName(statement: string, fallback = 'Untitled big bet'): string {
  const first = (statement || '').trim().split(/[\n.!?]/)[0]?.trim() ?? '';
  if (!first) return fallback;
  return first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
}

/** Selectable realized-value basis (default uplift-over-baseline). */
export type ValueBasis = 'uplift' | 'absolute' | 'owner-declared';

/** Selectable allocation of a bet's value to its components (default manual weights). */
export type AllocationMethod = 'manual' | 'usage' | 'equal';

/** An owner annotation shown BESIDE the derived state, never replacing it. Audited. */
export type StatusOverride = {
  note: string;
  /** Optional asserted state ("done early") — informational; derived stays authoritative. */
  asserts?: DerivedStatus;
  by: string;
  at: string;
};

/** A reference to a real artifact, on the roadmap. The bet never holds a copy. */
export type ComponentRef = {
  /** Ref id (the edge), distinct from the artifact id (a component can be in many bets). */
  id: string;
  artifactId: string;
  tab: Tab;
  /** Start + planned-ready date for the Gantt bar (ISO yyyy-mm-dd). */
  start: string;
  plannedReady: string;
  /** Build-order dependencies: ref ids that BLOCK this one (A blocks B). */
  dependsOn: string[];
  /** Manual allocation weight (0–100) when allocation = manual. */
  weight: number;
  override?: StatusOverride;
  /** Provenance — was it scaffolded by the planner or linked to an existing artifact. */
  origin: 'scaffolded' | 'linked';
  addedBy: string;
  addedAt: string;
};

export type BigBet = {
  id: string;
  name: string;
  problem: ProblemStatement;
  domain: string;
  /** Cross-domain bets are Admin-owned; each component keeps its own domain's controls. */
  crossDomain: boolean;
  owner: string;
  /** Free-form solution idea (how the bet intends to realize the value). */
  solution?: string;
  /** Members who may SEE not-yet-shared component detail (OPA). Owner is always a member. */
  members: string[];
  /** Up-link to the Strategy value model. Optional — a new bet may not yet be linked. */
  pillarId?: string;
  metricId?: string;
  /** Target € value the bet commits to. */
  targetValue: number;
  /** Realized-value basis + allocation method (both selectable, per bet). */
  valueBasis: ValueBasis;
  allocation: AllocationMethod;
  /** Owner-declared realized value (used only when basis = owner-declared). */
  ownerDeclaredValue?: number;
  goLive: string;
  status: 'draft' | 'active' | 'shipped' | 'archived';
  components: ComponentRef[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

// ------------------------------------------------------------- Strategy up-link ---

/** A governed Cube business metric (the pillar's North Star). Resolved RLS-scoped. */
export type BusinessMetric = {
  id: string;
  name: string;
  cubeMeasure: string;
  unit: '€' | '%' | 'count';
  /** Captured baseline for uplift, current value, and per-viewer RLS values. */
  baseline: number;
  current: number;
  /** Optional per-principal-id RLS override of `current` (entitlement-scoped numbers). */
  rls?: Record<string, number>;
};

/** A Strategy pillar — the TOTAL value that distributes down to its bets. */
export type Pillar = {
  id: string;
  name: string;
  scope: 'tenant' | 'domain';
  domain?: string;
  metricId: string;
};

// ------------------------------------------------ the cross-tab source seam ---

/**
 * Every tab exposes its artifacts + its governed create-flow through this one
 * interface. Big Bets NEVER reaches into a tab directly — it goes through a
 * ComponentSource so the same code path works for the live backend and the
 * offline mock, and so "add component" always calls the tab's *own* governed
 * create action (reuse, never fork). Cross-tab sources for kind are mocked in
 * sources.ts and reconciled to the real per-tab stores at consolidation.
 */
export interface ComponentSource {
  readonly tab: Tab;
  /**
   * List artifacts (optionally scoped to a bet/domain). When `viewer` is supplied
   * the list is canView-scoped: real per-tab artifacts are read through each tab's
   * OWN governed list gate, and in-memory (scaffolded/registered) drafts are
   * filtered by the same visibility rule the picker route uses. Without a viewer
   * the list is the raw in-memory registry (unit tests / lineage joins).
   */
  list(opts?: { bigBetId?: string; domain?: string; viewer?: Principal }): Artifact[];
  get(artifactId: string): Artifact | null;
  /**
   * The tab's GOVERNED create flow. Scaffolds a draft-level artifact (lifecycle
   * `planned`), tags it with `bigBetId`, returns it. Promotion/certification is
   * NOT here — it is {@link advance}, role-gated.
   */
  scaffold(input: { title: string; domain: string; bigBetId: string; by: Actor; consumes?: string[] }): Artifact;
  /** Tag/untag an existing artifact to a bet (membership; never deletes the artifact). */
  tag(artifactId: string, bigBetId: string): Artifact | null;
  untag(artifactId: string, bigBetId: string): Artifact | null;
  /**
   * Advance an artifact's lifecycle (build → certify/promote/publish/deploy/go-live).
   * REJECTS a planner actor for any "ready" transition — the human-ships invariant.
   */
  advance(artifactId: string, to: Lifecycle, by: Actor): Artifact;
}

// --------------------------------------------------------------- audit ------

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  betId?: string;
  detail?: Record<string, unknown>;
};

// ---------------------------------------------------------------- errors ----

export class BetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BetError';
    this.status = status;
  }
}
