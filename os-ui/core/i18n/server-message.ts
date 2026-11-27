/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    Render a server message in the reader's language — `server.<code>` with English fallback
 * USER STORY: As a user who picked Polish I read the server's "Admin only" as Polish; when the server sent no code,
 *             or one the catalog does not know, I read exactly the English it sent, never a raw key or a blank.
 * ARCHITECTURE:
 *   - The server sends `{ error: <English>, code?, params? }` (core/kernel/server-message.ts). `renderServerMessage`
 *     looks the code up in the `server` namespace ONLY when it is a dotted UI code (`isServerCode`) that the catalog
 *     has (`t.has`), formats it with the cleaned params, and otherwise returns the English `error` (or the field
 *     the caller names, e.g. `reason`), else the caller's fallback. A formatting failure (a missing param) renders '' in next-intl, so '' also falls
 *     back to English.
 *   - It decides nothing: the text is display only. Callers keep branching on status / `ok`, never on the
 *     translated string.
 *   - `renderServerMessage` is framework-free (takes any translator with `has`), so tests render it through the
 *     real catalogs; components use `useServerMessage()` (core/i18n/client.ts), route handlers and notification
 *     writers use `serverTextFor(locale)` (core/i18n/server-text.ts).
 */
import { cleanParams, isServerCode, type ServerParams } from '@core/kernel/server-message';

/** The minimal translator surface: next-intl's `t` (with `t.has`) or `createTranslator(...)`. */
export type ServerTranslator = ((key: string, values?: ServerParams) => string) & { has: (key: string) => boolean };

/** The `{ code, params }` of a server body when the code is a UI code; otherwise null. */
export function readServerMessage(body: unknown): { code: string; params?: ServerParams } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!isServerCode(b.code)) return null;
  const params = cleanParams(b.params);
  return params ? { code: b.code, params } : { code: b.code };
}

/** The English text a server body carries in `field` (default `error`) — a bare string body is itself the text. */
export function englishOf(body: unknown, field: 'error' | 'reason' | 'message' = 'error'): string | undefined {
  if (typeof body === 'string') return body || undefined;
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>)[field];
  return typeof v === 'string' && v ? v : undefined;
}

/** Translate by code alone (no body) — '' when the code is unknown or formatting fails. */
export function translateServerCode(t: ServerTranslator, code: string, params?: ServerParams): string {
  // next-intl never throws here: a formatting problem goes to `onError` and renders the message fallback ('').
  if (!isServerCode(code) || !t.has(code)) return '';
  return t(code, cleanParams(params));
}

/**
 * The text to show for a server body: `server.<code>` in the active language when the code is known, else the
 * English the server sent in `field` (default `error` — `j.error ?? fallback` exactly), else `fallback`.
 */
export function renderServerMessage(t: ServerTranslator, body: unknown, fallback = '', field: 'error' | 'reason' | 'message' = 'error'): string {
  const m = readServerMessage(body);
  const translated = m ? translateServerCode(t, m.code, m.params) : '';
  return translated || englishOf(body, field) || fallback;
}
