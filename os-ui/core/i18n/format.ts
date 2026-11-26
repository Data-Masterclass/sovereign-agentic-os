/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The OS's locale-aware formatters — dates, relative times, numbers, compact numbers, currency, sizes
 * USER STORY: As a German user I read "3,5 Mio." and "vor 4 Minuten" and "26.11.2026"; as an English user I see
 *             exactly what the OS showed before i18n.
 * ARCHITECTURE:
 *   - Pure, import-free apart from the config contract, built on the platform's Intl (no library, no catalog), so
 *     it is safe in a server module, a client component and a unit test alike.
 *   - ENGLISH IS UNCHANGED: the three formatters the OS already had (`fmtCompact` in core/ui/charts/format.ts,
 *     `relativeTime` in core/ui/git/git-view.ts, `formatSize` in core/ui/chat-attachments-view.ts) now delegate here
 *     and keep their exact English output; only a non-English locale takes the Intl path.
 *   - `now` is injectable everywhere a clock is read, so a server render and a client render agree and tests are
 *     deterministic. A non-finite or unparseable input gives the same honest '' / '—' the old helpers gave.
 *   - Client components get these bound to the active locale through `useFormat()` (`@core/i18n/client`).
 */
import { toLocale, type Locale } from '@core/i18n/config';

type DateInput = Date | number | string;

function toMs(v: DateInput): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(String(v ?? ''));
}

/** A calendar date in the locale's own form (en: "Nov 26, 2026", de: "26.11.2026"). '' when unparseable. */
export function formatDate(value: DateInput, locale: Locale | string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  const t = toMs(value);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(toLocale(locale), opts).format(t);
}

/** A date and time (en: "Nov 26, 2026, 2:05 PM", de: "26.11.2026, 14:05"). '' when unparseable. */
export function formatDateTime(value: DateInput, locale: Locale | string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return formatDate(value, locale, opts);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "4 minutes ago" / "vor 4 Minuten" / "dans 2 jours" — the locale's own relative phrase. '' when unparseable. */
export function formatRelativeTime(value: DateInput, locale: Locale | string, now: number = Date.now(), style: Intl.RelativeTimeFormatStyle = 'long'): string {
  const t = toMs(value);
  if (!Number.isFinite(t)) return '';
  const rtf = new Intl.RelativeTimeFormat(toLocale(locale), { numeric: 'auto', style });
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return rtf.format(0, 'second');
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds / 60), 'minute');
}

/** A plain number with the locale's separators (en: "1,234.5", de: "1.234,5"). '—' for non-finite. */
export function formatNumber(n: number, locale: Locale | string, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(toLocale(locale), opts).format(n);
}

/** The OS's original English compact form — 1.2B / 3.4M / 34.5k / 812 / 0.25. Kept byte-for-byte. */
function compactEn(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** A calm, compact number for KPIs and axes. English unchanged; other locales "1,2 Mio." / "1,2 M". '—' for non-finite. */
export function formatCompactNumber(n: number, locale: Locale | string = 'en'): string {
  if (!Number.isFinite(n)) return '—';
  const loc = toLocale(locale);
  if (loc === 'en') return compactEn(n);
  if (Math.abs(n) < 1e3) {
    return new Intl.NumberFormat(loc, Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  }
  return new Intl.NumberFormat(loc, { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

/** Money in the locale's form (en: "€1,234.50", de: "1.234,50 €"). '—' for non-finite. */
export function formatCurrency(n: number, currency: string, locale: Locale | string, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(toLocale(locale), { style: 'currency', currency, ...opts }).format(n);
}

/** A file size — English unchanged ("1.5 MB" / "12 KB" / "300 B"); other locales use their decimal separator. */
export function formatBytes(bytes: number, locale: Locale | string = 'en'): string {
  const loc = toLocale(locale);
  if (loc === 'en') {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }
  const nf = (v: number, digits: number) => new Intl.NumberFormat(loc, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  if (bytes >= 1048576) return `${nf(bytes / 1048576, 1)} MB`;
  if (bytes >= 1024) return `${nf(Math.round(bytes / 1024), 0)} KB`;
  return `${nf(bytes, 0)} B`;
}

/**
 * The git badge's short relative time — English unchanged ("just now" / "4 min ago" / "3 h ago" / "2 d ago" / an ISO
 * date beyond a month); other locales use Intl's short relative phrase with the same thresholds.
 */
export function formatShortRelativeTime(iso: string, now: number = Date.now(), locale: Locale | string = 'en'): string {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 0) return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const loc = toLocale(locale);
  const rtf = loc === 'en' ? null : new Intl.RelativeTimeFormat(loc, { numeric: 'auto', style: 'short' });
  if (seconds < 45) return rtf ? rtf.format(0, 'second') : 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf ? rtf.format(-minutes, 'minute') : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf ? rtf.format(-hours, 'hour') : `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return rtf ? rtf.format(-days, 'day') : `${days} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Every formatter bound to one locale — what `useFormat()` and `getFormat()` hand out. */
export function formattersFor(locale: Locale | string) {
  const loc = toLocale(locale);
  return {
    locale: loc,
    date: (v: DateInput, opts?: Intl.DateTimeFormatOptions) => formatDate(v, loc, opts),
    dateTime: (v: DateInput, opts?: Intl.DateTimeFormatOptions) => formatDateTime(v, loc, opts),
    relativeTime: (v: DateInput, now?: number) => formatRelativeTime(v, loc, now),
    number: (n: number, opts?: Intl.NumberFormatOptions) => formatNumber(n, loc, opts),
    compact: (n: number) => formatCompactNumber(n, loc),
    currency: (n: number, currency: string, opts?: Intl.NumberFormatOptions) => formatCurrency(n, currency, loc, opts),
    bytes: (n: number) => formatBytes(n, loc),
  };
}
export type Formatters = ReturnType<typeof formattersFor>;
