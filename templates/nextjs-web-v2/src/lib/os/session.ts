/**
 * FEATURE:    Sign-in through the OS: the app identity token (OS-issued, short-lived) in a host-only cookie.
 * USER STORY: As a user of this app I sign in with my OS account; the app then acts as me, only for what I allowed,
 *             and I never type a password into the app.
 * ARCHITECTURE:
 *   - OAuth-style code flow with PKCE (S256), no client secret: `/os/login` stores state, nonce and the PKCE verifier
 *     in a short-lived host-only HttpOnly cookie and sends the browser to the OS (`/api/auth/app-login`); the OS
 *     signs the user in, asks for consent once, and returns to `https://<this host>/os/callback` with a one-time
 *     code; the callback checks `state`, exchanges the code server-to-server (`POST /api/auth/app-token`, in-cluster
 *     OS_BASE_URL) with the verifier, checks the `nonce`, and keeps the token in a host-only
 *     `HttpOnly; Secure; SameSite=Lax` cookie. It never appears in a URL, a log or client JavaScript.
 *   - The token is opaque to the app: the OS verifies it on every call and re-reads the user's role. Expired or
 *     refused (401) ⇒ sign in again, which is silent while the OS session and the consent last.
 *   - Configuration comes from the platform only: OS_PUBLIC_URL (the browser's way to the OS), OS_BASE_URL (the
 *     in-cluster way), APP_DOMAIN, APP_SLUG and APP_ENV (dev | prod). Missing ⇒ a clear error, never a guess.
 *   - This folder is the only code that touches cookies or headers (policy/app-rules.rego).
 */
import { OsError } from '@sovereign-os/app-sdk';

export type OsEnv = Record<string, string | undefined>;

/** The cookie holding the app identity token (host-only: the `__Host-` prefix forbids a Domain attribute). */
export const APP_SESSION_COOKIE = '__Host-os-app-session';
/** The cookie holding state, nonce and the PKCE verifier between /os/login and /os/callback (10 minutes). */
export const APP_LOGIN_COOKIE = '__Host-os-app-login';
export const CALLBACK_PATH = '/os/callback';
export const LOGIN_PATH = '/os/login';
const LOGIN_TTL_SEC = 600;

export type IdentityConfig = { publicUrl: string; baseUrl: string; domain: string; slug: string; env: 'dev' | 'prod' };

/** The platform-provided configuration of sign-in, or a thrown OsError naming what is missing. */
export function identityConfig(env: OsEnv = process.env): IdentityConfig {
  const missing = ['OS_PUBLIC_URL', 'OS_BASE_URL', 'APP_DOMAIN', 'APP_SLUG', 'APP_ENV'].filter((k) => !env[k]);
  if (missing.length) throw new OsError(`Sign-in through the OS is not configured: ${missing.join(', ')} not set by the platform.`, 0);
  const appEnv = env.APP_ENV;
  if (appEnv !== 'dev' && appEnv !== 'prod') throw new OsError('APP_ENV must be dev or prod.', 0);
  return { publicUrl: String(env.OS_PUBLIC_URL).replace(/\/+$/, ''), baseUrl: String(env.OS_BASE_URL).replace(/\/+$/, ''), domain: String(env.APP_DOMAIN), slug: String(env.APP_SLUG), env: appEnv };
}

/** One cookie's value from a Cookie header. */
export function cookieValue(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The caller's app identity token, or null. */
export function sessionFrom(request: Request): string | null {
  const v = cookieValue(request.headers.get('cookie'), APP_SESSION_COOKIE);
  return v && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) ? v : null;
}

/** Does this page request need a sign-in first? (No session cookie.) */
export function needsSignIn(request: Request): boolean {
  return sessionFrom(request) === null;
}

/** The path to come back to after sign-in: a same-origin path only. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !next.startsWith(LOGIN_PATH) && !next.startsWith(CALLBACK_PATH) ? next : '/';
}

/** Where the sign-in starts: `/os/login?next=<path>`. */
export function signInPath(request: Request): string {
  const u = new URL(request.url);
  return `${LOGIN_PATH}?next=${encodeURIComponent(safeNext(u.pathname + u.search))}`;
}

// Web APIs only (btoa/atob, Web Crypto), so this file runs in every Next runtime and in node:test.
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomToken = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

/** This app's callback URL as the browser sees it (the OS accepts only its registered hosts). */
export function callbackUrl(request: Request): string {
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  return `https://${host}${CALLBACK_PATH}`;
}

type LoginState = { s: string; n: string; v: string; r: string };

/** GET /os/login: remember state, nonce and verifier, then send the browser to the OS. */
export async function beginSignIn(request: Request, env: OsEnv = process.env): Promise<Response> {
  const cfg = identityConfig(env);
  const st: LoginState = { s: randomToken(), n: randomToken(), v: randomToken(48), r: safeNext(new URL(request.url).searchParams.get('next')) };
  const q = new URLSearchParams({
    app: `${cfg.domain}/${cfg.slug}`,
    env: cfg.env,
    state: st.s,
    nonce: st.n,
    code_challenge: await s256(st.v),
    code_challenge_method: 'S256',
    redirect_uri: callbackUrl(request),
  });
  return new Response(null, {
    status: 302,
    headers: { location: `${cfg.publicUrl}/api/auth/app-login?${q}`, 'set-cookie': cookie(APP_LOGIN_COOKIE, b64url(new TextEncoder().encode(JSON.stringify(st))), LOGIN_TTL_SEC), 'cache-control': 'no-store' },
  });
}

function readLoginState(request: Request): LoginState | null {
  const raw = cookieValue(request.headers.get('cookie'), APP_LOGIN_COOKIE);
  if (!raw) return null;
  try {
    const st = JSON.parse(new TextDecoder().decode(fromB64url(raw))) as Partial<LoginState>;
    return typeof st.s === 'string' && typeof st.n === 'string' && typeof st.v === 'string' && typeof st.r === 'string' ? (st as LoginState) : null;
  } catch {
    return null;
  }
}

const sameString = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

function refusal(status: number, reason: string, clearLogin = true): Response {
  return new Response(JSON.stringify({ error: 'sign_in_failed', reason }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(clearLogin ? { 'set-cookie': cookie(APP_LOGIN_COOKIE, '', 0) } : {}) },
  });
}

/** GET /os/callback: check state, exchange the code (+ verifier) with the OS, check the nonce, keep the token. */
export async function completeSignIn(request: Request, env: OsEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const cfg = identityConfig(env);
  const url = new URL(request.url);
  const st = readLoginState(request);
  const state = url.searchParams.get('state') ?? '';
  if (!st || !state || !sameString(state, st.s)) return refusal(400, 'the sign-in did not start here (state mismatch); open the app again');
  const error = url.searchParams.get('error');
  if (error) return refusal(error === 'access_denied' ? 403 : 400, error === 'access_denied' ? 'you did not allow this app' : 'the OS refused the sign-in');
  const code = url.searchParams.get('code');
  if (!code) return refusal(400, 'no code');
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/api/auth/app-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: st.v, redirect_uri: callbackUrl(request) }),
      cache: 'no-store',
    });
  } catch {
    return refusal(502, 'the OS could not be reached');
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; nonce?: unknown; error?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== 'string') return refusal(res.status === 403 ? 403 : 401, typeof body?.error === 'string' ? body.error : 'the OS refused the code');
  if (body.nonce !== st.n) return refusal(401, 'nonce mismatch');
  const ttl = typeof body.expires_in === 'number' ? body.expires_in - 30 : 0;
  if (ttl <= 0) return refusal(401, 'the token has no usable lifetime');
  const headers = new Headers({ location: st.r, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  headers.append('set-cookie', cookie(APP_SESSION_COOKIE, body.access_token, ttl));
  headers.append('set-cookie', cookie(APP_LOGIN_COOKIE, '', 0));
  return new Response(null, { status: 303, headers });
}
