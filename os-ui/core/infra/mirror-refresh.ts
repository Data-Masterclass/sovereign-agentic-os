/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The agent worker re-reads a store's shared mirror, so an agent sees current data
 * USER STORY: As a user I create a dataset, a workflow, a dashboard or a connection in the web app,
 *             or delete one, and an agent run that starts a minute later sees exactly that — not
 *             the state the worker pod happened to load when it booted.
 * ARCHITECTURE:
 *   - THE PROBLEM: every store keeps an in-process Map hydrated ONCE from its OpenSearch mirror
 *     (`os-mirror.ts`). `os-ui` (the web app) writes; `os-ui-worker` runs the agents and reads its
 *     own Map. Without a refresh the worker never sees a record created after its boot and keeps
 *     serving records deleted since.
 *   - THE MECHANISM (one, shared by every store; first built in the files store, PR #112): a
 *     process that declared itself a reader re-lists the mirror before serving, at most once per
 *     {@link MIRROR_REFRESH_MIN_MS}. Every door already awaits the store's `ensureHydrated()` (the
 *     MCP dispatcher before each `tools/call`), so that is the one seam a store wires.
 *   - NEWER WINS by the record's own `updatedAt`: a mirror copy replaces the held record only when
 *     strictly newer, so a record this process just wrote (fire-and-forget mirror write still in
 *     flight) is never rolled back by a listing that raced it.
 *   - DELETES PROPAGATE SAFELY: a held record is dropped only when (1) the listing is COMPLETE
 *     (`osMirror.list`: every shard, no timeout, as many docs as the index holds), (2) an earlier
 *     listing or the boot hydration DID contain it — a record this process created and whose write
 *     has not landed is never dropped — and (3) it is absent from {@link MIRROR_ABSENT_CONFIRMATIONS}
 *     complete listings in a row. A record THIS process deleted is tombstoned (`deletedHere`) so a
 *     listing read before the delete landed cannot bring it back; the tombstone clears once a
 *     complete listing agrees.
 *   - HONEST DEGRADE: an unreachable mirror or a partial listing changes nothing that is held, and
 *     says so once (one log line per outage, not one per request).
 *   - OFF unless switched on: the web app is the writer and never re-reads (no extra mirror
 *     traffic per request). The run worker switches it on at boot (`worker/agent-runs.ts`), and a
 *     store's `enable` refuses outside the run worker (`process-role.ts`) unless told otherwise.
 *   - Kept free of `server-only`/Next imports and of `node:` modules, so it is unit-testable.
 */
import type { OsMirror } from '@core/infra/os-mirror';
import { isRunWorkerProcess } from '@core/kernel/process-role';

/** Re-read the mirror at most this often per store. */
export const MIRROR_REFRESH_MIN_MS = 5000;
/** Complete listings in a row an id must be absent from before this process drops its record. */
export const MIRROR_ABSENT_CONFIRMATIONS = 2;

/** Per-store refresh bookkeeping. Kept INSIDE the store's own `globalThis` state, so each process
 *  (and each simulated process in tests) has its own. */
export type MirrorRefreshState = {
  enabled: boolean;
  refreshedAt?: number;
  refreshing: Promise<void> | null;
  /** Ids a mirror listing (or the boot hydration) has contained — only these may later be dropped. */
  listed: Set<string>;
  /** Consecutive COMPLETE listings each listed id was absent from. */
  missing: Map<string, number>;
  /** Ids this process deleted that a listing must not bring back. */
  deletedHere: Set<string>;
  /** One log line per degraded stretch, not one per request. */
  degradedLogged: boolean;
};

export function newMirrorRefresh(): MirrorRefreshState {
  return { enabled: false, refreshing: null, listed: new Set(), missing: new Map(), deletedHere: new Set(), degradedLogged: false };
}

type Doc = { id?: unknown; updatedAt?: unknown };

/** How one store applies a refresh to its own in-process state. */
export type RefreshTarget<R> = {
  /** Log prefix, e.g. `files`. */
  label: string;
  /** Max docs per listing (the store's hydrate size). */
  size?: number;
  /** Shape check for a listed doc this process may hold (files: has a `yaml` string). A doc that
   *  fails it still counts as PRESENT for delete detection. Default: has a string id. */
  accept?(doc: Doc): boolean;
  /** The record this process holds for `id`, or undefined. */
  held(id: string): Doc | undefined;
  /** Take the mirror copy (and remember it as what the mirror holds). */
  put(doc: R): void;
  /** Drop the record; true when one was held. */
  drop(id: string): boolean;
};

/**
 * One store's refresh, bound to its state accessor and target. `state` is a function because the
 * store's state object lives in a `globalThis` slot that can be replaced (a reset, a test process).
 */
export function mirrorRefresher<R>(mirror: OsMirror, state: () => MirrorRefreshState, target: RefreshTarget<R>) {
  async function run(st: MirrorRefreshState): Promise<void> {
    const listing = await mirror.list(target.size ?? 2000);
    if (!listing) {
      if (!st.degradedLogged) console.warn(`[${target.label}] mirror unreachable — serving what this process holds until it answers again`);
      st.degradedLogged = true;
      return; // memory stays exactly as it was
    }
    const listed = new Set<string>();
    for (const doc of listing.docs as Doc[]) {
      if (!doc || typeof doc.id !== 'string' || !doc.id) continue;
      const id = doc.id;
      listed.add(id); // present in the mirror, whatever its shape
      // Deleted HERE: a listing read before the delete reached the mirror still holds the doc.
      if (st.deletedHere.has(id)) continue;
      st.listed.add(id);
      st.missing.delete(id);
      if (target.accept && !target.accept(doc)) continue;
      const held = target.held(id);
      if (!held || String(doc.updatedAt ?? '') > String(held.updatedAt ?? '')) target.put(doc as R);
    }
    // Only a COMPLETE listing can say what is NOT there.
    if (!listing.complete) {
      if (!st.degradedLogged) console.warn(`[${target.label}] mirror listing incomplete — nothing is dropped until a complete one`);
      st.degradedLogged = true;
      return;
    }
    st.degradedLogged = false;
    for (const id of st.deletedHere) if (!listed.has(id)) st.deletedHere.delete(id);
    for (const id of st.listed) {
      if (listed.has(id)) continue;
      const n = (st.missing.get(id) ?? 0) + 1;
      if (n < MIRROR_ABSENT_CONFIRMATIONS) { st.missing.set(id, n); continue; }
      st.listed.delete(id);
      st.missing.delete(id);
      if (target.drop(id)) console.info(`[${target.label}] ${id} is gone from the mirror — deleted in another process; dropped here`);
    }
  }

  /** Re-read now (throttled unless `force`). Concurrent callers share one read. */
  function refresh(opts: { force?: boolean; nowMs?: number } = {}): Promise<void> {
    const st = state();
    const nowMs = opts.nowMs ?? Date.now();
    if (st.refreshing) return st.refreshing;
    if (!opts.force && st.refreshedAt !== undefined && nowMs - st.refreshedAt < MIRROR_REFRESH_MIN_MS) return Promise.resolve();
    st.refreshedAt = nowMs;
    const p = run(st).finally(() => { st.refreshing = null; });
    st.refreshing = p;
    return p;
  }

  return {
    /**
     * Declare THIS process a reader of what other processes write. Refused (false) outside the
     * run worker unless `anyProcess` — the web app is the writer and must not re-read per request.
     */
    enable(on = true, opts: { anyProcess?: boolean } = {}): boolean {
      if (on && !opts.anyProcess && !isRunWorkerProcess()) return false;
      state().enabled = on;
      return on;
    },
    enabled: (): boolean => state().enabled,
    refresh,
    /** The read seam: refresh first when this process is a reader; a no-op otherwise. */
    beforeRead(): Promise<void> {
      return state().enabled ? refresh() : Promise.resolve();
    },
    /** The boot hydration read the mirror: a fresh read, and what it held may later be dropped. */
    noteHydrated(ids: Iterable<string>, nowMs = Date.now()): void {
      const st = state();
      st.refreshedAt ??= nowMs;
      for (const id of ids) st.listed.add(id);
    },
    /** This process deleted `id`: a listing must not bring it back, and nothing counts it absent. */
    noteDeleted(id: string): void {
      const st = state();
      st.deletedHere.add(id);
      st.listed.delete(id);
      st.missing.delete(id);
    },
  };
}

export type MirrorRefresher = ReturnType<typeof mirrorRefresher>;
