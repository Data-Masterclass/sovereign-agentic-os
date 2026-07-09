/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import {
  type Pillar,
  type ArtifactKind,
  type Trend,
  type Quarter,
  ARTIFACT_KINDS,
  canEditPillar,
  trendFor,
  yearFraction,
  currentQuarter,
  monthKey,
} from '@/lib/strategy/model';
import { rollupForPillar } from '@/lib/strategy/value-rollup';
import { adoptionActuals } from '@/lib/strategy/adoption';
import { auditStrategy } from '@/lib/strategy/audit';
import { osMirror } from '../infra/os-mirror.ts';

/**
 * Monthly actuals snapshots + the target-vs-actual view (annual + quarterly).
 *
 * Strategy sets ANNUAL north-star targets with QUARTERLY sub-targets; ACTUALS are
 * snapshotted MONTHLY for reporting + trend. The live actual is always derived
 * (value from the roll-up's governed metric; people + certified counts from the
 * adoption board) — snapshots just capture that derived number each month so the
 * trend (on-track / behind) has history. Nothing here is hand-kept.
 */

export type ActualSet = {
  valueGenerated: number;
  activeCreators: number;
  activeBuilders: number;
  certified: Record<ArtifactKind, number>;
};

export type Snapshot = ActualSet & {
  pillarId: string;
  month: string; // YYYY-MM
  at: string;
};

// In-process snapshot store keyed by pillarId → month → snapshot. Authoritative
// locally (mirrors the registry's offline cache); a real deploy can mirror it.
// Pinned to globalThis so every route-handler module instance shares the same Map.
type SnapshotsState = { store: Map<string, Map<string, Snapshot>>; hydration: Promise<void> | null };
const SNAPS_KEY = Symbol.for('soa.strategy.snapshots');
function snapshotsState(): SnapshotsState {
  const g = globalThis as unknown as Record<symbol, SnapshotsState | undefined>;
  if (!g[SNAPS_KEY]) g[SNAPS_KEY] = { store: new Map(), hydration: null };
  return g[SNAPS_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-strategy-snapshots',
  createBody: {
    mappings: {
      properties: {
        pillarId: { type: 'keyword' },
        month: { type: 'keyword' },
        at: { type: 'date' },
        valueGenerated: { type: 'double' },
        activeCreators: { type: 'integer' },
        activeBuilders: { type: 'integer' },
        certified: { type: 'object', enabled: false },
      },
    },
  },
});

function writeThrough(snap: Snapshot): void {
  mirror.writeThrough(`${snap.pillarId}:${snap.month}`, snap);
}

export async function ensureHydrated(): Promise<void> {
  const s = snapshotsState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = snapshotsState();
  const docs = (await mirror.hydrate(5000)) ?? [];
  for (const snap of docs as Snapshot[]) {
    if (!snap || !snap.pillarId || !snap.month) continue;
    if (!s.store.has(snap.pillarId)) s.store.set(snap.pillarId, new Map());
    const byMonth = s.store.get(snap.pillarId)!;
    if (!byMonth.has(snap.month)) byMonth.set(snap.month, snap);
  }
}

/** Compute the live actuals for a pillar (the number a snapshot captures). */
export async function liveActuals(pillar: Pillar): Promise<ActualSet> {
  const [rollup, adoption] = await Promise.all([
    rollupForPillar(pillar), // full governed total (unscoped) — the realized value
    adoptionActuals(pillar.scope === 'tenant' ? 'tenant' : pillar.domain),
  ]);
  return {
    valueGenerated: rollup.total,
    activeCreators: adoption.activeCreators,
    activeBuilders: adoption.activeBuilders,
    certified: adoption.certified,
  };
}

/** Capture a monthly snapshot of the live actuals (Builder/Admin, audited). */
export async function recordSnapshot(user: CurrentUser, pillar: Pillar): Promise<Snapshot> {
  if (!canEditPillar(user, pillar)) {
    const e = new Error('Only a Builder (domain) or Admin (tenant) can snapshot actuals');
    (e as Error & { status?: number }).status = 403;
    throw e;
  }
  const actuals = await liveActuals(pillar);
  const month = monthKey();
  const snap: Snapshot = { pillarId: pillar.id, month, at: new Date().toISOString(), ...actuals };
  const snapStore = snapshotsState().store;
  let byMonth = snapStore.get(pillar.id);
  if (!byMonth) { byMonth = new Map(); snapStore.set(pillar.id, byMonth); }
  byMonth.set(month, snap);
  writeThrough(snap);
  await auditStrategy({
    action: 'actuals.snapshot',
    actor: user.id,
    domain: pillar.domain,
    pillarId: pillar.id,
    pillarName: pillar.name,
    detail: { month, valueGenerated: actuals.valueGenerated },
  });
  return snap;
}

/** Snapshot history for a pillar, oldest → newest. */
export function snapshotHistory(pillarId: string): Snapshot[] {
  const byMonth = snapshotsState().store.get(pillarId);
  if (!byMonth) return [];
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// --------------------------------------------------- Target vs actual view -----

export type MetricProgress = {
  key: string;
  label: string;
  unit: 'eur' | 'count';
  annualTarget: number;
  quarterTarget: number;
  quarter: Quarter;
  actual: number;
  trend: Trend;
  /** actual / annualTarget, clamped to [0,1] for the bar. */
  pct: number;
};

export type TargetsVsActuals = {
  pillarId: string;
  hasTargets: boolean;
  asOfMonth: string;
  /** Headline rows (value + people). */
  rows: MetricProgress[];
  /** Certified-by-kind rows. */
  certified: MetricProgress[];
  history: Snapshot[];
};

function progress(
  key: string,
  label: string,
  unit: 'eur' | 'count',
  annualTarget: number,
  quarterTarget: number,
  quarter: Quarter,
  actual: number,
  yf: number,
): MetricProgress {
  return {
    key,
    label,
    unit,
    annualTarget,
    quarterTarget,
    quarter,
    actual,
    trend: trendFor(actual, annualTarget, yf),
    pct: annualTarget > 0 ? Math.min(1, Math.max(0, actual / annualTarget)) : 0,
  };
}

/** Build the annual+quarterly target-vs-actual view for a pillar. */
export async function targetsVsActuals(pillar: Pillar): Promise<TargetsVsActuals> {
  const actuals = await liveActuals(pillar);
  const yf = yearFraction();
  const q = currentQuarter();
  const t = pillar.targets;

  if (!t) {
    return {
      pillarId: pillar.id,
      hasTargets: false,
      asOfMonth: monthKey(),
      rows: [],
      certified: [],
      history: snapshotHistory(pillar.id),
    };
  }

  const rows: MetricProgress[] = [
    progress('value', 'Value generated', 'eur', t.valueGenerated.annual, t.valueGenerated.quarterly[q], q, actuals.valueGenerated, yf),
    progress('creators', 'Active Creators', 'count', t.activeCreators.annual, t.activeCreators.quarterly[q], q, actuals.activeCreators, yf),
    progress('builders', 'Active Builders', 'count', t.activeBuilders.annual, t.activeBuilders.quarterly[q], q, actuals.activeBuilders, yf),
  ];

  const certified: MetricProgress[] = ARTIFACT_KINDS.map((k) =>
    progress(`certified.${k}`, k, 'count', t.certified[k].annual, t.certified[k].quarterly[q], q, actuals.certified[k], yf),
  );

  return {
    pillarId: pillar.id,
    hasTargets: true,
    asOfMonth: monthKey(),
    rows,
    certified,
    history: snapshotHistory(pillar.id),
  };
}

/** Test seam: clear snapshot history. */
export function __resetSnapshotsForTests(): void {
  const s = snapshotsState();
  s.store.clear();
  s.hydration = null;
  mirror.__reset();
}
