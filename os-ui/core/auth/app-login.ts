/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - the app sign-in flow: login → (consent) → one-time code → token exchange
 * USER STORY: As a user opening an app built in the OS I want to sign in with my OS account, see once what the app
 *             may do as me, and land back in the app; as the OS owner I want no other site to be able to receive
 *             that sign-in and no app to get more than its declared, consented scope.
 * ARCHITECTURE:
 *   - The route handlers (`app/api/auth/app-{login,consent,token}`) are thin; the decisions live here, with their
 *     collaborators injected (`LoginDeps`), so every branch is unit-tested without Next.js.
 *   - LOGIN `GET /api/auth/app-login?app=<domain>/<slug>&env=<env>&state&nonce?&code_challenge&code_challenge_method=S256
 *     &redirect_uri=https://<registered host>/os/callback`: requires the OS session (sign-in round trip if absent),
 *     the app must be visible to the user, the redirect URI must be EXACTLY `https://<host>/os/callback` for a host
 *     registered for that app and env (prod host; dev host and the two preview slots for dev). Anything wrong before
 *     the redirect URI is proven renders an error page and NEVER redirects (no open redirect). Consent missing or
 *     narrower than what the app needs now ⇒ the consent screen; else a 60 s single-use code bound to user, app,
 *     env, redirect URI and challenge.
 *   - CONSENT: approve stores the record (OPA `app_consent_write`, own record only) and continues the login; deny
 *     returns `error=access_denied` to the app. Both are audited.
 *   - EXCHANGE `POST /api/auth/app-token { code, code_verifier, redirect_uri }` over the cluster network: PKCE, the
 *     user is re-read (deactivated ⇒ refused), the app re-resolved, consent re-checked, OPA `app_token_issue`, then a
 *     15 min token. Audited with the token's fingerprint, never the token.
 */
import 'server-only';
import {
  appTokenScope,
  isAppTokenEnv,
  isSubset,
  tokenFingerprint,
  type AppPrincipal,
  type AppTokenApp,
  type AppTokenEnv,
  type AppTokenPort,
} from '@core/auth/app-token';
import { consentCovers, requiredConsent, type AppConsent } from '@core/auth/app-consent';
import {
  LoginCodeError,
  isCodeChallenge,
  isOpaqueParam,
  issueLoginCode,
  parkPendingLogin,
  redeemLoginCode,
  takePendingLogin,
  type PendingLogin,
} from '@core/auth/app-login-codes';

export const APP_CALLBACK_PATH = '/os/callback';

export type AppAuthEvent = 'app.login' | 'app.consent.approve' | 'app.consent.deny' | 'app.consent.revoke' | 'app.token.issue' | 'app.token.refused';
export type AuditFn = (e: { event: AppAuthEvent; actor: string; app: Pick<AppTokenApp, 'id' | 'domain' | 'slug'> | null; env: AppTokenEnv | null; outcome: 'allow' | 'deny' | 'info'; detail?: Record<string, unknown>; decisionId?: string; policyRev?: string }) => void;
export type AuthorizeFn = (kind: 'consent-grant' | 'token-issue', user: AppPrincipal, target: { app: string; env: AppTokenEnv; scope?: string[] }) => Promise<{ allowed: boolean; decisionId?: string; policyRev?: string }>;

export type LoginDeps = {
  port: AppTokenPort;
  consentFor: (userId: string, app: AppTokenApp, env: AppTokenEnv) => Promise<AppConsent | null | undefined>;
  audit: AuditFn;
  now?: () => number;
};

export type LoginOutcome =
  | { kind: 'error'; status: number; error: string }
  | { kind: 'signin' }
  | { kind: 'consent'; requestId: string }
  | { kind: 'redirect'; location: string };

export type LoginRequest = {
  domain: string;
  slug: string;
  env: AppTokenEnv;
  state: string;
  nonce?: string;
  codeChallenge: string;
  redirectUri: string;
};

/** Validate the login query. Errors are typed codes (rendered as a page, never a redirect). */
export function parseLoginRequest(sp: URLSearchParams): { ok: true; req: LoginRequest } | { ok: false; error: string } {
  const app = sp.get('app') ?? '';
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})$/.exec(app);
  if (!m) return { ok: false, error: 'invalid_app' };
  const env = sp.get('env');
  if (!isAppTokenEnv(env)) return { ok: false, error: 'invalid_env' };
  const state = sp.get('state');
  if (!isOpaqueParam(state)) return { ok: false, error: 'invalid_state' };
  const nonce = sp.get('nonce');
  if (nonce !== null && !isOpaqueParam(nonce)) return { ok: false, error: 'invalid_nonce' };
  if (sp.get('code_challenge_method') !== 'S256') return { ok: false, error: 'pkce_s256_required' };
  const codeChallenge = sp.get('code_challenge');
  if (!isCodeChallenge(codeChallenge)) return { ok: false, error: 'invalid_code_challenge' };
  const redirectUri = sp.get('redirect_uri') ?? '';
  if (!redirectUri) return { ok: false, error: 'invalid_redirect_uri' };
  return { ok: true, req: { domain: m[1], slug: m[2], env, state, ...(nonce ? { nonce } : {}), codeChallenge, redirectUri } };
}

/**
 * The redirect URI, exactly `https://<host>/os/callback` with `<host>` one of the app's registered callback hosts for
 * that env (no port, no user info, no query, no fragment). Returns the canonical URI or null.
 */
export function registeredRedirectUri(app: Pick<AppTokenApp, 'callbackHosts'>, env: AppTokenEnv, uri: string): string | null {
  if (!URL.canParse(uri)) return null;
  const u = new URL(uri);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
  if (u.pathname !== APP_CALLBACK_PATH) return null;
  const canonical = `https://${u.hostname}${APP_CALLBACK_PATH}`;
  if (uri !== canonical) return null; // no case or encoding games: the app sends the exact string
  return app.callbackHosts[env].includes(u.hostname) ? canonical : null;
}

/** The callback URL with the given params (the app's own state echoed back). */
export function callbackLocation(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

const sameScope = (a: readonly string[], b: readonly string[]) => a.length === b.length && isSubset(a, b);

function codeFor(user: AppPrincipal, app: AppTokenApp, p: Omit<LoginRequest, 'domain' | 'slug'>, now: number): string {
  return issueLoginCode(
    { userId: user.id, appId: app.id, domain: app.domain, slug: app.slug, env: p.env, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, scope: appTokenScope(app), ...(p.nonce ? { nonce: p.nonce } : {}) },
    now,
  );
}

/** Step 1: the login request. `user` null ⇒ sign in first (the route bounces to /signin and back). */
export async function startAppLogin(sp: URLSearchParams, user: AppPrincipal | null, deps: LoginDeps): Promise<LoginOutcome> {
  const parsed = parseLoginRequest(sp);
  if (!parsed.ok) return { kind: 'error', status: 400, error: parsed.error };
  if (!user) return { kind: 'signin' };
  const r = parsed.req;
  const app = await deps.port.appFor(user, r.domain, r.slug);
  if (!app) return { kind: 'error', status: 404, error: 'app_not_found' };
  const redirectUri = registeredRedirectUri(app, r.env, r.redirectUri);
  if (!redirectUri) {
    deps.audit({ event: 'app.login', actor: user.id, app, env: r.env, outcome: 'deny', detail: { reason: 'unregistered_redirect_uri' } });
    return { kind: 'error', status: 400, error: 'unregistered_redirect_uri' };
  }
  const now = (deps.now ?? Date.now)();
  const consent = await deps.consentFor(user.id, app, r.env);
  if (consent === undefined) return { kind: 'error', status: 503, error: 'consent_unavailable' };
  if (!consentCovers(consent, requiredConsent(app))) {
    const requestId = parkPendingLogin(
      { userId: user.id, appId: app.id, domain: app.domain, slug: app.slug, env: r.env, redirectUri, codeChallenge: r.codeChallenge, state: r.state, scope: appTokenScope(app), ...(r.nonce ? { nonce: r.nonce } : {}) },
      now,
    );
    deps.audit({ event: 'app.login', actor: user.id, app, env: r.env, outcome: 'info', detail: { consent: consent ? 'widened' : 'required' } });
    return { kind: 'consent', requestId };
  }
  const code = codeFor(user, app, { ...r, redirectUri }, now);
  deps.audit({ event: 'app.login', actor: user.id, app, env: r.env, outcome: 'allow', detail: { scope: appTokenScope(app) } });
  return { kind: 'redirect', location: callbackLocation(redirectUri, { code, state: r.state }) };
}

export type ConsentScreen = { pending: PendingLogin; app: AppTokenApp };

/** What the consent screen shows (the pending request must be this user's and the app still visible). */
export async function consentScreenFor(requestId: string, user: AppPrincipal, deps: Pick<LoginDeps, 'port' | 'now'>, read: (id: string, userId: string) => PendingLogin | null): Promise<ConsentScreen | null> {
  const pending = read(requestId, user.id);
  if (!pending) return null;
  const app = await deps.port.appFor(user, pending.domain, pending.slug, { withNames: true });
  if (!app || app.id !== pending.appId) return null;
  return { pending, app };
}

/** Step 2 (only when consent was missing): the user's decision on the consent screen. */
export async function decideAppConsent(
  requestId: string,
  decision: 'approve' | 'deny',
  user: AppPrincipal,
  deps: LoginDeps & { authorize: AuthorizeFn; grant: (userId: string, app: AppTokenApp, env: AppTokenEnv) => Promise<{ ok: true } | { ok: false; reason: string }> },
): Promise<LoginOutcome> {
  const now = (deps.now ?? Date.now)();
  const pending = takePendingLogin(requestId, user.id, now);
  if (!pending) return { kind: 'error', status: 400, error: 'consent_request_expired' };
  const app = await deps.port.appFor(user, pending.domain, pending.slug);
  if (!app || app.id !== pending.appId) return { kind: 'error', status: 404, error: 'app_not_found' };
  if (decision === 'deny') {
    deps.audit({ event: 'app.consent.deny', actor: user.id, app, env: pending.env, outcome: 'deny' });
    return { kind: 'redirect', location: callbackLocation(pending.redirectUri, { error: 'access_denied', state: pending.state }) };
  }
  // The app changed between the screen and the click (a deploy widened or narrowed it): show the new screen.
  if (!sameScope(appTokenScope(app), pending.scope)) {
    const again = parkPendingLogin({ ...pending, scope: appTokenScope(app) }, now);
    return { kind: 'consent', requestId: again };
  }
  const authz = await deps.authorize('consent-grant', user, { app: `${app.domain}/${app.slug}`, env: pending.env });
  if (!authz.allowed) {
    deps.audit({ event: 'app.consent.approve', actor: user.id, app, env: pending.env, outcome: 'deny', detail: { reason: 'policy' }, decisionId: authz.decisionId, policyRev: authz.policyRev });
    return { kind: 'error', status: 403, error: 'consent_not_allowed' };
  }
  const saved = await deps.grant(user.id, app, pending.env);
  if (!saved.ok) return { kind: 'error', status: 503, error: 'consent_unavailable' };
  deps.audit({ event: 'app.consent.approve', actor: user.id, app, env: pending.env, outcome: 'allow', detail: { ...requiredConsent(app) }, decisionId: authz.decisionId, policyRev: authz.policyRev });
  const code = codeFor(user, app, { env: pending.env, state: pending.state, codeChallenge: pending.codeChallenge, redirectUri: pending.redirectUri, ...(pending.nonce ? { nonce: pending.nonce } : {}) }, now);
  return { kind: 'redirect', location: callbackLocation(pending.redirectUri, { code, state: pending.state }) };
}

export type ExchangeDeps = LoginDeps & {
  principal: (id: string) => Promise<AppPrincipal | null>;
  authorize: AuthorizeFn;
  mint: (user: AppPrincipal, app: AppTokenApp, env: AppTokenEnv, scope: string[], nonce?: string) => Promise<{ token: string; expiresIn: number; jti: string }>;
};

export type ExchangeResult = { status: number; body: Record<string, unknown> };

const refused = (error: string, reason: string, status = 400): ExchangeResult => ({ status, body: { error, error_description: reason } });

/** Step 3: the app server exchanges the code (+ PKCE verifier + the same redirect URI) for a token. */
export async function exchangeAppCode(body: unknown, deps: ExchangeDeps): Promise<ExchangeResult> {
  const b = (body ?? {}) as { code?: unknown; code_verifier?: unknown; redirect_uri?: unknown; grant_type?: unknown };
  if (b.grant_type !== undefined && b.grant_type !== 'authorization_code') return refused('unsupported_grant_type', 'only authorization_code');
  const now = (deps.now ?? Date.now)();
  let binding;
  try {
    binding = redeemLoginCode(b.code, { verifier: b.code_verifier, redirectUri: b.redirect_uri }, now);
  } catch (e) {
    if (e instanceof LoginCodeError) {
      deps.audit({ event: 'app.token.refused', actor: 'unknown', app: null, env: null, outcome: 'deny', detail: { reason: e.message } });
      return refused('invalid_grant', e.message);
    }
    throw e;
  }
  const deny = (reason: string, app: AppTokenApp | null = null, status = 400): ExchangeResult => {
    deps.audit({ event: 'app.token.refused', actor: binding.userId, app: app ?? { id: binding.appId, domain: binding.domain, slug: binding.slug }, env: binding.env, outcome: 'deny', detail: { reason } });
    return refused(status === 403 ? 'access_denied' : 'invalid_grant', reason, status);
  };
  const user = await deps.principal(binding.userId);
  if (!user) return deny('the user is not active');
  const app = await deps.port.appFor(user, binding.domain, binding.slug);
  if (!app || app.id !== binding.appId) return deny('the app is not visible to the user');
  const scope = appTokenScope(app);
  if (!sameScope(scope, binding.scope)) return deny('the app changed since sign-in; sign in again', app);
  const consent = await deps.consentFor(user.id, app, binding.env);
  if (consent === undefined) return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'consent could not be checked' } };
  if (!consentCovers(consent, requiredConsent(app))) return deny('consent required', app);
  const authz = await deps.authorize('token-issue', user, { app: `${app.domain}/${app.slug}`, env: binding.env, scope });
  if (!authz.allowed) return deny('policy did not allow the token', app, 403);
  const minted = await deps.mint(user, app, binding.env, scope, binding.nonce);
  deps.audit({ event: 'app.token.issue', actor: user.id, app, env: binding.env, outcome: 'allow', detail: { scope, jti: minted.jti, fingerprint: tokenFingerprint(minted.token) }, decisionId: authz.decisionId, policyRev: authz.policyRev });
  return {
    status: 200,
    body: { access_token: minted.token, token_type: 'Bearer', expires_in: minted.expiresIn, scope: scope.join(' '), ...(binding.nonce ? { nonce: binding.nonce } : {}) },
  };
}
