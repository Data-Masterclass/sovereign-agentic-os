/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       core/infra
 * FEATURE:    Server-side sign-in to LiteLLM's admin UI, so an admin never logs in twice
 * USER STORY: As a platform admin I want to open the LLM Gateway from the OS and already be
 *             signed in, without a second password and without any gateway credential ever
 *             reaching my browser.
 * ARCHITECTURE:
 *   - Mirrors core/infra/tool-sso-langfuse.ts: POST the credential ONCE server-side, cache the
 *     resulting session cookie, and hand only that cookie to the proxy (SessionSso.provide).
 *   - LiteLLM's UI login is `POST /login` with form-encoded username/password — it is NOT in
 *     LiteLLM's OpenAPI spec (an HTML route), confirmed empirically: GET /login answers 405.
 *     Treated as best-effort: any failure returns no cookie and the frame shows LiteLLM's own
 *     login rather than breaking.
 *   - The credential is a UI-ONLY account (LITELLM_UI_USERNAME/PASSWORD from a Secret), never
 *     the proxy master key: a leaked UI session must not equal full API access.
 *   - Cookie names are matched against a candidate list because LiteLLM has renamed its session
 *     cookie across versions; an unmatched Set-Cookie is dropped, never forwarded blindly.
 */
import { config } from '@core/kernel/config';

/** Session cookies LiteLLM has used across versions. Anything else is ignored. */
const SESSION_COOKIE_NAMES = ['token', 'litellm_session', 'session_token'] as const;

/** 20 min — well inside LiteLLM's JWT lifetime, short enough that a rotated credential takes effect. */
const TTL_MS = 20 * 60 * 1000;

let cache: { at: number; cookies: string[] } | null = null;

/** True when the incoming request already carries a LiteLLM session (skip the login). */
export function hasLiteLlmSession(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return SESSION_COOKIE_NAMES.some((n) => new RegExp(`(?:^|;\\s*)${n}=`).test(cookieHeader));
}

/** `name=value` from a Set-Cookie line, dropping the attributes. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0].trim();
}

/** Keep only the Set-Cookie lines that are actually session cookies. */
export function sessionCookiesFrom(setCookies: string[]): string[] {
  return setCookies.filter((c) => SESSION_COOKIE_NAMES.some((n) => c.startsWith(`${n}=`)));
}

export type LiteLlmLoginOpts = { baseUrl: string; username: string; password: string; fetchImpl?: typeof fetch };

/**
 * Sign in to LiteLLM's UI and return the session Set-Cookie values. Throws on any
 * failure so the caller can decide (we degrade rather than propagate).
 */
export async function loginLiteLlm(opts: LiteLlmLoginOpts): Promise<string[]> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({ username: opts.username, password: opts.password });
  const res = await f(`${opts.baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  // A successful form login answers 2xx or a 3xx redirect to the UI, with Set-Cookie.
  const raw = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
    : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  const session = sessionCookiesFrom(raw).map(cookiePair);
  if (session.length === 0) throw new Error(`LiteLLM login returned no session cookie (HTTP ${res.status})`);
  return session;
}

/** Test seam. */
export function _resetLiteLlmSessionCache(): void {
  cache = null;
}

/**
 * The cached session cookies, or `[]` when the gateway is unreachable or no UI
 * credential is configured. `[]` means "show LiteLLM's own login" — an honest
 * degrade, never a broken frame and never a leaked credential.
 */
export async function getLiteLlmSessionCookies(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS && cache.cookies.length > 0) return cache.cookies;
  if (!config.litellmUiUsername || !config.litellmUiPassword) return [];
  try {
    const cookies = await loginLiteLlm({
      baseUrl: config.litellmUrl,
      username: config.litellmUiUsername,
      password: config.litellmUiPassword,
      fetchImpl,
    });
    cache = { at: now, cookies };
    return cookies;
  } catch {
    return [];
  }
}

/** Whether an admin-only LiteLLM session can be established at all (drives the UI's honest message). */
export function liteLlmSsoConfigured(): boolean {
  return Boolean(config.litellmUiUsername && config.litellmUiPassword);
}
