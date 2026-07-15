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
  type Principal,
  type Tab,
  BetError,
  roleAtLeast,
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

// ---------------------------------------------- real per-tab reader (picker) --
//
// The picker ("Link existing") must surface the REAL artifacts a student built
// across the tabs — datasets, agents, dashboards, knowledge, files, metrics. Those
// stores are server-side, so a server module (`real-sources.ts`) registers a reader
// here via `setRealTabReader`, keeping THIS module free of server-only imports
// (unit tests without that module still work: no reader → in-memory only, as before).
export type RealTabReader = (tab: Tab, viewer: Principal) => Artifact[];
let realTabReaderFn: RealTabReader | null = null;
export function setRealTabReader(fn: RealTabReader | null): void {
  realTabReaderFn = fn;
}

/** The picker's canView predicate for an IN-MEMORY (scaffolded/registered) draft. */
function inMemoryVisible(a: Artifact, viewer: Principal): boolean {
  return viewer.role === 'admin' || a.visibility !== 'personal' || viewer.domains.includes(a.domain);
}

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

  list(opts?: { bigBetId?: string; domain?: string; viewer?: Principal }): Artifact[] {
    ensureSeeded();
    const viewer = opts?.viewer;
    const collected = new Map<string, Artifact>();

    // 1) REAL per-tab artifacts, already canView-scoped by each tab's own gate.
    if (viewer && realTabReaderFn) {
      for (const a of realTabReaderFn(this.tab, viewer)) {
        if (a.tab === this.tab) collected.set(a.id, a);
      }
    }
    // 2) In-memory scaffolded/registered drafts (the real store is the source of
    //    truth for anything with the same id, so it wins the dedupe).
    for (const a of artifacts.values()) {
      if (a.tab !== this.tab) continue;
      if (collected.has(a.id)) continue;
      if (viewer && !inMemoryVisible(a, viewer)) continue; // picker canView filter
      collected.set(a.id, a);
    }

    let out = [...collected.values()];
    if (opts?.bigBetId) out = out.filter((a) => a.bigBetIds.includes(opts.bigBetId!));
    if (opts?.domain) out = out.filter((a) => a.domain === opts.domain);
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
    if (input.by.role === 'creator') {
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
      if (!roleAtLeast(by.role, 'builder')) {
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

/** What the governed attach door passes in: the REAL artifact's reference card. */
export type LinkedArtifactInput = {
  id: string;
  tab: Tab;
  title: string;
  domain: string;
  visibility: Artifact['visibility'];
  lifecycle: Lifecycle;
  omFqn?: string;
};

/**
 * Register (or refresh) a REAL per-tab artifact as a linkable reference in this
 * registry — called by the governed `attach_component` door AFTER the caller has
 * resolved the id through the tab's OWN canView gate (getDataset/getDashboard/
 * getSystem). The per-tab store stays the single source of truth; this records
 * only the reference card the bet renders (id · title · tier · lifecycle),
 * preserving any existing bet tags. Nothing here bypasses governance: an id the
 * caller cannot see never reaches this function.
 */
export function registerLinkedArtifact(input: LinkedArtifactInput): Artifact {
  ensureSeeded();
  const existing = artifacts.get(input.id);
  if (existing) {
    // Refresh the reference card from the real store; keep bet tags + usage.
    existing.title = input.title;
    existing.visibility = input.visibility;
    existing.lifecycle = input.lifecycle;
    if (input.omFqn) existing.omFqn = input.omFqn;
    return existing;
  }
  return put({
    id: input.id,
    tab: input.tab,
    title: input.title,
    domain: input.domain,
    visibility: input.visibility,
    lifecycle: input.lifecycle,
    consumes: [],
    bigBetIds: [],
    usage30d: 0,
    omFqn: input.omFqn,
  });
}

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

/**
 * DURABLE, viewer-scoped resolve of a bet component's artifact.
 *
 * The in-memory `artifacts` map above is EPHEMERAL — it is repopulated only when a
 * component is attached (`registerLinkedArtifact`) or scaffolded this process, so
 * after any pod restart a bet's linked references cannot resolve through it. That
 * is why every component rendered "🔒 members only": a null resolution, not a real
 * access denial.
 *
 * The fix: when the in-memory map misses, read the REAL per-tab store through the
 * registered `RealTabReader` — the SAME governed `list(viewer)` gate the picker
 * uses, so the viewer only ever resolves what they may see (admin sees all; domain
 * members their domain; owners their own). This is the durable source of truth and
 * survives restarts. Returns null ONLY when the artifact genuinely does not exist
 * (or the viewer's own gate excludes it) — an honest "unavailable", distinct from
 * a members-only redaction.
 *
 * `tab` comes from the ComponentRef; the reader needs it to pick the right store.
 */
export function resolveArtifactFor(tab: Tab, artifactId: string, viewer: Principal): Artifact | null {
  ensureSeeded();
  // 1) In-memory (scaffolded drafts + anything registered this process). Still
  //    apply the picker's visibility filter so a non-member never resolves a
  //    personal draft they may not see.
  const inMem = artifacts.get(artifactId);
  if (inMem && inMem.tab === tab && inMemoryVisible(inMem, viewer)) return inMem;
  // 2) DURABLE fallback: the real per-tab store, already canView-scoped by the
  //    tab's own gate. Survives restarts (the reference card is derived live).
  if (realTabReaderFn) {
    for (const a of realTabReaderFn(tab, viewer)) {
      if (a.id === artifactId && a.tab === tab) return a;
    }
  }
  // 3) In-memory hit that the viewer may NOT see (personal draft, other domain) —
  //    return it so the visibility gate above can redact ("members only") rather
  //    than mislabel it "unavailable". A genuine miss falls through to null.
  return inMem && inMem.tab === tab ? inMem : null;
}

/** Every known artifact (for the composition map's lineage join). */
export function allArtifacts(): Artifact[] {
  ensureSeeded();
  return [...artifacts.values()];
}

// ------------------------------------------------ Strategy up-link (mock) ----
//
// These functions are the Strategy seam that the rest of the BigBets spine
// reads (value calc, server view, tests). In production the REAL data lives in
// lib/strategy/pillars.ts — pinned to globalThis[Symbol.for('soa.strategy.pillars')]
// — which this module reads WITHOUT importing the server-only module (so it
// stays unit-testable in Node tests with no Next.js context). When the real
// cache is present it takes precedence; the phantom Maps below are fallback
// for unit tests that seed data via __seedStrategy.

const metrics = new Map<string, BusinessMetric>();
const pillars = new Map<string, Pillar>();
let strategySeeded = false;

function ensureStrategy(): void {
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

// ---------- globalThis adapter (no server-only import, no async) ----------

type RealStrategyState = {
  cache: Map<string, {
    id: string;
    name: string;
    scope: string;
    domain: string;
    metrics: { cube: string; measure: string; title: string; basis: string; seedTotal: number; baseline?: number }[];
    valueMetric?: { name: string; description: string };
  }> | null;
};

function realStrategyCache(): RealStrategyState['cache'] | null {
  const KEY = Symbol.for('soa.strategy.pillars');
  const g = globalThis as unknown as Record<symbol, RealStrategyState | undefined>;
  return g[KEY]?.cache ?? null;
}

/**
 * The GOVERNED business-metric catalogue (Metrics tab → Cube), pinned to
 * globalThis by lib/strategy/pillars.ts at module load. This is the REAL metric
 * registry a bet's linked metric resolves against even when the metric is not yet
 * attached to a pillar — so a bet wired to a real Cube measure shows a real number,
 * never a misleading €0. Read WITHOUT importing the server module (no coupling).
 */
type CatalogueMetric = { measure: string; title: string; seedTotal: number; baseline?: number };
function realMetricCatalogue(): CatalogueMetric[] | null {
  const KEY = Symbol.for('soa.strategy.metric-catalogue');
  const g = globalThis as unknown as Record<symbol, CatalogueMetric[] | undefined>;
  return g[KEY] ?? null;
}

function metricFromCatalogue(metricId: string): BusinessMetric | null {
  const cat = realMetricCatalogue();
  if (!cat) return null;
  const m = cat.find((c) => c.measure === metricId);
  if (!m) return null;
  return {
    id: m.measure,
    name: m.title,
    cubeMeasure: m.measure,
    unit: '€',
    baseline: m.baseline ?? 0,
    current: m.seedTotal,
  };
}

/**
 * Read the real strategy store (no import, reads globalThis directly). Returns
 * null when the cache hasn't been initialised yet (unit tests without a Next.js
 * context, or the first request before any strategy route has run).
 */
function readRealStrategy(): { pillars: Pillar[]; metricsByMeasure: Map<string, BusinessMetric> } | null {
  const cache = realStrategyCache();
  if (!cache) return null;

  const out: Pillar[] = [];
  const metricsByMeasure = new Map<string, BusinessMetric>();

  for (const p of cache.values()) {
    const firstMetric = p.metrics[0];
    // metricId for the bigbets spine: prefer Cube measure (stable, unique); fall
    // back to a synthetic id for value-metric-only pillars.
    const metricId = firstMetric?.measure ?? (p.valueMetric?.name ? `vm_${p.id}` : '');
    out.push({
      id: p.id,
      name: p.name,
      scope: p.scope as 'tenant' | 'domain',
      domain: p.domain,
      metricId,
    });
    for (const m of p.metrics) {
      if (!metricsByMeasure.has(m.measure)) {
        metricsByMeasure.set(m.measure, {
          id: m.measure,
          name: m.title,
          cubeMeasure: m.measure,
          unit: '€',
          baseline: m.baseline ?? 0,
          current: m.seedTotal,
        });
      }
    }
  }
  return { pillars: out, metricsByMeasure };
}

export function getPillar(pillarId: string): Pillar | null {
  ensureStrategy();
  // Real store first — populated by any strategy route that ran this request. If the
  // real cache is warm but lacks this id, STILL fall back to the phantom map: in
  // production the phantom is empty (no-op), while in unit tests another suite may
  // have warmed the real cache without the fixture seeded via __seedStrategy.
  const real = readRealStrategy();
  const fromReal = real ? (real.pillars.find((p) => p.id === pillarId) ?? null) : null;
  return fromReal ?? pillars.get(pillarId) ?? null;
}

export function getMetric(metricId: string): BusinessMetric | null {
  ensureStrategy();
  // Try the phantom map first (unit tests inject BusinessMetric objects directly).
  const phantom = metrics.get(metricId);
  if (phantom) return phantom;
  // Then the real strategy store — pillar metrics resolved by measure id.
  const real = readRealStrategy();
  const fromPillar = real ? real.metricsByMeasure.get(metricId) ?? null : null;
  if (fromPillar) return fromPillar;
  // Finally the governed metric CATALOGUE: a bet may link a real Cube measure that
  // isn't attached to any pillar yet — it still resolves to a real value here.
  return metricFromCatalogue(metricId);
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
  // Real store first (populated by any strategy route on this process).
  const real = readRealStrategy();
  if (real) return real.pillars;
  // Phantom fallback (unit tests).
  return [...pillars.values()];
}
