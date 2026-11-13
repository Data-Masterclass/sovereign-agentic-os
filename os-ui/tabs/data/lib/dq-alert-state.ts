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
 *   - A mirror that cannot be read means no state, which means the FIRST read after a restart may
 *     re-alert. That is the deliberate direction of the trade: a duplicate notification is
 *     recoverable, a missed failure is not.
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
