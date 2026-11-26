/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    The user's UI language — the per-user server store
 * USER STORY: As a user I choose my language once under My Settings and the OS remembers it on every device and
 *             after every deploy; the AI answers me in it, and my scheduled agents report in it.
 * ARCHITECTURE:
 *   - One record per user in the shared `os-user-prefs` index (doc id `locale-<userId>`, field `locale`), read BY ID
 *     through `per-user-doc.ts`: no whole-index read, so no record cap, and a failed read is never cached as "nobody
 *     chose" — it is retried with backoff. A found answer is reused for 30 s, which also bounds how long a pod can
 *     serve a value another pod has since changed (the saved preference wins over the cookie at render time).
 *   - The record is ONE field, so a whole-record write cannot erase another process's edit of some other field
 *     (ARCHITECTURE.md, "two processes hold two copies"); the save is AWAITED (`writeConfirmed`) so the settings page
 *     never says "saved" for a choice the shared store does not hold.
 *   - A run in the worker (`os-ui-worker`) reads the language FRESH from the mirror (`getUserLocaleFresh`), falling
 *     back to the last known value, then English.
 *   - The user id ALWAYS comes from the session (enforced at the route); this module stays free of Next request
 *     context so it is directly testable. Never a permission: an unknown or missing value is English.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { perUserDoc } from '@core/prefs/per-user-doc';
import { DEFAULT_LOCALE, isLocale, toLocale, type Locale } from '@core/i18n/config';

const mirror = osMirror({ index: 'os-user-prefs' });

export function localeDocId(userId: string): string {
  return `locale-${userId}`;
}

const parseLocale = (doc: unknown): Locale | null => {
  const loc = (doc as { locale?: unknown } | null)?.locale;
  return isLocale(loc) ? loc : null;
};

type State = { docs: ReturnType<typeof perUserDoc<Locale>> };
const STATE_KEY = Symbol.for('soa.prefs.locale.v2');
function docs(): State['docs'] {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { docs: perUserDoc<Locale>({ read: (id) => mirror.read(id), docId: localeDocId, parse: parseLocale, ttlMs: 30_000 }) };
  return g[STATE_KEY]!.docs;
}

/** The user's saved language, or null when they never chose OR the store did not answer (the caller uses English). */
export async function getSavedLocale(userId: string): Promise<Locale | null> {
  return (await docs().get(userId)) ?? null;
}

/** The user's language: saved, else English. */
export async function getUserLocale(userId: string): Promise<Locale> {
  return (await getSavedLocale(userId)) ?? DEFAULT_LOCALE;
}

/**
 * The language read FRESH from the shared store — for the run worker. No doc: English. Mirror unreachable: the last
 * known value, else English.
 */
export async function getUserLocaleFresh(userId: string): Promise<Locale> {
  // `read` never throws: 'found' | 'absent' (the user never chose) | 'unreachable' (fall back to what is known).
  const r = await mirror.read(localeDocId(userId));
  if (r.state === 'found') {
    const loc = parseLocale(r.doc);
    if (loc) {
      docs().remember(userId, loc);
      return loc;
    }
  }
  if (r.state === 'absent') return DEFAULT_LOCALE;
  return getUserLocale(userId);
}

/** Remember the user's choice. Resolves `{ ok: false }` when the shared store did not confirm the write. */
export async function setUserLocale(userId: string, locale: Locale): Promise<{ ok: true } | { ok: false; reason: string }> {
  const loc = toLocale(locale);
  const res = await mirror.writeConfirmed(localeDocId(userId), { userId, locale: loc, updatedAt: new Date().toISOString() });
  if (res.ok) docs().remember(userId, loc);
  return res;
}

/** Test seam: forget what this process knows. */
export function __resetLocaleForTests(): void {
  docs().reset();
  mirror.__reset();
}
