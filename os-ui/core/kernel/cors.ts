/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { originOf } from '@core/kernel/same-origin';

/**
 * Origin helpers for the OS API (edge-safe, no Node APIs).
 *
 * CORS: the OS answers a credentialed CORS request ONLY for its own public origin
 * (`OS_PUBLIC_URL`), compared exactly (scheme + host + port). No other origin — not
 * the apps domain, not a look-alike — is ever reflected, and `*` is never used.
 * Deployed apps on the apps domain therefore cannot call the OS API with the user's
 * browser session; same-origin served apps (`/apps/<slug>`, `/api/apps/runtime/<slug>`)
 * are unaffected because they never cross an origin.
 */

/**
 * Is `origin` a host under the apps domain (or the OS host)? Used ONLY to ATTRIBUTE a
 * request to an app for least-privilege narrowing (tabs/software/lib/app-origin.ts) —
 * it can only ever deny. It grants nothing and is NOT a CORS allow-list.
 */
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

  const osHost = hostOf(osPublicUrl);
  if (osHost && host === osHost) return true;

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
 * The CORS response headers for `origin`, or `null` (add nothing) unless `origin` is
 * EXACTLY the OS's own public origin. Cross-origin callers get no CORS grant, so the
 * browser withholds the response and refuses any non-simple preflight.
 */
export function corsHeadersFor(
  origin: string | null | undefined,
  osPublicUrl: string | undefined,
): Record<string, string> | null {
  const os = originOf(osPublicUrl);
  if (!os || !origin || originOf(origin) !== os || origin.trim().toLowerCase() !== os) return null;
  return {
    'Access-Control-Allow-Origin': os,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,accept,authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
