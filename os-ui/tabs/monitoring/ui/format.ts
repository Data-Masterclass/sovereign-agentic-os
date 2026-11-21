/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring's display formatters — "how long ago", money, compact counts
 * USER STORY: As someone reading the Monitoring page and its detail drawer I want a time, a cost
 *             and a count to read the same way in both places.
 * ARCHITECTURE:
 *   - Pure functions, no React, so the page (`app/(govern)/monitoring/page.tsx`) and
 *     `DetailView.tsx` share one copy instead of two that could drift.
 *   - An absent fact renders '—' everywhere: a missing timestamp, and a zero or absent cost
 *     (runs whose models carry no explicit price are UNPRICED, not free — never "€0").
 */

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago"; '—' for null or an unparseable date. */
export function ago(at: number | string | null): string {
  if (at == null) return '—';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** €1.23 at or above one euro, €0.012 below it, '—' for zero/absent (unpriced, not free). */
export const money = (n: number): string => (n >= 1 ? `€${n.toFixed(2)}` : n > 0 ? `€${n.toFixed(3)}` : '—');

/** 1234 → "1.2k"; below 1000 the plain number. */
export const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** LiteLLM's ledger unit: its spend fields are USD (the admin Gateway panel says the same). Zero is a real $0.00. */
export const usd = (n: number): string => (n > 0 && n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
