/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - one-time login codes (PKCE) and pending consent requests for app sign-in
 * USER STORY: As a user signing in to an app built in the OS I want the code that brings me back to the app to work
 *             once, for a minute, only for the app and the browser that asked for it, so a leaked URL is worthless.
 * ARCHITECTURE:
 *   - OAuth 2.1-style authorization code with PKCE S256 (RFC 7636), no client secret: the app holds no standing
 *     credential. A code is 32 random bytes, valid 60 s, bound to user, app, env, the exact redirect URI and the
 *     code challenge; it is consumed on the FIRST redeem attempt whatever the outcome (a replay finds nothing).
 *   - Codes are kept in process memory under their SHA-256 (never the raw code), like the MCP OAuth codes
 *     (core/mcp/oauth.ts): 60 s single-use secrets are deliberately not persisted, so a pod roll only costs a re-login.
 *     os-ui runs one web replica; a second replica would need a shared store (the redeem would miss the code and
 *     answer `invalid_grant`, never succeed wrongly).
 *   - A login that still needs consent parks as a PENDING request (10 min, bound to the user) that the consent screen
 *     reads by an opaque id; nothing of it travels in a URL except that id.
 *   - Both maps are capped; expired entries are swept on every write.
 */
import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { b64urlEncode } from '@core/kernel/base64url';
import type { AppTokenEnv } from '@core/auth/app-token';

export const LOGIN_CODE_TTL_MS = 60_000;
export const PENDING_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;

/** What a code is bound to. */
export type LoginBinding = {
  userId: string;
  appId: string;
  domain: string;
  slug: string;
  env: AppTokenEnv;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  nonce?: string;
};

export class LoginCodeError extends Error {
  readonly code = 'invalid_grant';
  readonly status = 400;
  constructor(reason: string) {
    super(reason);
    this.name = 'LoginCodeError';
  }
}

type CodeEntry = { binding: LoginBinding; expiresAt: number };
export type PendingLogin = Omit<LoginBinding, 'scope'> & { id: string; state: string; scope: string[]; expiresAt: number };

type Store = { codes: Map<string, CodeEntry>; pending: Map<string, PendingLogin> };
const KEY = Symbol.for('soa.core.app-login-codes');
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[KEY]) g[KEY] = { codes: new Map(), pending: new Map() };
  return g[KEY]!;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => b64urlEncode(new Uint8Array(randomBytes(32)));

function sweep<T extends { expiresAt: number }>(m: Map<string, T>, now: number): void {
  for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
  // Still full after the sweep: drop the oldest entries (Map keeps insertion order).
  while (m.size >= MAX_ENTRIES) {
    const first = m.keys().next().value;
    if (first === undefined) break;
    m.delete(first);
  }
}

/** RFC 7636 code challenge shape (S256: 43 base64url characters). */
export const isCodeChallenge = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c);
/** RFC 7636 verifier shape: 43-128 unreserved characters. */
export const isCodeVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
/** The app's opaque `state` / `nonce`: URL-safe, 8-256 characters (no free text travels through the OS). */
export const isOpaqueParam = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{8,256}$/.test(v);

/** S256(verifier) === challenge, in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const got = Buffer.from(b64urlEncode(new Uint8Array(createHash('sha256').update(verifier).digest())));
  const want = Buffer.from(challenge);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Issue a one-time code for `binding`. Returns the raw code (shown once, in the redirect). */
export function issueLoginCode(binding: LoginBinding, now: number = Date.now()): string {
  if (!isCodeChallenge(binding.codeChallenge)) throw new LoginCodeError('invalid code challenge');
  const s = store();
  sweep(s.codes, now);
  const code = random();
  s.codes.set(sha(code), { binding: { ...binding, scope: [...binding.scope] }, expiresAt: now + LOGIN_CODE_TTL_MS });
  return code;
}

/**
 * Redeem a code: single use (consumed on ANY attempt), not expired, the PKCE verifier matches the challenge and the
 * redirect URI is exactly the one the code was issued for. Throws LoginCodeError with a matched reason.
 */
export function redeemLoginCode(code: unknown, proof: { verifier: unknown; redirectUri: unknown }, now: number = Date.now()): LoginBinding {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(code)) throw new LoginCodeError('invalid code');
  const s = store();
  const key = sha(code);
  const entry = s.codes.get(key);
  s.codes.delete(key); // single use: consumed whatever happens next
  if (!entry) throw new LoginCodeError('unknown or already used code');
  if (entry.expiresAt <= now) throw new LoginCodeError('code expired');
  if (!isCodeVerifier(proof.verifier) || !pkceMatches(proof.verifier, entry.binding.codeChallenge)) throw new LoginCodeError('PKCE verification failed');
  if (proof.redirectUri !== entry.binding.redirectUri) throw new LoginCodeError('redirect_uri does not match the code');
  return entry.binding;
}

/** Park a login that needs consent. Returns the opaque request id the consent screen reads. */
export function parkPendingLogin(p: Omit<PendingLogin, 'id' | 'expiresAt'>, now: number = Date.now()): string {
  const s = store();
  sweep(s.pending, now);
  const id = random();
  s.pending.set(id, { ...p, scope: [...p.scope], id, expiresAt: now + PENDING_TTL_MS });
  return id;
}

/** The pending login `id` of `userId`, or null (unknown, expired or another user's). Does not consume it. */
export function readPendingLogin(id: unknown, userId: string, now: number = Date.now()): PendingLogin | null {
  if (typeof id !== 'string' || !id) return null;
  const p = store().pending.get(id);
  if (!p || p.expiresAt <= now || p.userId !== userId) return null;
  return { ...p, scope: [...p.scope] };
}

/** Consume a pending login (consent decided). Returns it, or null as `readPendingLogin`. */
export function takePendingLogin(id: unknown, userId: string, now: number = Date.now()): PendingLogin | null {
  const p = readPendingLogin(id, userId, now);
  if (p) store().pending.delete(p.id);
  return p;
}

/** Test seam. */
export function __resetLoginCodesForTests(): void {
  store().codes.clear();
  store().pending.clear();
}
