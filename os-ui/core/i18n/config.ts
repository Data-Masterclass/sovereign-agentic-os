/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The language contract — the seven UI languages, their own names, the namespaces and the cookie
 * USER STORY: As a user I pick my language once under My Settings and every page renders in it from the first
 *             byte; as a contributor converting a tab I find the one list of languages and namespaces here.
 * ARCHITECTURE:
 *   - IMPORT-FREE and erasable-only TypeScript: the request config, the prefs store, the worker and the unit tests
 *     all use it. scripts/check-i18n.mjs keeps its own copy of LOCALES and NAMESPACES and a test pins the two equal.
 *   - English is the default AND the source language. There is no Accept-Language negotiation (owner decision
 *     2026-11-26): a user who never chose sees English.
 *   - NAMESPACES is the CLOSED list of catalog files under `os-ui/messages/<locale>/<namespace>.json`: one per tab
 *     module (the folder name, so `admin`, not "Platform"), plus `shell`, `common`, `settings` and `server`. Every
 *     namespace file exists in every locale from wave 1 on, so a later wave edits only its own files and two waves
 *     never touch the same file. Adding a namespace is a deliberate change here, in `catalog.ts`, in
 *     `en-messages.ts` and in scripts/check-i18n.mjs (which enforces the layout).
 *   - The locale cookie is a MIRROR of the per-user preference (`core/prefs/locale.ts`), bound to the user id so a
 *     second person signing in on the same browser does not inherit the first one's language.
 */

/** The UI languages, English first (default and source). */
export const LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Each language in its own name — what the picker shows (never translated). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  pl: 'Polski',
  cs: 'Čeština',
};

/** The language's English name — what a model prompt names (models follow English instructions best). */
export const LOCALE_ENGLISH_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pl: 'Polish',
  cs: 'Czech',
};

/** The catalog namespaces: one per tab module (folder name) plus the shared ones. A closed list. */
export const TAB_NAMESPACES = [
  'admin', 'agents', 'connections', 'dashboards', 'data', 'files', 'governance',
  'home', 'knowledge', 'metrics', 'monitoring', 'software', 'workflows',
] as const;
export const SHARED_NAMESPACES = ['shell', 'common', 'settings', 'server'] as const;
export const NAMESPACES = [...SHARED_NAMESPACES, ...TAB_NAMESPACES] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Any value → a supported locale; anything unknown is English. Never throws. */
export function toLocale(v: unknown): Locale {
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** The cookie that mirrors the saved preference so SSR renders the right language with no flash. */
export const LOCALE_COOKIE = 'soa-locale';

/** One year — the cookie is re-written on every save; the preference itself lives server-side. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** `<locale>.<userId>` — the user id binds the mirror to the person who chose it. */
export function serializeLocaleCookie(locale: Locale, userId: string): string {
  return `${locale}.${encodeURIComponent(userId)}`;
}

/**
 * Read the cookie. With `userId`: the locale only when the cookie was written for that user (else null — the
 * caller asks the preference store). Without `userId` (signed-out pages): the locale part alone.
 */
export function parseLocaleCookie(raw: string | undefined | null, userId?: string): Locale | null {
  if (!raw) return null;
  const dot = raw.indexOf('.');
  const loc = dot < 0 ? raw : raw.slice(0, dot);
  if (!isLocale(loc)) return null;
  if (userId === undefined) return loc;
  if (dot < 0) return null;
  // Compare in the ENCODED form: no decoding, so a malformed cookie can never throw.
  return raw.slice(dot + 1) === encodeURIComponent(userId) ? loc : null;
}

/**
 * The SSR locale, from what the request carries. The user's SAVED preference wins whenever it is known — it is the
 * one the AI answers in, so a second device with an older cookie must not keep the old language. The user-bound
 * cookie is the fallback (preference store unreachable, or nothing saved yet on a fresh pod); then English. A
 * signed-out page reads the cookie's locale alone.
 */
export function resolveRequestLocale(input: { cookie?: string | null; userId?: string | null; saved?: Locale | null }): Locale {
  if (input.userId) {
    return input.saved ?? parseLocaleCookie(input.cookie, input.userId) ?? DEFAULT_LOCALE;
  }
  return parseLocaleCookie(input.cookie) ?? DEFAULT_LOCALE;
}

/** True when a signed-in user's cookie does not mirror their saved preference — the page then re-sets it. */
export function localeCookieStale(input: { cookie?: string | null; userId?: string | null; saved?: Locale | null }): boolean {
  if (!input.userId || !input.saved) return false;
  return parseLocaleCookie(input.cookie, input.userId) !== input.saved;
}
