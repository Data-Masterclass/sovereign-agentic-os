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
 * The two reserved keys the SDK's `os.records.update`/`remove` stamp onto a superseding append,
 * so the store stays APPEND-ONLY (durable + auditable) while the app FEELS mutable:
 *   `_key`      — the LOGICAL row this append supersedes (the original add's store id). Absent on a
 *                 plain `add`, which is therefore its own singleton (keyed by its own `id`).
 *   `_deleted`  — a tombstone: the row's latest append being `_deleted:true` hides it from the view
 *                 (reversible — a later non-deleted append for the same key brings it back).
 * These are the ONLY reserved keys; every other field is the app's own opaque payload.
 */
export const RECORD_KEY = '_key';
export const RECORD_DELETED = '_deleted';

/** The logical key an append collapses under: its `_key` (a supersede) else its own `id` (a fresh row). */
export function recordKey(r: AppendedRecord): string {
  const k = str(r[RECORD_KEY]);
  return k !== '' ? k : str(r.id);
}

/**
 * Collapse an append log to its CURRENT rows — the generalized reducer behind the in-place-edit
 * patterns (editable-grid, kanban, action-detail). For each logical key ({@link recordKey}) the
 * LATEST append wins (by `at` ISO; ties → later log position, matching an append log); a row whose
 * winning append is a `_deleted` tombstone is omitted. Output is ordered by each row's EARLIEST
 * append (creation order), so a row keeps its place across edits instead of jumping on every save.
 * Reserved keys are STRIPPED from the returned rows — callers see only the app's own fields + `id`.
 * Pure + unit-tested; renderers just present the result.
 */
export function reduceByKey(records: AppendedRecord[]): AppendedRecord[] {
  const winner = new Map<string, AppendedRecord>();
  const winnerAt = new Map<string, string>();
  const firstAt = new Map<string, string>();
  const order: string[] = [];
  for (const r of records) {
    const key = recordKey(r);
    if (key === '') continue; // no id and no _key → not addressable, skip
    const at = str(r.at);
    if (!firstAt.has(key)) {
      order.push(key);
      firstAt.set(key, at);
    } else if (at !== '' && at < (firstAt.get(key) as string)) {
      firstAt.set(key, at); // an earlier append than any seen → that's the true creation time
    }
    const prevAt = winnerAt.get(key);
    // Later-or-equal `at` wins → equal/blank `at` falls to log order (this record, seen later, wins).
    if (prevAt !== undefined && at < prevAt) continue;
    winner.set(key, r);
    winnerAt.set(key, at);
  }
  const out: AppendedRecord[] = [];
  for (const key of [...order].sort((a, b) => str(firstAt.get(a)).localeCompare(str(firstAt.get(b))))) {
    const r = winner.get(key);
    if (!r) continue;
    if (r[RECORD_DELETED] === true || r[RECORD_DELETED] === 'true') continue; // tombstoned → hidden
    const { [RECORD_KEY]: _k, [RECORD_DELETED]: _d, ...clean } = r; // strip reserved keys from the view
    out.push({ ...clean, id: key }); // expose the LOGICAL key as `id` so edits target the right row
  }
  return out;
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
