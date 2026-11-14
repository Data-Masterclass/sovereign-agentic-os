/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    APP INTENT TOKENS — a governed app's OS calls carry a scoped, signed intent
 * USER STORY: As a user I must not have an app silently start agent runs or approve held writes
 *             on my behalf just because its iframe is same-origin and my session cookie rides
 *             along (review H-1). What the app may ask for is declared, signed, scoped,
 *             time-boxed and bound to ME — and approving is not one of the things it may ask for.
 * ARCHITECTURE:
 *   - WHAT THIS IS. A short-lived HMAC token the OS mints when it RENDERS an app and injects into
 *     the app document (`tabs/software/lib/app-runtime.ts`). The SDK sends it back on the two
 *     sensitive POSTs as `x-os-app-intent`, alongside `x-os-app-origin: app`. The server rejects
 *     a request that CLAIMS to be an app and carries no valid token, and rejects any token whose
 *     scope does not cover the action, whose user is not the session's user, or which has expired.
 *   - WHAT THIS IS NOT, stated plainly because the distinction matters. A same-origin iframe is
 *     indistinguishable from the OS UI by `Origin` / `Sec-Fetch-Site` alone — both are
 *     `same-origin` — so this token cannot by itself stop a HOSTILE app that simply omits the
 *     headers. The enforcement that binds such an app is the INNER-DOCUMENT CSP: the app frame's
 *     `connect-src` allowlist (same file) does not include the governance route at all, so app
 *     JavaScript cannot reach it, whatever headers it sets. This token is what makes the
 *     well-behaved path auditable and what makes the scope split enforceable server-side; the CSP
 *     is what makes the capability absent. Both are required, and neither is claimed to be the
 *     other.
 *   - THE SCOPE SPLIT IS THE POINT. An app's injected token carries `agent-run` ONLY. There is no
 *     code path that mints `approval-decide` for an app, so `os.agents.decide` called from app
 *     code is refused by construction; approving goes through an OS-rendered confirmation in the
 *     host shell, which holds a shell-scoped token (see `app-runtime.ts` and the SDK).
 *   - Pure + dependency-light: `node:crypto` only, no I/O, so mint/verify are unit-tested alone.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';

/** What an intent token may authorise. Deliberately tiny, and deliberately split. */
export const APP_INTENT_SCOPES = ['agent-run', 'approval-decide'] as const;
export type AppIntentScope = (typeof APP_INTENT_SCOPES)[number];

/** The header the SDK sends the token in, and the one that says "I am an app". */
export const APP_INTENT_HEADER = 'x-os-app-intent';
export const APP_ORIGIN_HEADER = 'x-os-app-origin';

/** How long a minted intent is good for. A render is short-lived; so is its intent. */
export const APP_INTENT_TTL_SECONDS = 60 * 60;

/** `Sec-Fetch-Site` values the two guarded POSTs accept at all. */
export const ALLOWED_FETCH_SITES = ['same-origin', 'none'] as const;

export type AppIntent = {
  /** The user the intent was minted FOR. A token is never transferable. */
  userId: string;
  /** The app slug it was minted for (`''` for the host shell). */
  appSlug: string;
  scopes: AppIntentScope[];
  /** Unix seconds. */
  exp: number;
};

function secret(): string {
  return config.sessionSecret;
}

function body(intent: AppIntent): string {
  // Field order is fixed so the signature is stable; `|` cannot appear in a scope or a slug.
  return [intent.userId, intent.appSlug, intent.scopes.join(','), String(intent.exp)].join('|');
}

function sign(b: string): string {
  return createHmac('sha256', secret()).update(b).digest('base64url');
}

/**
 * Mint an intent for `userId` + `appSlug` with exactly `scopes`. The caller decides the scopes,
 * and only ONE caller ever asks for `approval-decide`: the host shell's confirmation flow.
 */
export function mintAppIntent(input: {
  userId: string;
  appSlug: string;
  scopes: AppIntentScope[];
  ttlSeconds?: number;
  now?: number;
}): string {
  const userId = String(input.userId ?? '').trim();
  if (!userId) throw new Error('an app intent needs the acting user');
  const scopes = [...new Set(input.scopes)].filter((s): s is AppIntentScope => (APP_INTENT_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0) throw new Error('an app intent needs at least one known scope');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const intent: AppIntent = {
    userId,
    appSlug: String(input.appSlug ?? '').trim(),
    scopes,
    exp: now + Math.max(1, Math.min(input.ttlSeconds ?? APP_INTENT_TTL_SECONDS, APP_INTENT_TTL_SECONDS)),
  };
  const b = body(intent);
  return `${Buffer.from(b, 'utf8').toString('base64url')}.${sign(b)}`;
}

export type IntentVerdict =
  | { ok: true; intent: AppIntent }
  | { ok: false; reason: string };

/** Verify a token's signature, expiry and shape. Says WHY it failed; never throws. */
export function verifyAppIntent(token: string | null | undefined, now = Math.floor(Date.now() / 1000)): IntentVerdict {
  const raw = String(token ?? '').trim();
  if (!raw) return { ok: false, reason: 'no app intent token was presented' };
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'the app intent token is malformed' };
  const b = Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8');
  const given = Buffer.from(raw.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(b), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'the app intent token signature does not verify' };
  }
  const parts = b.split('|');
  if (parts.length !== 4) return { ok: false, reason: 'the app intent token is malformed' };
  const [userId, appSlug, scopeList, expStr] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'the app intent token is malformed' };
  if (exp <= now) return { ok: false, reason: 'the app intent token has expired — reload the app' };
  const scopes = scopeList
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AppIntentScope => (APP_INTENT_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0) return { ok: false, reason: 'the app intent token carries no known scope' };
  return { ok: true, intent: { userId, appSlug, scopes, exp } };
}

/** The headers the guard reads. A plain object so a test can drive it without a Request. */
export type IntentHeaders = {
  get: (name: string) => string | null;
};

export type GuardVerdict = { ok: true; via: 'app-intent' | 'os-ui' } | { ok: false; status: 403; reason: string };

/**
 * THE GUARD, for a route that a governed app can reach with the ambient session.
 *
 * Rules, in order:
 *   1. `Sec-Fetch-Site`, when the browser sent it, must be in {@link ALLOWED_FETCH_SITES}. A
 *      cross-site POST to either route is refused outright.
 *   2. A request that SAYS it is an app (`x-os-app-origin: app`) MUST present a valid intent
 *      token, minted for the SESSION's user, whose scopes cover `scope`. Anything else is 403
 *      with the reason — a missing token, a forged signature, an expired one, another user's
 *      one, or one without the scope.
 *   3. A request that presents a token must satisfy (2) even if it did not announce itself: a
 *      token is never ignored.
 *   4. A request with neither header is the OS UI's own call and passes (`via: 'os-ui'`). This is
 *      the honest limit of a header-based guard against code that runs on our own origin, and it
 *      is why the app frame's CSP `connect-src` — not this function — is what makes the
 *      governance route unreachable from app JavaScript.
 */
export function guardAppIntent(
  headers: IntentHeaders,
  user: { id: string },
  scope: AppIntentScope,
  now = Math.floor(Date.now() / 1000),
): GuardVerdict {
  const site = headers.get('sec-fetch-site');
  if (site && !(ALLOWED_FETCH_SITES as readonly string[]).includes(site)) {
    return { ok: false, status: 403, reason: `a ${site} request may not ${scope === 'agent-run' ? 'start an agent run' : 'decide an approval'}` };
  }
  const claimsApp = (headers.get(APP_ORIGIN_HEADER) ?? '').trim().toLowerCase() === 'app';
  const token = headers.get(APP_INTENT_HEADER);
  if (!claimsApp && !token) return { ok: true, via: 'os-ui' };

  const verdict = verifyAppIntent(token, now);
  if (!verdict.ok) return { ok: false, status: 403, reason: verdict.reason };
  if (verdict.intent.userId !== user.id) {
    return { ok: false, status: 403, reason: 'the app intent token was minted for a different user' };
  }
  if (!verdict.intent.scopes.includes(scope)) {
    return {
      ok: false,
      status: 403,
      reason:
        scope === 'approval-decide'
          ? 'an app may not decide an approval. The decision is taken in the OS, by you — the app can only ask the OS to show you the confirmation.'
          : `this app intent does not carry the '${scope}' scope`,
    };
  }
  return { ok: true, via: 'app-intent' };
}
