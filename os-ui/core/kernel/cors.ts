/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Credentialed CORS for the governed API routes a DEPLOYED governed app calls
 * cross-origin (identity delegation): `os.whoami()` → `/api/auth/me`, the context
 * feed → `/api/context/available`, etc. Deployed apps live on
 * `<slug>.<domain>.<appsDomain>`, a DIFFERENT origin from the OS host, so those
 * fetches (sent with `credentials:'include'`) need the OS to answer with
 * `Access-Control-Allow-Origin: <that exact origin>` + `-Allow-Credentials: true`.
 *
 * SECURITY: we REFLECT only origins we recognise — the OS's own public origin and
 * any host under the apps domain (`*.<appsDomain>`). We NEVER echo an arbitrary
 * Origin and NEVER use `*` (invalid with credentials). Same-origin requests carry
 * no Origin (or the OS origin) and are unaffected. Edge-safe (no Node APIs).
 */

/** Is `origin` an app/OS origin we allow to make credentialed calls? */
export function isAllowedAppOrigin(
  origin: string | null | undefined,
  osPublicUrl: string | undefined,
  appsDomain: string | undefined,
): boolean {
  if (!origin) return false;
  let host: string;
  let protocol: string;
  try {
    const u = new URL(origin);
    host = u.hostname.toLowerCase();
    protocol = u.protocol;
  } catch {
    return false;
  }
  if (protocol !== 'https:' && protocol !== 'http:') return false;

  // The OS's own public origin (host-compare, scheme-agnostic).
  const osHost = hostOf(osPublicUrl);
  if (osHost && host === osHost) return true;

  // Any host at or under the apps domain: `apps.example.com` or `*.apps.example.com`.
  const apps = (appsDomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (apps && (host === apps || host.endsWith(`.${apps}`))) return true;

  return false;
}

function hostOf(url: string | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/.*$/, '');
  }
}

/**
 * The CORS response headers to add when `origin` is an allowed app origin, else
 * `null` (add nothing — same-origin / disallowed cross-origin behaves as today).
 */
export function corsHeadersFor(
  origin: string | null | undefined,
  osPublicUrl: string | undefined,
  appsDomain: string | undefined,
): Record<string, string> | null {
  if (!isAllowedAppOrigin(origin, osPublicUrl, appsDomain)) return null;
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,accept,authorization',
    'Access-Control-Max-Age': '600',
    // Caches must key on Origin — the allowed value is reflected, not constant.
    Vary: 'Origin',
  };
}
