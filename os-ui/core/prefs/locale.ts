/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    The user's UI language — the per-user server store
 * USER STORY: As a user I choose my language once under My Settings and the OS remembers it on every device and
 *             after every deploy; the AI answers me in it, and my scheduled agents report in it.
 * ARCHITECTURE:
 *   - The same dual pattern as `view-surface.ts`: an authoritative in-process map plus a write-through to the shared
 *     `os-user-prefs` index (doc id `locale-<userId>`, field `locale`). Only our own documents carry `locale`, so
 *     tile-order and view-surface rows are never read as a language.
 *   - The record is ONE field, so a whole-record write cannot erase another process's edit of some other field
 *     (ARCHITECTURE.md, "two processes hold two copies"); the save is AWAITED (`writeConfirmed`) so the settings page
 *     never says "saved" for a choice the shared store does not hold.
 *   - The worker (`os-ui-worker`) never saw the web process's change after its boot, so a run reads the language
 *     FRESH from the mirror (`getUserLocaleFresh`), falling back to the cached value, then English.
 *   - The user id ALWAYS comes from the session (enforced at the route); this module stays free of Next request
 *     context so it is directly testable. Never a permission: an unknown or missing value is English.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { DEFAULT_LOCALE, isLocale, toLocale, type Locale } from '@core/i18n/config';

type State = { cache: Map<string, Locale> | null };
const STATE_KEY = Symbol.for('soa.prefs.locale');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null };
  return g[STATE_KEY]!;
}

const mirror = osMirror({ index: 'os-user-prefs' });

export function localeDocId(userId: string): string {
  return `locale-${userId}`;
}

async function getCache(): Promise<Map<string, Locale>> {
  const s = state();
  if (s.cache) return s.cache;
  const map = new Map<string, Locale>();
  type Doc = { userId?: string; locale?: string };
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const d of docs as Doc[]) {
    if (!d?.userId || !isLocale(d.locale)) continue;
    map.set(d.userId, d.locale);
  }
  s.cache = map;
  return map;
}

/** The user's saved language, or null when they never chose (the caller then uses English). */
export async function getSavedLocale(userId: string): Promise<Locale | null> {
  return (await getCache()).get(userId) ?? null;
}

/** The user's language: saved, else English. */
export async function getUserLocale(userId: string): Promise<Locale> {
  return (await getSavedLocale(userId)) ?? DEFAULT_LOCALE;
}

/**
 * The language read FRESH from the shared store — for the run worker, whose cache predates the user's change.
 * No doc: English. Mirror unreachable: the cached value, else English.
 */
export async function getUserLocaleFresh(userId: string): Promise<Locale> {
  // `read` never throws: 'found' | 'absent' (the user never chose) | 'unreachable' (fall back to the cache).
  const r = await mirror.read(localeDocId(userId));
  if (r.state === 'found') {
    const loc = (r.doc as { locale?: unknown } | null)?.locale;
    if (isLocale(loc)) {
      (await getCache()).set(userId, loc);
      return loc;
    }
  }
  if (r.state === 'absent') return DEFAULT_LOCALE;
  return getUserLocale(userId);
}

/** Remember the user's choice. Resolves `{ ok: false }` when the shared store did not confirm the write. */
export async function setUserLocale(userId: string, locale: Locale): Promise<{ ok: true } | { ok: false; reason: string }> {
  const loc = toLocale(locale);
  const map = await getCache();
  const res = await mirror.writeConfirmed(localeDocId(userId), { userId, locale: loc, updatedAt: new Date().toISOString() });
  if (res.ok) map.set(userId, loc);
  return res;
}

/** Test seam: forget the in-process map. */
export function __resetLocaleForTests(): void {
  state().cache = null;
}
