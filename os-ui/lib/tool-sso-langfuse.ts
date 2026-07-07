/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';

/**
 * Langfuse single-sign-on for the embedded console (`/tools/langfuse`).
 *
 * Langfuse authenticates with NextAuth — it has NO trusted-proxy / remote-user
 * header mode (unlike Superset/Forgejo), so the header-injection path in
 * lib/tool-proxy.ts cannot log a user in. Instead this module performs the
 * NextAuth *credentials* sign-in SERVER-SIDE, using a server-only Langfuse
 * service account, and hands the resulting session cookie to the proxy. The OS
 * has already authenticated + role-gated the caller (the embedded Langfuse tool
 * is admin-only — it shows every project trace, unlike the per-user-scoped
 * Monitoring API), so this establishes the tool session without ever showing a
 * second login and without the service password touching the browser.
 *
 * The session token is cached process-side (it is a signed NextAuth JWT valid
 * for weeks) so we do not re-login on every request. On any failure we return no
 * cookies and the proxy simply forwards the request unchanged — the user then
 * sees Langfuse's own login page (graceful degradation, never a hard error).
 */

/** NextAuth session-cookie names (plain + Secure-prefixed variants). */
const SESSION_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
];

/** True when the browser already presents a Langfuse NextAuth session cookie. */
export function hasLangfuseSession(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return SESSION_COOKIE_NAMES.some((n) =>
    new RegExp(`(?:^|;\\s*)${n.replace(/[.$]/g, '\\$&')}=`).test(cookieHeader),
  );
}

/** Pull the `name=value` pair out of a full Set-Cookie string (drops attributes). */
export function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0].trim();
}

/** Keep only the Set-Cookie entries that carry a NextAuth session token. */
function sessionCookiesOf(setCookies: string[]): string[] {
  return setCookies.filter((c) => SESSION_COOKIE_NAMES.some((n) => c.startsWith(`${n}=`)));
}

export type LangfuseLoginOpts = {
  fetchImpl: typeof fetch;
  baseUrl: string;
  email: string;
  password: string;
};

/**
 * Perform the NextAuth credentials sign-in and return the session Set-Cookie
 * string(s). Pure w.r.t the injected `fetchImpl` (no module state) so it is unit
 * testable. Throws on any non-OK step or when no session cookie comes back.
 */
export async function loginLangfuse(opts: LangfuseLoginOpts): Promise<string[]> {
  const { fetchImpl, baseUrl, email, password } = opts;
  const base = baseUrl.replace(/\/+$/, '');

  // 1) CSRF token + its cookie.
  const csrfRes = await fetchImpl(`${base}/api/auth/csrf`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });
  if (!csrfRes.ok) throw new Error(`csrf HTTP ${csrfRes.status}`);
  const csrfBody = (await csrfRes.json()) as { csrfToken?: string };
  const csrfToken = csrfBody?.csrfToken;
  if (!csrfToken) throw new Error('no csrfToken');
  const csrfCookies = (csrfRes.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [];
  const cookieHeader = csrfCookies.map(cookiePair).join('; ');

  // 2) Credentials callback. json=true asks NextAuth to answer with a body
  //    instead of a redirect; the session cookie rides back in Set-Cookie.
  const form = new URLSearchParams({
    csrfToken,
    email,
    password,
    callbackUrl: base,
    json: 'true',
  });
  const loginRes = await fetchImpl(`${base}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: form.toString(),
    redirect: 'manual',
  });
  const setCookies = (loginRes.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [];
  const session = sessionCookiesOf(setCookies);
  if (session.length === 0) throw new Error(`login returned no session cookie (HTTP ${loginRes.status})`);
  return session;
}

/* ------------------------------------------------------------- process cache */

type Cached = { cookies: string[]; at: number };
let cache: Cached | null = null;
// Re-login well inside the NextAuth session lifetime; a stale token just means
// one extra login round-trip, never a broken session.
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Reset the module cache (tests). */
export function _resetLangfuseSessionCache(): void {
  cache = null;
}

/**
 * Cached session cookies for the configured Langfuse service account. Returns
 * `[]` on any failure so the proxy degrades to Langfuse's own login rather than
 * erroring. `fetchImpl` is injectable for tests.
 */
export async function getLangfuseSessionCookies(
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS && cache.cookies.length > 0) return cache.cookies;
  try {
    const cookies = await loginLangfuse({
      fetchImpl,
      baseUrl: config.langfuseUrl,
      email: config.langfuseSsoEmail,
      password: config.langfuseSsoPassword,
    });
    cache = { cookies, at: now };
    return cookies;
  } catch {
    cache = null;
    return [];
  }
}
