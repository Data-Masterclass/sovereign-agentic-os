/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * Shared Superset authenticated-handshake helpers (server-only). Every write against
 * Superset (dashboard import/delete, guest-token mint, embedded-registration) runs behind
 * the same trusted-proxy SSO (AUTH_REMOTE_USER): we present the service account via
 * `X-Forwarded-User` (SUPERSET_SERVICE_USER, default `admin`), fetch a CSRF token + session
 * cookie, and send `X-CSRFToken` + `Cookie` + `Referer`. Lifted here (from client.ts) so
 * the import/delete path and the embed/mint path share ONE implementation.
 */

export function serviceUser(): string {
  return process.env.SUPERSET_SERVICE_USER || 'admin';
}

/**
 * The Superset role(s) the trusted-header SSO provisions the service user with. Superset's
 * `_sso_login` maps `X-Forwarded-Roles` → the user's role, so this must be `Admin` for the
 * service user to hold `can_grant_guest_token` (only Admin has it — a Gamma default 403s the
 * guest-token mint). Admin-overridable via SUPERSET_SERVICE_ROLES.
 */
export function serviceRoles(): string {
  return process.env.SUPERSET_SERVICE_ROLES || 'Admin';
}

export async function withTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms = 8000,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort: fetch a CSRF token + session cookie. Returns {} when unavailable. */
export async function csrf(fetchImpl: typeof fetch, base: string): Promise<{ token?: string; cookie?: string }> {
  const res = await withTimeout(fetchImpl, `${base}/api/v1/security/csrf_token/`, {
    method: 'GET',
    headers: { 'X-Forwarded-User': serviceUser(), 'X-Forwarded-Roles': serviceRoles(), accept: 'application/json' },
  });
  if (!res || !res.ok) return {};
  const raw = res.headers.get('set-cookie');
  const cookie = raw ? raw.split(/,(?=[^;]+=)/).map((c) => c.split(';')[0].trim()).join('; ') : undefined;
  const data = (await res.json().catch(() => ({}))) as { result?: string };
  return { token: data.result, cookie };
}

/**
 * The standard authenticated headers for a Superset write: the trusted service-user,
 * `Referer` (Superset's CSRF guard checks it), and — when the CSRF fetch succeeded — the
 * `X-CSRFToken` + `Cookie`. `extra` merges last (e.g. content-type for a JSON body).
 */
export function serviceHeaders(
  base: string,
  auth: { token?: string; cookie?: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Forwarded-User': serviceUser(),
    'X-Forwarded-Roles': serviceRoles(),
    Referer: base,
    ...extra,
  };
  if (auth.token) headers['X-CSRFToken'] = auth.token;
  if (auth.cookie) headers['Cookie'] = auth.cookie;
  return headers;
}
