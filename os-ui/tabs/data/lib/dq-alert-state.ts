/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    The persisted "already told the owner" record behind the DQ alert (B4 review L-2)
 * USER STORY: As a dataset owner I want ONE notification per quality incident — not one per page
 *             view of the dataset, and not none at all because the only sender was deleted.
 * ARCHITECTURE:
 *   - The alert now fires from a READ (the Dagster asset-check read-back), which can happen many
 *     times a minute and in any pod. So "has the owner been told about THIS failure" has to be
 *     durable, not process-local: one small doc per dataset in its own OpenSearch index
 *     (`config.dqAlertsIndex`), through the same `osMirror` boundary `core/infra/git-mirror.ts`
 *     uses — in-process map authoritative, fire-and-forget write-through, hydration retried and
 *     never cached as done.
 *   - `ranAt` is the idempotency key: the same check execution never alerts twice, even if the
 *     badge is still `failing` when the next read lands.
 *   - SEVERAL REPLICAS. The in-process map above is each pod's own view and its write-through is
 *     fire-and-forget, so it can NOT decide who sends. That is `claimDqAlert`: a create-only
 *     (compare-and-set) write of one doc per (dataset, rule, ranAt) into a second index
 *     (`config.dqAlertClaimsIndex`). OpenSearch answers 201 to the first pod and 409 to every other,
 *     so one pod sends a given alert however many pods read the same execution. `freshDqAlertRecord`
 *     re-reads the shared record before a decision, so a pod hydrated long ago does not judge a
 *     transition against a stale badge.
 *   - A claim store that cannot be reached is `unreachable`: the caller sends nothing and does NOT mark
 *     the run seen, so the next read retries. A delayed alert, never a duplicate and never a lost one.
 *   - A state mirror that cannot be read at boot means no state, so the first read may re-claim; the
 *     claim itself still holds the line.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { osMirror } from '@core/infra/os-mirror';

export type DqAlertRecord = {
  datasetId: string;
  /** The badge of the last run this module SAW (not only the last it alerted on) —
   *  `QualityBadge`, written out so this module imports no type from the read path. */
  lastBadge: 'passing' | 'failing' | 'unknown';
  /** `ranAt` of that run — the idempotency key. */
  lastRanAt: string;
  /** When an alert was last delivered, or undefined if never. */
  lastAlertedAt?: string;
};

type State = { byDataset: Map<string, DqAlertRecord>; hydration: Promise<void> | null };

const KEY = Symbol.for('soa.data.dq-alerts');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { byDataset: new Map(), hydration: null };
  return g[KEY]!;
}

const durable = osMirror({ index: config.dqAlertsIndex });
const claims = osMirror({ index: config.dqAlertClaimsIndex });

export type DqAlertClaim = { datasetId: string; rule: string; ranAt: string };

/**
 * Compare-and-set on the shared store: 'won' for exactly one caller per (dataset, rule, ranAt),
 * 'lost' for every later one, 'unreachable' when nothing can be concluded (never treated as a win).
 */
export async function claimDqAlert(k: DqAlertClaim): Promise<'won' | 'lost' | 'unreachable'> {
  const id = JSON.stringify([k.datasetId, k.rule, k.ranAt]);
  const r = await claims.createDoc(id, { datasetId: k.datasetId, rule: k.rule, ranAt: k.ranAt, claimedAt: new Date().toISOString() });
  return r === 'created' ? 'won' : r === 'exists' ? 'lost' : 'unreachable';
}

/** The shared record of a dataset when it is newer than this pod's copy; else this pod's copy. */
export async function freshDqAlertRecord(datasetId: string): Promise<DqAlertRecord | null> {
  const local = dqAlertRecord(datasetId);
  const r = await durable.read(datasetId);
  if (r.state !== 'found') return local;
  const doc = r.doc as DqAlertRecord;
  if (!doc || doc.datasetId !== datasetId) return local;
  if (!local || doc.lastRanAt >= local.lastRanAt) {
    state().byDataset.set(datasetId, doc);
    return doc;
  }
  return local;
}

/** Load the records once (idempotent; a failed hydration is retried, never cached as done). */
export async function ensureDqAlertsHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = await durable.hydrate(1000);
      if (docs === null) {
        s.hydration = null;
        return;
      }
      for (const doc of docs as DqAlertRecord[]) {
        if (doc && doc.datasetId && !s.byDataset.has(doc.datasetId)) s.byDataset.set(doc.datasetId, doc);
      }
    })();
  }
  return s.hydration;
}

export function dqAlertRecord(datasetId: string): DqAlertRecord | null {
  return state().byDataset.get(datasetId) ?? null;
}

export function putDqAlertRecord(rec: DqAlertRecord): void {
  state().byDataset.set(rec.datasetId, rec);
  durable.writeThrough(rec.datasetId, rec);
}

/** Test seam: forget everything this process learned. */
export function __resetDqAlerts(): void {
  const s = state();
  s.byDataset.clear();
  s.hydration = null;
}
