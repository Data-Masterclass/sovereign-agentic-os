/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring's display formatters — "how long ago", money, compact counts, durations, shares
 * USER STORY: As someone reading the Monitoring page and its detail drawer I want a time, a cost
 *             and a count to read the same way in both places — and in my own language's form.
 * ARCHITECTURE:
 *   - Pure functions, no React, so the page (`app/(govern)/monitoring/page.tsx`) and
 *     `DetailView.tsx` share one copy instead of two that could drift.
 *   - An absent fact renders '—' everywhere: a missing timestamp, and a zero or absent cost
 *     (runs whose models carry no explicit price are UNPRICED, not free — never "€0").
 *   - Every helper takes an optional `locale` (default 'en'). ENGLISH IS UNCHANGED byte for byte; any other
 *     locale takes the platform's Intl path through `@core/i18n/format` (separators, currency position,
 *     relative phrases). Components pass `useFormat().locale`.
 */
import { formatCompactNumber, formatCurrency, formatDate, formatDateTime, formatNumber } from '@core/i18n/format';
import { toLocale } from '@core/i18n/config';

const fixed = (digits: number): Intl.NumberFormatOptions => ({ minimumFractionDigits: digits, maximumFractionDigits: digits });
const isEn = (locale: string) => toLocale(locale) === 'en';

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago"; '—' for null or an unparseable date. */
export function ago(at: number | string | null, locale: string = 'en'): string {
  if (at == null) return '—';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const rtf = isEn(locale) ? null : new Intl.RelativeTimeFormat(toLocale(locale), { numeric: 'auto', style: 'short' });
  if (s < 60) return rtf ? rtf.format(0, 'second') : 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return rtf ? rtf.format(-m, 'minute') : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return rtf ? rtf.format(-h, 'hour') : `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return rtf ? rtf.format(-d, 'day') : `${d}d ago`;
  return rtf ? rtf.format(-Math.floor(d / 30), 'month') : `${Math.floor(d / 30)}mo ago`;
}

/** €1.23 at or above one euro, €0.012 below it, '—' for zero/absent (unpriced, not free). */
export const money = (n: number, locale: string = 'en'): string => {
  if (isEn(locale)) return n >= 1 ? `€${n.toFixed(2)}` : n > 0 ? `€${n.toFixed(3)}` : '—';
  return n >= 1 ? formatCurrency(n, 'EUR', locale, fixed(2)) : n > 0 ? formatCurrency(n, 'EUR', locale, fixed(3)) : '—';
};

/** 1234 → "1.2k"; below 1000 the plain number. */
export const compact = (n: number, locale: string = 'en'): string => {
  if (isEn(locale)) return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  return n >= 1000 ? formatCompactNumber(n, locale) : formatNumber(n, locale);
};

/** LiteLLM's ledger unit: its spend fields are USD (the admin Gateway panel says the same). Zero is a real $0.00. */
export const usd = (n: number, locale: string = 'en'): string => {
  if (isEn(locale)) return n > 0 && n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
  return formatCurrency(n, 'USD', locale, fixed(n > 0 && n < 1 ? 3 : 2));
};

/** A latency: "850 ms", "1.5 s", "12 s"; '—' when absent. */
export const ms = (v: number | null | undefined, locale: string = 'en'): string => {
  if (v === null || v === undefined) return '—';
  if (isEn(locale)) return v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  if (v >= 10_000) return `${formatNumber(v / 1000, locale, fixed(0))} s`;
  return v >= 1000 ? `${formatNumber(v / 1000, locale, fixed(1))} s` : `${formatNumber(Math.round(v), locale)} ms`;
};

/** A run duration as the detail view prints it: "850ms", "1.5s"; '—' when absent. */
export const dur = (v: number | undefined, locale: string = 'en'): string => {
  if (typeof v !== 'number') return '—';
  if (isEn(locale)) return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`;
  return v < 1000 ? `${formatNumber(Math.round(v), locale)}ms` : `${formatNumber(v / 1000, locale, fixed(1))}s`;
};

/** A share 0..1 as a whole percent ("45%", de "45 %"); '—' when absent. */
export const pct = (v: number | null | undefined, locale: string = 'en'): string => {
  if (v === null || v === undefined) return '—';
  if (isEn(locale)) return `${Math.round(v * 100)}%`;
  return formatNumber(Math.round(v * 100) / 100, locale, { style: 'percent', maximumFractionDigits: 0 });
};

/** A percent that is already 0..100 ("80%", de "80 %"). */
export const pct100 = (v: number, locale: string = 'en'): string =>
  isEn(locale) ? `${v}%` : formatNumber(v / 100, locale, { style: 'percent', maximumFractionDigits: 2 });

/** A pod's working set: "1.5 GiB" from 1 GiB up, "512 MiB" below. */
export const gib = (v: number, locale: string = 'en'): string => {
  if (isEn(locale)) return v >= 1 << 30 ? `${(v / (1 << 30)).toFixed(1)} GiB` : `${Math.round(v / (1 << 20))} MiB`;
  return v >= 1 << 30 ? `${formatNumber(v / (1 << 30), locale, fixed(1))} GiB` : `${formatNumber(Math.round(v / (1 << 20)), locale)} MiB`;
};

/** A number with a fixed count of decimals ("0.25" cores; de "0,25"). */
export const decimals = (v: number, digits: number, locale: string = 'en'): string =>
  isEn(locale) ? v.toFixed(digits) : formatNumber(v, locale, fixed(digits));

/** A plain count ("1234" in English, as before; de "1.234"). */
export const count = (v: number, locale: string = 'en'): string => (isEn(locale) ? String(v) : formatNumber(v, locale));

/** A euro figure from the billing envelope as stored ("€120"; de "120 €"). */
export const euros = (v: number, locale: string = 'en'): string =>
  isEn(locale) ? `€${v}` : formatCurrency(v, 'EUR', locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** A server-sent day ("2026-11-27"): unchanged in English, the locale's short date elsewhere; unparseable as-is. */
export const day = (iso: string, locale: string = 'en'): string => {
  if (isEn(locale) || !Number.isFinite(Date.parse(iso))) return iso;
  return formatDate(iso, locale, { dateStyle: 'short', timeZone: 'UTC' });
};

/** A server-sent timestamp: unchanged in English, the locale's short date and time elsewhere; unparseable as-is. */
export const stamp = (iso: string, locale: string = 'en'): string => {
  if (isEn(locale) || !Number.isFinite(Date.parse(iso))) return iso;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? day(iso, locale) : formatDateTime(iso, locale, { dateStyle: 'short', timeStyle: 'short' });
};
