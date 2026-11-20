/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete-domain run's human gate: a short-lived, single-use confirmation token,
 *             issued after the typed domain id and bound to the browser session that typed it
 * USER STORY: As the admin I want a domain delete to run only because a person signed in to the
 *             OS typed the domain's id a moment ago — never because an agent, an MCP client or a
 *             script holding a token sent the right JSON with the right headers.
 * ARCHITECTURE:
 *   - The run needs the session COOKIE (the human sign-in; `adminCtx` reads only the cookie) and a
 *     token minted for exactly (user, session, domain) within the last 2 minutes. The token is an
 *     HMAC (`config.sessionSecret`) over those plus a nonce and the expiry, so it cannot be forged
 *     or moved to another session or domain; the nonce is spent on first use (in-process: one
 *     os-ui replica serves the admin page, a second process cannot replay a spent nonce here but
 *     could within its own memory until expiry — the 2 min window bounds that).
 *   - Requests carrying an Authorization bearer (MCP, agent, app tokens) are refused outright, and
 *     no header the client sets (Fetch Metadata, Origin) is trusted.
 */
import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';

export const CONFIRM_TTL_MS = 2 * 60 * 1000;

type Binding = { userId: string; sessionCookie: string; domainId: string };

const SPENT = Symbol.for('soa.domain-delete.confirm-spent');
function spent(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[SPENT] ??= new Map());
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function mac(b: Binding, nonce: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${b.userId}\n${sha(b.sessionCookie)}\n${b.domainId}\n${nonce}\n${exp}`).digest('base64url');
}

export function issueConfirmToken(b: Binding, opts: { now?: number; secret?: string } = {}): { token: string; expiresAt: string } {
  if (!b.sessionCookie) throw Object.assign(new Error('A signed-in browser session is required'), { status: 401 });
  const now = opts.now ?? Date.now();
  const exp = now + CONFIRM_TTL_MS;
  const nonce = randomBytes(16).toString('base64url');
  return { token: `${nonce}.${exp}.${mac(b, nonce, exp, opts.secret ?? config.sessionSecret)}`, expiresAt: new Date(exp).toISOString() };
}

/** Verify and SPEND a token. Throws 403 for anything but the exact, fresh, unused binding. */
export function consumeConfirmToken(token: string | undefined, b: Binding, opts: { now?: number; secret?: string } = {}): void {
  const deny = (why: string) => { throw Object.assign(new Error(`Delete run refused: ${why}`), { status: 403 }); };
  const now = opts.now ?? Date.now();
  for (const [n, exp] of spent()) if (exp < now) spent().delete(n);
  if (!b.sessionCookie) deny('no signed-in browser session');
  const [nonce, expS, sig] = (token ?? '').split('.');
  const exp = Number(expS);
  if (!nonce || !sig || !Number.isFinite(exp)) deny('a confirmation token from Admin → Domains is required');
  const want = Buffer.from(mac(b, nonce, exp, opts.secret ?? config.sessionSecret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) deny('the confirmation token is not for this session and domain');
  if (exp < now) deny('the confirmation token expired; type the domain id again');
  if (spent().has(nonce)) deny('the confirmation token was already used');
  spent().set(nonce, exp);
}

/** A run request must come from the cookie session, with no bearer of any kind. */
export function assertHumanSession(headers: Headers, sessionCookie: string | undefined): void {
  if (headers.get('authorization')) throw Object.assign(new Error('Delete run refused: bearer-authenticated clients (MCP, agents, apps) may only plan'), { status: 403 });
  if (!sessionCookie) throw Object.assign(new Error('Delete run refused: no signed-in browser session'), { status: 401 });
}
