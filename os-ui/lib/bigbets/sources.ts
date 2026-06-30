/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cross-tab component sources + the Strategy up-link, for `kind`.
 *
 * Big Bets references components that live on EVERY other tab — but those tabs
 * ship on parallel branches, not on `main`. So here we provide ONE faithful
 * offline-mock {@link ComponentSource} per tab (data/knowledge/files/software/
 * agents/metrics/dashboards/connections/ML) behind the exact interface the real
 * per-tab governed flows will satisfy at consolidation, plus a mock Strategy
 * pillar + governed business metric.
 *
 * The mock is the *operational* path for kind (no STACKIT, no live backend) and
 * the seam is honest: every source records whether it answered `live` or `mock`
 * via {@link sourceMode}. Wiring a live source later means swapping the body of
 * `scaffold`/`advance`/`list` to call the tab's API + OpenMetadata — the bet
 * code above never changes.
 *
 * Invariants encoded here (not just documented):
 *   - `scaffold` always lands a `planned` (draft-level) artifact, tagged to the
 *     bet — the tab's governed create flow, never a fork.
 *   - `advance` to any READY lifecycle (certified/promoted/published/deployed/
 *     live/production/tested-governed) REJECTS a planner actor → human ships.
 */

import {
  type Actor,
  type Artifact,
  type BusinessMetric,
  type ComponentSource,
  type Lifecycle,
  type Pillar,
  type Tab,
  BetError,
} from './model.ts';

// The READY tokens (→ derived `completed`). Reaching any of these is a human-only
// promote/certify/go-live — the planner is rejected.
const READY: Lifecycle[] = [
  'certified',
  'promoted',
  'published',
  'deployed',
  'live',
  'production',
  'tested-governed',
];

/** The natural "ready" verb each tab promotes into — used to label + to advance. */
export const READY_VERB: Record<Tab, Lifecycle> = {
  data: 'certified',
  metric: 'promoted',
  dashboard: 'published',
  software: 'deployed',
  agent: 'live',
  ml: 'production',
  knowledge: 'published',
  files: 'published',
  connection: 'tested-governed',
};

export function isReady(l: Lifecycle): boolean {
  return READY.includes(l);
}

// ------------------------------------------------------------- the store -----

type SourceMode = 'live' | 'mock';
let mode: SourceMode = 'mock';
export function sourceMode(): SourceMode {
  return mode;
}
/** Test/ops hook: in kind we always answer from the mock. */
export function setSourceMode(m: SourceMode): void {
  mode = m;
}

const artifacts = new Map<string, Artifact>();
let seeded = false;
let seq = 0;

function id(tab: Tab): string {
  seq += 1;
  return `${tab}_${(Date.now().toString(36) + seq.toString(36)).slice(-7)}`;
}

function ensureSeeded(): void {
  // A fresh tenant starts EMPTY. Linkable artifacts come only from real
  // governed components created across the tabs (e.g. the Northpeak seed).
  if (seeded) return;
  seeded = true;
}

function put(a: Artifact): Artifact {
  artifacts.set(a.id, a);
  return a;
}

/** Test hook: wipe + reseed the cross-tab mock. */
export function __resetSources(): void {
  artifacts.clear();
  seeded = false;
  seq = 0;
  mode = 'mock';
}

// ------------------------------------------------ generic source factory -----

class MockSource implements ComponentSource {
  readonly tab: Tab;
  constructor(tab: Tab) {
    this.tab = tab;
  }

  list(opts?: { bigBetId?: string; domain?: string }): Artifact[] {
    ensureSeeded();
    const out: Artifact[] = [];
    for (const a of artifacts.values()) {
      if (a.tab !== this.tab) continue;
      if (opts?.bigBetId && !a.bigBetIds.includes(opts.bigBetId)) continue;
      if (opts?.domain && a.domain !== opts.domain) continue;
      out.push(a);
    }
    return out.sort((x, y) => x.title.localeCompare(y.title));
  }

  get(artifactId: string): Artifact | null {
    ensureSeeded();
    const a = artifacts.get(artifactId);
    return a && a.tab === this.tab ? a : null;
  }

  scaffold(input: {
    title: string;
    domain: string;
    bigBetId: string;
    by: Actor;
    consumes?: string[];
  }): Artifact {
    ensureSeeded();
    // The tab's GOVERNED create flow only needs Creator+ — both humans and the
    // planner may scaffold a DRAFT. Promotion is gated separately in advance().
    if (input.by.role === 'participant') {
      throw new BetError('Scaffolding requires a Creator, Builder or Admin', 403);
    }
    return put({
      id: id(this.tab),
      tab: this.tab,
      title: input.title,
      domain: input.domain,
      visibility: 'personal', // draft → members-only until shared/promoted (OPA)
      lifecycle: 'planned',
      consumes: input.consumes ?? [],
      bigBetIds: [input.bigBetId],
      usage30d: 0,
      omFqn: `${this.tab}.${input.domain}.${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    });
  }

  tag(artifactId: string, bigBetId: string): Artifact | null {
    const a = this.get(artifactId);
    if (!a) return null;
    if (!a.bigBetIds.includes(bigBetId)) a.bigBetIds.push(bigBetId);
    return a;
  }

  untag(artifactId: string, bigBetId: string): Artifact | null {
    const a = this.get(artifactId);
    if (!a) return null;
    a.bigBetIds = a.bigBetIds.filter((b) => b !== bigBetId); // never deletes the artifact
    return a;
  }

  advance(artifactId: string, to: Lifecycle, by: Actor): Artifact {
    const a = this.get(artifactId);
    if (!a) throw new BetError(`Artifact ${artifactId} not found`, 404);
    if (isReady(to)) {
      // The human-ships invariant — enforced in code, not convention.
      if (by.kind === 'planner') {
        throw new BetError('The planner cannot promote/certify/go-live — a human (Builder/Admin) must', 403);
      }
      if (by.role !== 'builder' && by.role !== 'admin') {
        throw new BetError('Promote/certify/go-live requires a Builder or Admin', 403);
      }
      // Promotion shares the artifact to the bet's members' domain (OPA opens up).
      if (a.visibility === 'personal') a.visibility = to === 'certified' ? 'certified' : 'shared';
    }
    a.lifecycle = to;
    return a;
  }
}

// One source per tab, behind a lookup the rest of the spine uses.
const TABS: Tab[] = [
  'data',
  'metric',
  'dashboard',
  'software',
  'agent',
  'ml',
  'knowledge',
  'files',
  'connection',
];

const SOURCES = new Map<Tab, ComponentSource>(TABS.map((t) => [t, new MockSource(t)]));

export function sourceFor(tab: Tab): ComponentSource {
  const s = SOURCES.get(tab);
  if (!s) throw new BetError(`No source for tab '${tab}'`, 400);
  return s;
}

/** Resolve any artifact across all tabs (the bet doesn't always know the tab). */
export function resolveArtifact(artifactId: string): Artifact | null {
  ensureSeeded();
  return artifacts.get(artifactId) ?? null;
}

/** Every known artifact (for the composition map's lineage join). */
export function allArtifacts(): Artifact[] {
  ensureSeeded();
  return [...artifacts.values()];
}

// ------------------------------------------------ Strategy up-link (mock) ----

const metrics = new Map<string, BusinessMetric>();
const pillars = new Map<string, Pillar>();
let strategySeeded = false;

function ensureStrategy(): void {
  // A fresh tenant starts EMPTY. Strategy metrics and pillars are defined only
  // through the platform's own governed flows (e.g. the Northpeak seed).
  if (strategySeeded) return;
  strategySeeded = true;
}

export function __resetStrategy(): void {
  metrics.clear();
  pillars.clear();
  strategySeeded = false;
}

/** Test hook: register a strategy metric and/or pillar. Production seeds these
 *  through the governed Strategy flows; this lets tests inject fixtures. */
export function __seedStrategy(metric?: BusinessMetric, pillar?: Pillar): void {
  ensureStrategy();
  if (metric) metrics.set(metric.id, metric);
  if (pillar) pillars.set(pillar.id, pillar);
}

export function getPillar(pillarId: string): Pillar | null {
  ensureStrategy();
  return pillars.get(pillarId) ?? null;
}

export function getMetric(metricId: string): BusinessMetric | null {
  ensureStrategy();
  return metrics.get(metricId) ?? null;
}

/**
 * Resolve a metric's realized value for a viewer (RLS-scoped). Returns the
 * viewer's entitled `current` (or the default) plus the captured `baseline`.
 */
export function resolveMetric(
  metricId: string,
  viewerId: string,
): { current: number; baseline: number; unit: BusinessMetric['unit'] } | null {
  const m = getMetric(metricId);
  if (!m) return null;
  const current = m.rls?.[viewerId] ?? m.current;
  return { current, baseline: m.baseline, unit: m.unit };
}

export function listPillars(): Pillar[] {
  ensureStrategy();
  return [...pillars.values()];
}
