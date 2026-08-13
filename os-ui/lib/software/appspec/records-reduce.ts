/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE reducers over the app's OWN append-only `os.records` log (Track 2, Phase 3.5c).
 *
 * The interactive patterns write via `os.records.add` ONLY — the SDK exposes no `update`/`delete`
 * (see DESIGN.md "the write door"). So state that FEELS mutable (a decision on an item, a task's
 * done-flag) is DERIVED by reducing the append log: the LATEST append for a given key wins. These
 * helpers are the single, unit-tested source of that derivation — the renderers just present them.
 *
 * A record append carries whatever the pattern wrote (`{ itemId, decision, reason, by, at }` for a
 * decision; `{ taskId, done, by, at }` for a completion) plus the store-stamped `id`. `at` is an
 * ISO timestamp the renderer stamps at write time; when two appends share a key we prefer the one
 * with the later `at` (ties broken by array order — later append wins, matching an append log).
 */

/** One appended record as `os.records.list()` returns it: an open bag with a stamped `id`. */
export type AppendedRecord = { id?: string | number; [k: string]: unknown };

/** Read a field as a trimmed string (null/undefined/non-string → ''). */
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Reduce the append log to the LATEST decision per `itemId`. A decision append looks like
 * `{ itemId, decision, reason?, by?, at? }`. Appends missing an `itemId` or a `decision` are
 * ignored (not a decision). Later `at` wins; equal/absent `at` falls back to log order (last wins).
 */
export type Decision = { decision: string; reason: string; by: string; at: string };

export function latestDecisions(records: AppendedRecord[]): Map<string, Decision> {
  const out = new Map<string, Decision>();
  const atOf = new Map<string, string>();
  for (const r of records) {
    const itemId = str(r.itemId);
    const decision = str(r.decision);
    if (itemId === '' || decision === '') continue; // not a decision append
    const at = str(r.at);
    const prevAt = atOf.get(itemId);
    // Later-or-equal `at` wins → log order breaks ties (last append wins).
    if (prevAt !== undefined && at < prevAt) continue;
    out.set(itemId, { decision, reason: str(r.reason), by: str(r.by), at });
    atOf.set(itemId, at);
  }
  return out;
}

/** The latest decision for one item, or null if none has been recorded. */
export function decisionFor(records: AppendedRecord[], itemId: string): Decision | null {
  return latestDecisions(records).get(itemId) ?? null;
}

/**
 * Reduce the append log to the set of DONE task ids. A completion append looks like
 * `{ taskId, done, by?, at? }`. The LATEST append per `taskId` decides the flag (so a later
 * `done:false` un-checks an earlier `done:true`). Later `at` wins; ties fall back to log order.
 */
export function doneTaskIds(records: AppendedRecord[]): Set<string> {
  const latest = new Map<string, { done: boolean; at: string }>();
  for (const r of records) {
    const taskId = str(r.taskId);
    if (taskId === '' || r.done === undefined) continue; // not a completion append
    const done = r.done === true || r.done === 'true';
    const at = str(r.at);
    const prev = latest.get(taskId);
    if (prev !== undefined && at < prev.at) continue;
    latest.set(taskId, { done, at });
  }
  const out = new Set<string>();
  for (const [taskId, v] of latest) if (v.done) out.add(taskId);
  return out;
}

/** Is this task currently done, per the append log? */
export function isTaskDone(records: AppendedRecord[], taskId: string): boolean {
  return doneTaskIds(records).has(taskId);
}

/**
 * Pull the app's own records out of a `records.list()` result. The list door answers
 * `{ source, items:[{ id, ...record }] }` (see lib/software/app-records.ts). A demo-seed or a
 * shape without `items` yields `[]` — HONEST: no fabricated rows, the UI just shows "nothing yet".
 */
export function recordsFromList(result: unknown): AppendedRecord[] {
  const items = (result as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is AppendedRecord => !!x && typeof x === 'object' && !Array.isArray(x));
}
