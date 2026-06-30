/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';

/**
 * Minimal in-process fixed-window rate limiter for the auth endpoints (login,
 * recovery). It is intentionally simple: one OS-UI replica fronts the teaching
 * stack, so an in-memory counter is enough to blunt online password / master-key
 * guessing. A real multi-replica deploy would swap this for a shared store
 * (Valkey) — the call sites stay the same.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export type RateResult = { ok: boolean; retryAfter: number };

/**
 * Returns ok=false once `limit` hits occur inside `windowMs` for a key.
 * `retryAfter` is seconds until the window resets.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Clear a key's window after a successful auth so good users aren't penalised. */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}

/**
 * Best-effort client IP from standard proxy headers (defaults to 'local').
 *
 * SECURITY NOTE: X-Forwarded-For is client-settable, so on its own it is a weak
 * rate-limit key (an attacker can rotate it). This is acceptable here ONLY
 * because the OS UI is meant to sit behind the chart's ingress / a trusted
 * reverse proxy that overwrites XFF with the real client IP. Callers also mix in
 * the target username (login/recover routes) so a single shared 'local' bucket
 * can't lock every user out, and guessing is throttled per account. A public,
 * proxy-less exposure should additionally use a network-level limiter.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'local';
}
