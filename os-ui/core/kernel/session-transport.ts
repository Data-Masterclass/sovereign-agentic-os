/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      A sign-in whose session cookie the browser will not keep is reported, never silent
 * USER STORY:   As an operator who opens the OS on http://<server>:8080 or on a host the OS does not know, I want the
 *               sign-in page to tell me why I land back on it, and one log line that names the fix.
 * ARCHITECTURE: Pure verdict (no Next import, edge-safe) used by app/api/auth/login after a successful sign-in. The
 *               login route still sets the cookie (the verdict can be wrong behind an unusual proxy); the sign-in page
 *               then checks /api/auth/me and shows the message only when the session really did not stick.
 */
/**
 * Why a successful sign-in can bounce straight back to /signin with no error:
 *
 *   1. `insecureHttp` — the session cookie is `Secure` (production default, `__Host-` prefix), and the browser
 *      reached the OS over plain HTTP on a host that is not loopback. Browsers drop a `Secure` cookie set over
 *      http:// (Chrome and Firefox make an exception for `localhost` only; Safari makes none). The fix is HTTPS
 *      (a reverse proxy in front), or — for a throw-away test install only — `osUI.insecureSessionCookie=true`.
 *   2. `originMismatch` — the browser's origin is neither `OS_PUBLIC_URL` nor one of `OS_PUBLIC_URL_ALIASES`. The
 *      cookie itself may be kept, but the OS treats only configured origins as its own (same-origin check, OAuth
 *      callbacks, emailed links, the canonical redirect), so the session breaks in other places. The fix is to
 *      open the configured URL or add the origin to `osUI.publicUrlAliases`.
 *
 * The browser's scheme is read from the `Origin` header first (browser-set on every POST, not settable by page
 * script). Without it, `X-Forwarded-Proto` (first hop) and then the request URL decide. The origin check runs
 * ONLY on a real `Origin` header: a proxy's rewritten `Host` must never produce a false alarm.
 */
import { originOf, parseOriginList } from './same-origin';

export type SessionTransportWarning =
  | { kind: 'insecureHttp'; origin: string }
  | { kind: 'originMismatch'; origin: string; publicUrl: string };

export type SessionTransportInput = {
  /** Whether the session cookie this deployment writes carries `Secure`. */
  secureCookie: boolean;
  /** The request's `Origin` header (null when absent). */
  origin: string | null;
  /** The request's `X-Forwarded-Proto` header (null when absent). */
  forwardedProto: string | null;
  /** The request URL as the server sees it. */
  requestUrl: string;
  /** `OS_PUBLIC_URL` ('' when unset). */
  osPublicUrl: string;
  /** `OS_PUBLIC_URL_ALIASES` (comma-separated, '' when unset). */
  osPublicUrlAliases: string;
};

/** True for a host a browser treats as a secure context over plain HTTP. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The browser-side origin of the request: `Origin` if present, else forwarded scheme + request host. */
function browserOrigin(input: SessionTransportInput): { origin: string; fromOriginHeader: boolean } {
  const fromHeader = originOf(input.origin);
  if (fromHeader) return { origin: fromHeader, fromOriginHeader: true };
  if (!URL.canParse(input.requestUrl)) return { origin: '', fromOriginHeader: false };
  const u = new URL(input.requestUrl);
  const fwd = (input.forwardedProto ?? '').split(',')[0].trim().toLowerCase();
  const scheme = fwd === 'http' || fwd === 'https' ? fwd : u.protocol.replace(':', '');
  return { origin: originOf(`${scheme}://${u.host}`), fromOriginHeader: false };
}

/** Decide whether the browser will (likely) not keep or not be able to use the session. Null = no problem seen. */
export function diagnoseSessionTransport(input: SessionTransportInput): SessionTransportWarning | null {
  const { origin, fromOriginHeader } = browserOrigin(input);
  if (!origin) return null;
  const u = new URL(origin);
  if (input.secureCookie && u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return { kind: 'insecureHttp', origin };
  }
  const publicUrl = originOf(input.osPublicUrl);
  if (fromOriginHeader && publicUrl) {
    const allowed = new Set([publicUrl, ...parseOriginList(input.osPublicUrlAliases)]);
    if (!allowed.has(origin)) return { kind: 'originMismatch', origin, publicUrl };
  }
  return null;
}

/** The ONE server log line for a warning: what happened and the exact setting that fixes it. */
export function sessionTransportLogLine(w: SessionTransportWarning): string {
  if (w.kind === 'insecureHttp') {
    return (
      `[auth] WARN sign-in from ${w.origin} succeeded, but the browser will drop the session cookie: it is Secure ` +
      `and this page is plain HTTP on a non-localhost host, so the user lands back on /signin. Fix: serve the OS over ` +
      `HTTPS (reverse proxy with X-Forwarded-Proto: https, and osUI.publicUrl=https://<host>), or for a non-production ` +
      `test install only set osUI.insecureSessionCookie=true (OS_SESSION_COOKIE_INSECURE=true). ` +
      `See docs/ops/reverse-proxy.md.`
    );
  }
  return (
    `[auth] WARN sign-in from ${w.origin}, which is not the OS's configured origin (${w.publicUrl}) nor in ` +
    `OS_PUBLIC_URL_ALIASES; sessions, OAuth callbacks and same-origin checks use the configured origins only. Fix: ` +
    `open ${w.publicUrl}, or set osUI.publicUrl / add ${w.origin} to osUI.publicUrlAliases. See docs/ops/reverse-proxy.md.`
  );
}

const WARN_EVERY_MS = 10 * 60 * 1000;
const lastWarned = new Map<string, number>();

/** Log the warning once per (kind, origin) per 10 minutes — one line per cause, never a flood. */
export function warnSessionTransport(
  w: SessionTransportWarning,
  log: (line: string) => void = (l) => console.warn(l),
  now: number = Date.now(),
): boolean {
  const key = `${w.kind}|${w.origin}`;
  const last = lastWarned.get(key);
  if (last !== undefined && now - last < WARN_EVERY_MS) return false;
  if (lastWarned.size > 500) lastWarned.clear();
  lastWarned.set(key, now);
  log(sessionTransportLogLine(w));
  return true;
}

/** Test seam: forget the warn-once memory. */
export function resetSessionTransportWarnings(): void {
  lastWarned.clear();
}
