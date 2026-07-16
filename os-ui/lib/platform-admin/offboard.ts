/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';

/**
 * Governed offboard support (Platform Admin → Users & Access, Admin-only).
 *
 * When a user is offboarded the admin may choose to REASSIGN their personal
 * "My artifacts" to another owner instead of deleting them with the account.
 * `reassignOwner` transfers the offboarded user's PERSONAL-lane records (owner-
 * only, un-promoted) to the target owner across every artifact store that has a
 * clear owner field, then reports what moved.
 *
 * SAFETY: this only moves personal-lane artifacts (shared / domain / certified
 * assets are governed collective property and are NEVER silently reassigned). A
 * store that throws is reported under `failed` so the caller NEVER silently
 * orphans an artifact — the offboard route surfaces the report to the admin.
 *
 * Covered here: data, files, knowledge, agents, software. Metrics derive from the
 * data store (a metric has no independent owner — it belongs to its dataset), so
 * reassigning datasets moves the owner's metrics too. Dashboards, big bets and
 * science carry their own owner fields but are DEFERRED for a follow-up pass and
 * listed under `deferred` so the caller can warn the admin.
 */

import { reassignOwner as reassignData } from '@/lib/data/store';
import { reassignOwner as reassignFiles } from '@/lib/files';
import { reassignOwner as reassignKnowledge } from '@/lib/knowledge';
import { reassignOwner as reassignAgents } from '@/lib/agents/store';
import { reassignOwner as reassignSoftware } from '@/lib/software';

export type ReassignReport = {
  /** Personal-lane artifacts moved, per store (only stores that moved ≥1). */
  moved: Record<string, number>;
  /** Stores that threw — the artifacts there were NOT reassigned. Never silent. */
  failed: Record<string, string>;
  /** Owner-bearing stores intentionally not covered in this pass. */
  deferred: string[];
  total: number;
};

type StoreReassign = { store: string; run: (from: string, to: string) => number | Promise<number> };

const STORES: StoreReassign[] = [
  { store: 'data', run: reassignData },
  { store: 'files', run: reassignFiles },
  { store: 'knowledge', run: reassignKnowledge },
  { store: 'agents', run: reassignAgents },
  { store: 'software', run: reassignSoftware },
];

const DEFERRED = ['dashboards', 'bigbets', 'science'];

/**
 * Transfer every PERSONAL-lane artifact owned by `fromId` to `toId` across the
 * covered stores. Best-effort per store: one store failing does not abort the
 * others, but its failure is recorded so the caller can warn the admin before /
 * after deletion. Returns a full report.
 */
export async function reassignOwner(fromId: string, toId: string): Promise<ReassignReport> {
  const moved: Record<string, number> = {};
  const failed: Record<string, string> = {};
  let total = 0;
  for (const { store, run } of STORES) {
    try {
      const n = await run(fromId, toId);
      if (n > 0) { moved[store] = n; total += n; }
    } catch (e) {
      failed[store] = (e as Error).message || 'reassign failed';
    }
  }
  return { moved, failed, deferred: DEFERRED, total };
}
