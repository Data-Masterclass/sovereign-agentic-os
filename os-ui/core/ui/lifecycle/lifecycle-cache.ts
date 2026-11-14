/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    One batched lifecycle lookup shared by every tile list and every badge
 * USER STORY: As a user opening a tab with forty tiles I want the Draft/Live badges to appear
 *             without forty requests, and I want the header toggle to filter the list I am
 *             looking at without each tab having invented its own way of finding out what is live.
 * ARCHITECTURE:
 *   - A module-level cache plus a per-kind request COALESCER: every list and every badge that
 *     mounts in the same tick contributes its ids to one POST /api/lifecycle/index. That is why a
 *     tile can render its own badge with no prop-drilling and the list can still filter — both
 *     read this one cache.
 *   - A `.ts` with the fetcher INJECTED, so the batching, the coalescing and the
 *     unknown-id-is-a-Draft rule are unit-testable without React or a network.
 *   - Fail-soft: a failed lookup leaves ids unknown, and an unknown id reads as a DRAFT with no
 *     pin — the honest default, because "we could not find out" must never render as Live.
 */

import {
  type Lifecycle,
  type LifecycleKind,
  type LifecycleWord,
  isLifecycleWord,
} from '@core/kernel/object-lifecycle';

/** What the endpoint answers. */
export type LifecycleLookup = (kind: LifecycleKind, ids: string[]) => Promise<Record<string, string>>;

type KindState = {
  words: Map<string, LifecycleWord>;
  /** Ids asked for already (answered or not) — never asked twice. */
  asked: Set<string>;
  /** Ids waiting for the next flush. */
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
};

type CacheState = { byKind: Map<string, KindState>; lookup: LifecycleLookup | null };
const STATE_KEY = Symbol.for('soa.ui.lifecycleCache');

function state(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { byKind: new Map(), lookup: null };
  return g[STATE_KEY]!;
}

function kindState(kind: string): KindState {
  const s = state();
  let k = s.byKind.get(kind);
  if (!k) {
    k = { words: new Map(), asked: new Set(), pending: new Set(), timer: null, listeners: new Set() };
    s.byKind.set(kind, k);
  }
  return k;
}

/** The live lookup — one POST with the ids the caller already holds. */
const httpLookup: LifecycleLookup = async (kind, ids) => {
  const res = await fetch('/api/lifecycle/index', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ids }),
  });
  if (!res.ok) throw new Error(`lifecycle lookup failed (${res.status})`);
  const body = (await res.json()) as { lifecycle?: Record<string, string> };
  return body.lifecycle ?? {};
};

/** Test seam: swap the fetcher, and forget everything. */
export function __setLifecycleLookup(lookup: LifecycleLookup | null): void {
  const s = state();
  s.lookup = lookup;
  s.byKind.clear();
}

function notify(k: KindState): void {
  for (const fn of [...k.listeners]) fn();
}

/** The flush delay. One tick is enough to collect every list and badge of one render. */
export const BATCH_MS = 0;

async function flush(kind: LifecycleKind): Promise<void> {
  const k = kindState(kind);
  k.timer = null;
  const ids = [...k.pending];
  k.pending.clear();
  if (ids.length === 0) return;
  const lookup = state().lookup ?? httpLookup;
  try {
    const answer = await lookup(kind, ids);
    for (const [id, word] of Object.entries(answer)) {
      if (isLifecycleWord(word)) k.words.set(id, word);
    }
  } catch {
    // Fail-soft: the ids stay unknown, and an unknown id reads as a Draft. "We could not find
    // out" must never render as Live.
  }
  notify(k);
}

/**
 * Make sure these ids are (being) looked up. Returns true when every id is already known, so a
 * caller can tell "all Drafts" apart from "not answered yet".
 */
export function requestLifecycles(kind: LifecycleKind, ids: readonly string[]): boolean {
  const k = kindState(kind);
  let complete = true;
  for (const id of ids ?? []) {
    if (!id) continue;
    if (k.words.has(id)) continue;
    complete = false;
    if (k.asked.has(id)) continue;
    k.asked.add(id);
    k.pending.add(id);
  }
  if (k.pending.size > 0 && !k.timer) {
    k.timer = setTimeout(() => void flush(kind), BATCH_MS);
  }
  return complete;
}

/** The word for one id — `draft` until the lookup answers otherwise. */
export function lifecycleWordFor(kind: LifecycleKind, id: string): LifecycleWord {
  return kindState(kind).words.get(id) ?? 'draft';
}

/**
 * The {@link Lifecycle} the badges render. A list carries no draft ref — the ref belongs on the
 * detail page — so the draft is named `unversioned` and only the PIN decides the badge, which is
 * exactly the question a tile answers.
 */
export function lifecycleForTile(kind: LifecycleKind, id: string): Lifecycle {
  const word = lifecycleWordFor(kind, id);
  const l: Lifecycle = { draft: 'unversioned' };
  if (word === 'live') l.live = 'pinned';
  if (word === 'testing') l.testing = 'in-flight';
  return l;
}

/** Subscribe to answers for a kind. Returns the unsubscribe. */
export function subscribeLifecycles(kind: LifecycleKind, fn: () => void): () => void {
  const k = kindState(kind);
  k.listeners.add(fn);
  return () => k.listeners.delete(fn);
}

/** Drop everything a kind knows — used after a go-live so the badges re-read. */
export function invalidateLifecycles(kind?: LifecycleKind): void {
  const s = state();
  const kinds = kind ? [kind] : [...s.byKind.keys()];
  for (const key of kinds) {
    const k = s.byKind.get(key);
    if (!k) continue;
    k.words.clear();
    k.asked.clear();
    notify(k);
  }
}
