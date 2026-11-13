/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `OS-Object` / `OS-Objects` — the ONE place a commit's object attribution is decided
 * USER STORY: As an engineer I want "which commits touched this object" answered the same way by
 *             every read-back in the OS — the tab's own history, the generic object read-back and
 *             anything that comes later — so that a whole-subtree commit (the boot reconcile) is
 *             found by every system it carried and by none that it did not.
 * ARCHITECTURE:
 *   - PURE and core-only: records and strings in, booleans and strings out. No `server-only`, no
 *     git, no fs, no tab import — so it is callable from `core/infra/git-objects.ts`, from a tab's
 *     own history module, and from `node --test` without a harness.
 *   - TWO TRAILERS, ONE QUESTION. `OS-Object` carries ONE object as `<id>` or `<id> (<name>)` and
 *     is what a per-write commit sets. `OS-Objects` carries a SPACE-SEPARATED LIST of ids, for a
 *     commit that genuinely touched many — the boot reconcile writes a domain's whole `agents/`
 *     subtree in one commit, so it cannot name one object in `OS-Object` without lying about the
 *     rest (X-R1). A repeated `OS-Object` line is not an option: `parseTrailers` returns
 *     `Record<string, string>`, so N lines keep only the last.
 *   - WHOLE-TOKEN MATCHING is the invariant that makes the list safe: `sys_a` must not match
 *     `sys_ab`, and a substring test would. Every caller goes through {@link trailersNameObject}
 *     so no caller can get that wrong privately.
 *   - {@link renderObjectsTrailer} is the write half, and it REPORTS what it dropped rather than
 *     dropping it silently: an id carrying whitespace would break the trailer grammar, so it is
 *     skipped and named back to the caller, which logs it (review L-3).
 */

/** The single-object trailer a per-write commit sets. */
export const OBJECT_TRAILER = 'OS-Object';
/** The many-object trailer a whole-subtree commit sets (space-separated ids). */
export const OBJECTS_TRAILER = 'OS-Objects';

/** Whole-token membership of `id` in a space-separated trailer list. */
export function objectListNames(list: string | undefined | null, id: string): boolean {
  if (!id || !list) return false;
  return list.trim().split(/\s+/).includes(id);
}

/**
 * Does this commit's trailer set name `id`? True for the single-object trailer (`<id>` or
 * `<id> (<name>)`) and for whole-token membership of the many-object list.
 *
 * This is the predicate every read-back must use. `core/infra/git-objects.ts`'s `trailerNames`
 * and `tabs/agents/lib/git/history.ts`'s commit filter are both exactly this call.
 */
export function trailersNameObject(trailers: Record<string, string | undefined>, id: string): boolean {
  if (!id) return false;
  const single = trailers[OBJECT_TRAILER] ?? '';
  if (single === id || single.startsWith(`${id} `)) return true;
  return objectListNames(trailers[OBJECTS_TRAILER], id);
}

/**
 * The value for {@link OBJECTS_TRAILER}: sorted, de-duplicated, whitespace-free.
 *
 * `skipped` names every id that could not be written (it carries whitespace, which the trailer
 * grammar has no escape for). The caller LOGS those — an id silently missing from the
 * attribution would be the very defect X-R1 fixed, reintroduced quietly.
 */
export function renderObjectsTrailer(ids: Iterable<string>): { value: string; skipped: string[] } {
  const keep = new Set<string>();
  const skipped: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? '');
    if (!id) continue;
    if (/\s/.test(id)) {
      skipped.push(id);
      continue;
    }
    keep.add(id);
  }
  return { value: [...keep].sort().join(' '), skipped };
}
