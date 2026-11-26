/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    One preference record per key, read by id — never a cached "empty" from a failed startup read
 * USER STORY: As a user my saved language, Studio | Run choice and tile order survive a pod that started before
 *             OpenSearch was ready, and a tenant with many users, instead of silently reverting to defaults until
 *             the next deploy.
 * ARCHITECTURE:
 *   - The preference stores used to load the WHOLE `os-user-prefs` index once (`hydrate`) and cache the result
 *     for the process lifetime — including an EMPTY map when that one read failed (store not ready) or was
 *     incomplete (more records than one read may page through). Every user then saw defaults until a restart.
 *   - Instead each record is read BY ID (`mirror.read`), so there is no whole-index read and no record cap:
 *       found    → the value is cached for `ttlMs` (bounds staleness when another pod saved a newer value);
 *       absent   → "never chosen" is cached for `ttlMs` too (a 404 is an answer, not a failure);
 *       unreachable → NOTHING is cached; the caller gets `undefined` (unknown → its default for now) and the key
 *                  is retried after an exponential backoff (1 s, 2 s, 4 s … capped at `maxBackoffMs`), so a dead
 *                  store is not hammered and a healed one is picked up without a restart.
 *   - Concurrent reads of one key share one request. A local write (`remember`) is authoritative at once.
 *   - Pure orchestration over an injected `read` and clock, so it is unit-tested without OpenSearch.
 */
import type { MirrorRead } from '@core/infra/os-mirror';

export type PerUserDocOptions<T> = {
  /** One record's read (the mirror's `read`, which never throws). */
  read: (docId: string) => Promise<MirrorRead>;
  /** The doc id for a key. */
  docId: (key: string) => string;
  /** The value inside a found doc, or null when the doc does not hold a usable value. */
  parse: (doc: unknown) => T | null;
  /** How long a found/absent answer is reused before it is read again. Default 60 s. */
  ttlMs?: number;
  /** First retry delay after an unreachable read; doubles per failure. Default 1 s. */
  baseBackoffMs?: number;
  /** The longest retry delay. Default 60 s. */
  maxBackoffMs?: number;
  /** Injected clock (tests). */
  now?: () => number;
};

type Entry<T> = { value: T | null; at: number };
type Failure = { failures: number; retryAt: number };

export type PerUserDoc<T> = {
  /** The saved value, `null` when the store answered "never saved", `undefined` when the store did not answer. */
  get(key: string): Promise<T | null | undefined>;
  /** Record a value this process just wrote (authoritative immediately). */
  remember(key: string, value: T): void;
  /** Forget everything (tests, or a deliberate refresh). */
  reset(): void;
};

export function perUserDoc<T>(opts: PerUserDocOptions<T>): PerUserDoc<T> {
  const ttl = opts.ttlMs ?? 60_000;
  const base = opts.baseBackoffMs ?? 1_000;
  const cap = opts.maxBackoffMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry<T>>();
  const failed = new Map<string, Failure>();
  const inflight = new Map<string, Promise<T | null | undefined>>();

  async function load(key: string): Promise<T | null | undefined> {
    const r = await opts.read(opts.docId(key));
    if (r.state === 'unreachable') {
      const prev = failed.get(key);
      const failures = (prev?.failures ?? 0) + 1;
      failed.set(key, { failures, retryAt: now() + Math.min(cap, base * 2 ** (failures - 1)) });
      return undefined;
    }
    failed.delete(key);
    const value = r.state === 'found' ? opts.parse(r.doc) : null;
    cache.set(key, { value, at: now() });
    return value;
  }

  return {
    async get(key) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;
      const f = failed.get(key);
      // In backoff: keep serving what was last known (possibly expired) rather than asking a dead store again.
      if (f && now() < f.retryAt) return hit ? hit.value : undefined;
      let p = inflight.get(key);
      if (!p) {
        p = load(key).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const v = await p;
      // An unreachable re-read of an expired entry still serves the last known value.
      return v === undefined && hit ? hit.value : v;
    },
    remember(key, value) {
      cache.set(key, { value, at: now() });
      failed.delete(key);
    },
    reset() {
      cache.clear();
      failed.clear();
      inflight.clear();
    },
  };
}
