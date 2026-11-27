/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests of app sign-in (App Builder E): login → consent → one-time code → token exchange, and consent
 *             grant / revoke / re-ask on a widened app.
 * USER STORY: As the OS owner I want proof that only a registered callback host receives a code, that a code works
 *             once, for a minute, with its PKCE verifier only, that consent is asked once and again when the app
 *             wants more, and that a revoked consent or a deactivated user gets no token.
 * ARCHITECTURE: The flow functions with their collaborators injected (port, consent store in memory, OPA stub,
 *               audit sink, mint stub); the real code store and the real consent module are used.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appTokenScope, type AppPrincipal, type AppTokenApp, type AppTokenPort } from '@core/auth/app-token';
import { callbackLocation, decideAppConsent, exchangeAppCode, parseLoginRequest, registeredRedirectUri, startAppLogin, type AuditFn, type AuthorizeFn } from '@core/auth/app-login';
import { __resetLoginCodesForTests, issueLoginCode, redeemLoginCode, LOGIN_CODE_TTL_MS } from '@core/auth/app-login-codes';
import { __setConsentBackendForTests, consentFor, grantConsent, listConsents, revokeConsent, consentCovers, requiredConsent } from '@core/auth/app-consent';

const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijklmn';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const DEV_HOST = 'orders.sales.dev.apps.example';
const CB = `https://${DEV_HOST}/os/callback`;
const ALICE: AppPrincipal = { id: 'alice', name: 'Alice', role: 'creator', domains: ['sales'] };

let current: AppTokenApp;
function app(over: Partial<AppTokenApp> = {}): AppTokenApp {
  return {
    id: 'app-1', name: 'Orders', domain: 'sales', slug: 'orders',
    audience: { dev: 'app:sales/orders:dev', prod: 'app:sales/orders:prod' },
    callbackHosts: { prod: ['orders.sales.apps.example'], dev: [DEV_HOST, 'orders-p1.sales.dev.apps.example', 'orders-p2.sales.dev.apps.example'] },
    reads: [{ kind: 'data', id: 'ds-1', name: 'Orders' }],
    agents: [],
    writeActions: [{ name: 'add_order', description: 'Record an order', scopes: ['records'] }],
    recordsDeclared: true,
    ...over,
  };
}
const port: AppTokenPort = { appFor: async (p, d, s) => (p && d === current.domain && s === current.slug ? current : null), bySlugFor: async () => current.id };
const audits: Parameters<AuditFn>[0][] = [];
const audit: AuditFn = (e) => void audits.push(e);
let opaAllows = true;
const authorize: AuthorizeFn = async () => ({ allowed: opaAllows });
const deps = () => ({ port, consentFor, audit, authorize, grant: grantConsent });

type Doc = Parameters<Parameters<typeof __setConsentBackendForTests>[0] & object['write']>[1];
let store = new Map<string, unknown>();
let storeDown = false;
beforeEach(() => {
  __resetLoginCodesForTests();
  store = new Map();
  storeDown = false;
  opaAllows = true;
  audits.length = 0;
  current = app();
  __setConsentBackendForTests({
    read: async (u) => (storeDown ? 'unreachable' : ((store.get(u) as never) ?? null)),
    write: async (u, doc: Doc) => (storeDown ? { ok: false, reason: 'down' } : (store.set(u, structuredClone(doc)), { ok: true })),
  });
});

const qs = (over: Record<string, string> = {}) =>
  new URLSearchParams({ app: 'sales/orders', env: 'dev', state: 'state-12345678', nonce: 'nonce-12345678', code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: CB, ...over });

async function codeFromLogin(): Promise<string> {
  const out = await startAppLogin(qs(), ALICE, deps());
  assert.equal(out.kind, 'redirect');
  const u = new URL((out as { location: string }).location);
  assert.equal(u.searchParams.get('state'), 'state-12345678');
  return u.searchParams.get('code')!;
}
const mint = async () => ({ token: 'h.p.s', expiresIn: 900, jti: 'j1' });
const exDeps = (over: Partial<Parameters<typeof exchangeAppCode>[1]> = {}) => ({ ...deps(), principal: async () => ALICE, mint, ...over });

test('login request validation: PKCE S256 required, opaque state/nonce, app = <domain>/<slug>', () => {
  assert.equal(parseLoginRequest(qs()).ok, true);
  assert.deepEqual(parseLoginRequest(qs({ code_challenge_method: 'plain' })), { ok: false, error: 'pkce_s256_required' });
  assert.deepEqual(parseLoginRequest(qs({ code_challenge: 'short' })), { ok: false, error: 'invalid_code_challenge' });
  assert.deepEqual(parseLoginRequest(qs({ state: 'x' })), { ok: false, error: 'invalid_state' });
  assert.deepEqual(parseLoginRequest(qs({ env: 'staging' })), { ok: false, error: 'invalid_env' });
  assert.deepEqual(parseLoginRequest(qs({ app: 'orders' })), { ok: false, error: 'invalid_app' });
});

test('registered callback hosts only: exact https://<host>/os/callback, Prod host for prod, Dev + p1/p2 for dev', () => {
  const a = app();
  assert.equal(registeredRedirectUri(a, 'dev', CB), CB);
  assert.equal(registeredRedirectUri(a, 'dev', 'https://orders-p2.sales.dev.apps.example/os/callback'), 'https://orders-p2.sales.dev.apps.example/os/callback');
  assert.equal(registeredRedirectUri(a, 'prod', CB), null, 'a dev host is not a prod callback');
  assert.equal(registeredRedirectUri(a, 'dev', 'https://orders.sales.apps.example/os/callback'), null, 'the prod host is not a dev callback');
  for (const bad of [`http://${DEV_HOST}/os/callback`, `https://${DEV_HOST}:8443/os/callback`, `https://${DEV_HOST}/os/callback?x=1`, `https://${DEV_HOST}/other`,
    `https://evil.example/os/callback`, `https://${DEV_HOST}.evil.example/os/callback`, `https://u:p@${DEV_HOST}/os/callback`, `https://${DEV_HOST.toUpperCase()}/os/callback`, 'javascript:alert(1)']) {
    assert.equal(registeredRedirectUri(a, 'dev', bad), null, bad);
  }
});

test('login: no session ⇒ sign in; unregistered callback ⇒ error page, never a redirect; unseeable app ⇒ 404', async () => {
  assert.deepEqual(await startAppLogin(qs(), null, deps()), { kind: 'signin' });
  const bad = await startAppLogin(qs({ redirect_uri: 'https://evil.example/os/callback' }), ALICE, deps());
  assert.deepEqual(bad, { kind: 'error', status: 400, error: 'unregistered_redirect_uri' });
  assert.equal(audits.at(-1)?.outcome, 'deny');
  assert.deepEqual(await startAppLogin(qs({ app: 'sales/invoices' }), ALICE, deps()), { kind: 'error', status: 404, error: 'app_not_found' });
});

test('consent required the first time; approve stores it (OPA asked) and continues with a code; next login skips the screen', async () => {
  const first = await startAppLogin(qs(), ALICE, deps());
  assert.equal(first.kind, 'consent');
  const decided = await decideAppConsent((first as { requestId: string }).requestId, 'approve', ALICE, deps());
  assert.equal(decided.kind, 'redirect');
  assert.ok(new URL((decided as { location: string }).location).searchParams.get('code'));
  assert.deepEqual((await consentFor('alice', current, 'dev'))?.scopes, ['action:add_order', 'read']);
  assert.ok(audits.some((e) => e.event === 'app.consent.approve' && e.outcome === 'allow'));
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'redirect', 'consent once per user per app+env');
  assert.equal((await startAppLogin(qs({ env: 'prod', redirect_uri: 'https://orders.sales.apps.example/os/callback' }), ALICE, deps())).kind, 'consent', 'Prod asks separately');
});

test('consent: deny returns access_denied to the app; OPA refusal stores nothing; a request id is single use and per user', async () => {
  const a = (await startAppLogin(qs(), ALICE, deps())) as { requestId: string };
  const denied = await decideAppConsent(a.requestId, 'deny', ALICE, deps());
  assert.equal(new URL((denied as { location: string }).location).searchParams.get('error'), 'access_denied');
  assert.deepEqual(await decideAppConsent(a.requestId, 'approve', ALICE, deps()), { kind: 'error', status: 400, error: 'consent_request_expired' });
  const b = (await startAppLogin(qs(), ALICE, deps())) as { requestId: string };
  assert.equal((await decideAppConsent(b.requestId, 'approve', { ...ALICE, id: 'mallory' }, deps())).kind, 'error', "another user cannot decide alice's request");
  const c = (await startAppLogin(qs(), ALICE, deps())) as { requestId: string };
  opaAllows = false;
  assert.deepEqual(await decideAppConsent(c.requestId, 'approve', ALICE, deps()), { kind: 'error', status: 403, error: 'consent_not_allowed' });
  assert.equal(await consentFor('alice', current, 'dev'), null);
});

test('a widened app (new write action, new grant) asks again; a narrowed one does not', async () => {
  await grantConsent('alice', current, 'dev');
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'redirect');
  current = app({ writeActions: [...app().writeActions, { name: 'cancel_order', description: '', scopes: ['records'] }] });
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'consent', 'new action ⇒ re-consent');
  current = app({ reads: [...app().reads, { kind: 'files', id: 'f-9', name: 'Secret plan' }] });
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'consent', 'new granted item ⇒ re-consent');
  current = app({ writeActions: [] });
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'redirect', 'narrowing never asks');
  assert.equal(consentCovers(await consentFor('alice', app(), 'dev'), requiredConsent(app())), true);
});

test('revoke (My Settings): the record is gone, the next login asks again, the exchange is refused; store down ⇒ not revoked', async () => {
  await grantConsent('alice', current, 'dev');
  const code = await codeFromLogin();
  assert.deepEqual((await listConsents('alice'))?.map((c) => c.key), ['sales/orders:dev']);
  storeDown = true;
  assert.equal((await revokeConsent('alice', 'sales/orders:dev')).ok, false);
  storeDown = false;
  const r = await revokeConsent('alice', 'sales/orders:dev');
  assert.ok(r.ok && r.revoked);
  assert.equal((await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps())).body.error_description, 'consent required');
  assert.equal((await startAppLogin(qs(), ALICE, deps())).kind, 'consent');
});

test('exchange: PKCE verifier, same redirect URI, single use (a replayed code finds nothing), expiry', async () => {
  await grantConsent('alice', current, 'dev');
  const code = await codeFromLogin();
  const ok = await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps());
  assert.equal(ok.status, 200);
  assert.deepEqual({ ...ok.body, access_token: 'x' }, { access_token: 'x', token_type: 'Bearer', expires_in: 900, scope: 'action:add_order read', nonce: 'nonce-12345678' });
  const replay = await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps());
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');

  const c2 = await codeFromLogin();
  const wrongPkce = await exchangeAppCode({ code: c2, code_verifier: 'w'.repeat(43), redirect_uri: CB }, exDeps());
  assert.match(String(wrongPkce.body.error_description), /PKCE/);
  assert.equal((await exchangeAppCode({ code: c2, code_verifier: VERIFIER, redirect_uri: CB }, exDeps())).status, 400, 'a failed attempt consumed the code');

  const c3 = await codeFromLogin();
  assert.match(String((await exchangeAppCode({ code: c3, code_verifier: VERIFIER, redirect_uri: 'https://orders-p1.sales.dev.apps.example/os/callback' }, exDeps())).body.error_description), /redirect_uri/);

  const now = Date.now();
  const c4 = issueLoginCode({ userId: 'alice', appId: 'app-1', domain: 'sales', slug: 'orders', env: 'dev', redirectUri: CB, codeChallenge: CHALLENGE, scope: appTokenScope(current) }, now);
  assert.throws(() => redeemLoginCode(c4, { verifier: VERIFIER, redirectUri: CB }, now + LOGIN_CODE_TTL_MS + 1), /expired/);
});

test('exchange: a deactivated user, an app now unseeable or changed, and an OPA refusal get no token; every refusal is audited', async () => {
  await grantConsent('alice', current, 'dev');
  let code = await codeFromLogin();
  assert.match(String((await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps({ principal: async () => null }))).body.error_description), /not active/);
  code = await codeFromLogin();
  current = app({ id: 'app-recreated' });
  assert.match(String((await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps())).body.error_description), /not visible/);
  current = app();
  code = await codeFromLogin();
  opaAllows = false;
  const refused = await exchangeAppCode({ code, code_verifier: VERIFIER, redirect_uri: CB }, exDeps());
  assert.equal(refused.status, 403);
  assert.ok(audits.filter((e) => e.event === 'app.token.refused').length >= 3);
  assert.ok(!JSON.stringify(audits).includes(VERIFIER), 'no verifier in the audit');
});

test('the callback keeps the app state and nothing else', () => {
  assert.equal(callbackLocation(CB, { code: 'c', state: 's' }), `${CB}?code=c&state=s`);
});
