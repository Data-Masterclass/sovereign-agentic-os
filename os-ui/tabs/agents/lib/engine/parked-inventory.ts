/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Parked-run inventory — which parked runs wait on a current interrupt, which on a
 *             pre-WP-26 one (read-only, logged at worker boot)
 * USER STORY: As the operator rolling out WP-26 I want, before and after the deploy, the list of
 *             runs that are parked and how each one will resume: a current interrupt (normal), a
 *             pre-WP-26 interrupt with ONE call in its batch (the one-release shim resumes it), or
 *             a pre-WP-26 batch with several calls (decide it on the old image first, or it is
 *             cancelled visibly when its decision arrives).
 * ARCHITECTURE:
 *   - Reads only. The parked run ids come from `run_jobs` (status `parked`); each thread's pending
 *     interrupts come from LangGraph's own checkpointer (`getTuple` → `pendingWrites` on the
 *     `__interrupt__` channel), the batch from the checkpointed `current` channel. Nothing is
 *     written, resumed or cancelled here.
 *   - The worker logs one summary line plus one line per pre-WP-26 run
 *     (`parked-inventory runId=… kind=legacy interrupts=… batchCalls=…`).
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { isHoldInterrupt, isLegacyHoldInterrupt } from '@tabs/agents/lib/engine/build-graph';

/**
 * `current` = waits on a WP-26 interrupt. `legacy` = waits on a pre-WP-26 interrupt: the shim
 * resumes it when its batch holds ONE call, and refuses (`legacy_multi_hold`, the run is cancelled
 * visibly) when it holds more — `batchCalls` > 1 is the one to decide on the old image first.
 */
export type ParkedKind = 'current' | 'legacy' | 'no-interrupt';
export type ParkedEntry = { runId: string; kind: ParkedKind; interrupts: number; batchCalls: number };

/** Classify each parked thread from its latest checkpoint. Read-only. */
export async function inventoryParked(saver: BaseCheckpointSaver, parkedRunIds: readonly string[]): Promise<ParkedEntry[]> {
  const out: ParkedEntry[] = [];
  for (const runId of parkedRunIds) {
    const tuple = await saver.getTuple({ configurable: { thread_id: runId } });
    const values = (tuple?.pendingWrites ?? [])
      .filter(([, channel]) => channel === '__interrupt__')
      .flatMap(([, , v]) => (Array.isArray(v) ? v : [v]))
      .map((i) => (i as { value?: unknown }).value);
    const current = (tuple?.checkpoint.channel_values as { current?: { pending?: unknown[] } } | undefined)?.current;
    const batchCalls = current?.pending?.length ?? 0;
    const legacy = values.filter(isLegacyHoldInterrupt).length;
    const fresh = values.filter(isHoldInterrupt).length;
    const kind: ParkedKind = legacy > 0 ? 'legacy' : fresh > 0 ? 'current' : 'no-interrupt';
    out.push({ runId, kind, interrupts: legacy + fresh, batchCalls });
  }
  return out;
}

/** The log lines for an inventory: one summary, one line per run that is not `current`. */
export function inventoryLines(entries: readonly ParkedEntry[]): string[] {
  const count = (k: ParkedKind) => entries.filter((e) => e.kind === k).length;
  const lines = [`parked-inventory total=${entries.length} current=${count('current')} legacy=${count('legacy')} legacy-batch-gt1=${entries.filter((e) => e.kind === 'legacy' && e.batchCalls > 1).length} no-interrupt=${count('no-interrupt')}`];
  for (const e of entries) if (e.kind !== 'current') lines.push(`parked-inventory runId=${e.runId} kind=${e.kind} interrupts=${e.interrupts} batchCalls=${e.batchCalls}`);
  return lines;
}

/** The minimum of `pg.Pool` the inventory reads with. */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: { run_id: string }[] }> };

/** Parked run ids from `run_jobs` (oldest first, bounded). Read-only. */
export async function parkedRunIds(db: Queryable, limit = 500): Promise<string[]> {
  const { rows } = await db.query(`SELECT run_id FROM run_jobs WHERE status = 'parked' ORDER BY updated_at ASC LIMIT $1`, [limit]);
  return rows.map((r) => r.run_id);
}
