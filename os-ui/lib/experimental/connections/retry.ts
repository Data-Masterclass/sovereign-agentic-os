/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Shared retry helper for connector fetch calls.
 *
 * Implements capped exponential backoff WITH FULL JITTER on 429/503,
 * honouring the `Retry-After` response header (seconds or HTTP-date).
 * A hard attempt cap (`maxAttempts`, default 3) prevents hammering.
 *
 * Injectable `sleep` so tests are deterministic (no real delays).
 *
 * Pattern extracted from github.ts `ghSend`. Use this from every connector
 * that makes external HTTP calls (supabase, atlassian, gmail, gcal, outlook,
 * teams, …). The governance gate, timeout, and auth headers stay in each
 * connector — this only handles the retry loop.
 */

/** A callable that behaves like `globalThis.fetch`. Injected for testing. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A callable that resolves after `ms` ms. Injected for testing. */
export type SleepFn = (ms: number) => Promise<void>;

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  /** Maximum attempts total (including the first). Default 3. */
  maxAttempts?: number;
  /** Maximum sleep between retries in ms. Default 10_000 (10 s). */
  capMs?: number;
  /** Injected sleep — default uses real setTimeout. Override in tests. */
  sleep?: SleepFn;
}

/**
 * Parse `Retry-After` → ms.
 * Accepts: integer seconds ("30"), HTTP-date ("Fri, 01 Jan 2027 …"), or missing.
 * Missing → returns `fallbackMs`.
 */
export function retryAfterMs(header: string | null, fallbackMs = 1000): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (!Number.isNaN(secs) && secs >= 0) return secs * 1000;
  // HTTP-date
  const d = Date.parse(header);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return fallbackMs;
}

/**
 * Wrap a single fetch call in a capped exponential-backoff retry loop.
 *
 * Retries when the response status is 429 or 503. On each retry:
 *  • reads `Retry-After` (honours it up to `capMs`),
 *  • adds FULL JITTER (random in [0, delay]) so concurrent clients spread,
 *  • waits, then retries.
 *
 * After `maxAttempts` tries, returns the last response (caller checks ok/status).
 * Network errors (thrown by fetch) propagate immediately — a network fail is not
 * a rate-limit and should not be retried silently.
 */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const capMs = opts.capMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;

  let res!: Response;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    res = await fetchImpl(url, init); // may throw — propagate immediately
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt + 1 >= maxAttempts) break; // last attempt — return as-is
    // Exponential base: 1 s * 2^attempt, capped, then full jitter.
    const base = Math.min(1000 * Math.pow(2, attempt), capMs);
    const raMs = retryAfterMs(res.headers.get('retry-after'), base);
    const delay = Math.floor(Math.random() * Math.min(raMs, capMs));
    await sleep(delay);
  }
  return res;
}
