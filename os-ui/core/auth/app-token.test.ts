/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests of the app identity token (App Builder E): keys, mint/verify, scope, the route allowlist, and
 *             accepting a bearer with the user's role re-read on every call.
 * USER STORY: As the OS owner I want proof that a token only works for its app and env, for 15 minutes, signed by a
 *             key we hold, only on the allowlisted routes, only inside the app's grants and the user's consent, and
 *             that a demoted or deactivated user loses access at once.
 * ARCHITECTURE: Real `jose` signing with throwaway Ed25519 keys (node:crypto); the port, principal and consent are
 *               injected, so no Next request, OpenSearch or OPA is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  APP_TOKEN_ROUTES,
  AppTokenRejected,
  AppTokenUnavailable,
  appTokenJwks,
  appTokenRouteDecision,
  appTokenScope,
  authenticateAppBearer,
  importKeySet,
  looksLikeAppToken,
  matchAppTokenRoute,
  mintAppToken,
  parseAudience,
  verifyAppToken,
  type AppPrincipal,
  type AppTokenApp,
  type AppTokenPort,
  type ConsentView,
  type KeySource,
} from '@core/auth/app-token';

function jwk(kid: string) {
  const k = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k.d, kid };
}
let version = 0;
function source(keys: unknown[]): KeySource {
  const v = String(++version);
  return { id: `test-${v}`, version: async () => v, read: async () => JSON.stringify({ keys }) };
}
const K1 = jwk('k1');
const K2 = jwk('k2');
const keys = source([K1]);
const ISS = 'https://os.example';
const NOW = Date.parse('2026-11-27T10:00:00Z');

function app(over: Partial<AppTokenApp> = {}): AppTokenApp {
  return {
    id: 'app-1',
    name: 'Orders',
    domain: 'sales',
    slug: 'orders',
    // The contracts' appAudience; equality with it is pinned in tabs/software/lib/app-token-port.test.ts.
    audience: { dev: 'app:sales/orders:dev', prod: 'app:sales/orders:prod' },
    callbackHosts: { prod: ['orders.sales.apps.example'], dev: ['orders.sales.dev.apps.example', 'orders-p1.sales.dev.apps.example', 'orders-p2.sales.dev.apps.example'] },
    reads: [{ kind: 'data', id: 'ds-1', name: 'Orders' }, { kind: 'files', id: 'f-1', name: 'Policy.pdf' }],
    agents: [{ id: 'review', name: 'review' }],
    writeActions: [{ name: 'add_order', description: 'Record an order', scopes: ['records'] }],
    recordsDeclared: true,
    ...over,
  };
}
const ALICE: AppPrincipal = { id: 'alice', name: 'Alice', role: 'creator', domains: ['sales'] };
const fullConsent = (a: AppTokenApp): ConsentView => ({ scopes: appTokenScope(a), reads: a.reads.map((r) => `${r.kind}:${r.id}`), agents: a.agents.map((x) => x.id) });

async function mint(a: AppTokenApp = app(), env: 'dev' | 'prod' = 'dev', over: { keys?: KeySource; now?: number; scope?: string[] } = {}) {
  return (await mintAppToken({ id: 'alice' }, { app: a, env, scope: over.scope ?? appTokenScope(a), nonce: 'n0nce-value' }, { keys: over.keys ?? keys, issuer: ISS, now: () => over.now ?? NOW })).token;
}

test('scope: read always, agent-run with agent grants, one action:<name> per declared WRITE action, never a forbidden scope', () => {
  assert.deepEqual(appTokenScope(app()), ['action:add_order', 'agent-run', 'read']);
  assert.deepEqual(appTokenScope(app({ agents: [], writeActions: [] })), ['read']);
  assert.deepEqual(appTokenScope(app({ agents: [], writeActions: [{ name: 'Bad Name', description: '', scopes: [] }, { name: 'admin', description: '', scopes: [] }] })), ['action:admin', 'read']);
  assert.ok(!appTokenScope(app()).some((s) => ['approval-decide', 'admin', 'write', 'governed-write'].includes(s)));
});

test('mint → verify: issuer, exact audience from the contracts (domain in it), kid, typ, 15 minutes, nonce; no role or domains inside', async () => {
  const token = await mint();
  assert.ok(looksLikeAppToken(token));
  const claims = await verifyAppToken(token, { audience: 'app:sales/orders:dev' }, { keys, issuer: ISS, now: () => NOW });
  assert.equal(claims.sub, 'alice');
  assert.equal(claims.aud, 'app:sales/orders:dev');
  assert.equal(claims.exp - claims.iat, 15 * 60);
  assert.equal(claims.nonce, 'n0nce-value');
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
  assert.equal(payload.role, undefined);
  assert.equal(payload.domains, undefined);
  assert.deepEqual(parseAudience(claims.aud), { domain: 'sales', slug: 'orders', env: 'dev' });
});

test('verify refuses: wrong audience (other env, other domain with the same slug), expired, unknown kid, other issuer, forged signature', async () => {
  const token = await mint();
  const v = (t: string, o: { aud?: string; now?: number; keys?: KeySource; iss?: string } = {}) =>
    verifyAppToken(t, { audience: o.aud }, { keys: o.keys ?? keys, issuer: o.iss ?? ISS, now: () => o.now ?? NOW });
  await assert.rejects(v(token, { aud: 'app:sales/orders:prod' }), AppTokenRejected, 'a Dev token never opens Prod');
  await assert.rejects(v(token, { aud: 'app:hr/orders:dev' }), AppTokenRejected, 'same slug, other domain');
  await assert.rejects(v(token, { now: NOW + 16 * 60_000 }), /expired/);
  await assert.rejects(v(token, { keys: source([K2]) }), /unknown key id/);
  await assert.rejects(v(token, { iss: 'https://evil.example' }), AppTokenRejected);
  const other = await mint(app(), 'dev', { keys: source([{ ...K2, kid: 'k1' }]) }); // same kid, different key
  await assert.rejects(v(other), /signature/);
  await assert.rejects(v('x.y.z'), AppTokenRejected);
});

test('rotation: the first key signs, every key verifies; JWKS serves only public halves', async () => {
  const rotated = source([K2, K1]);
  const old = await mint(app(), 'dev', { keys: source([K1]) });
  const fresh = await mint(app(), 'dev', { keys: rotated });
  assert.equal(JSON.parse(Buffer.from(fresh.split('.')[0], 'base64url').toString()).kid, 'k2');
  await verifyAppToken(old, {}, { keys: rotated, issuer: ISS, now: () => NOW });
  await verifyAppToken(fresh, {}, { keys: rotated, issuer: ISS, now: () => NOW });
  const jwks = await appTokenJwks(rotated);
  assert.deepEqual(jwks.keys.map((k) => k.kid), ['k2', 'k1']);
  assert.ok(jwks.keys.every((k) => k.d === undefined && k.kty === 'OKP' && k.crv === 'Ed25519'));
});

test('a missing or malformed key fails closed: nothing is minted or verified', async () => {
  const missing: KeySource = { id: 'none', version: async () => { throw new AppTokenUnavailable('no key'); }, read: async () => '' };
  await assert.rejects(mintAppToken({ id: 'alice' }, { app: app(), env: 'dev', scope: ['read'] }, { keys: missing, issuer: ISS }), AppTokenUnavailable);
  await assert.rejects(importKeySet('not json'), AppTokenUnavailable);
  await assert.rejects(importKeySet(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: K1.x, kid: 'pub-only' }] })), AppTokenUnavailable);
  await assert.rejects(importKeySet(JSON.stringify({ keys: [K1, K1] })), /twice/);
  await assert.rejects(mintAppToken({ id: 'alice' }, { app: app(), env: 'dev', scope: ['read', 'approval-decide'] }, { keys, issuer: ISS }), /forbidden scope/);
});

test('route allowlist: only the SDK routes; no approvals, no generic writes, no user-wide lists', () => {
  const ok = (m: string, p: string) => matchAppTokenRoute(m, p)?.route.id ?? null;
  assert.equal(ok('GET', '/api/auth/me'), 'whoami');
  assert.equal(ok('GET', '/api/apps/by-slug/orders/context'), 'app-context');
  assert.equal(ok('POST', '/api/apps/by-slug/orders/records'), 'records-add');
  assert.equal(ok('GET', '/api/data/datasets/ds-1/preview'), 'dataset-preview');
  assert.equal(ok('POST', '/api/agents/systems/review/run'), 'agent-run');
  for (const [m, p] of [
    ['POST', '/api/governance/approvals'], ['GET', '/api/governance/approvals'], ['GET', '/api/data/datasets'], ['POST', '/api/data/ask'],
    ['GET', '/api/knowledge/docs'], ['POST', '/api/metrics/explore'], ['GET', '/api/metrics/explore'], ['DELETE', '/api/data/datasets/ds-1'],
    ['POST', '/api/data/datasets/ds-1'], ['POST', '/api/apps/app-1/tool'], ['GET', '/api/auth/app-consent'], ['POST', '/api/mcp'],
    ['GET', '/api/data/datasets/a%2Fb'], ['GET', '/api/files/..'], ['GET', '/api//auth/me'],
  ]) assert.equal(ok(m, p), null, `${m} ${p} is not allowlisted`);
  assert.ok(APP_TOKEN_ROUTES.every((r) => r.method === 'GET' || ['records-add', 'records-export', 'agent-run'].includes(r.id)), 'the only POSTs are records writes and agent runs');
});

test('route decision: grants AND consent by id, agent grants, by-slug resolves to THIS app, records only when declared', () => {
  const a = app();
  const scopes = appTokenScope(a);
  const consent = fullConsent(a);
  const d = (m: string, p: string, ctx: Partial<Parameters<typeof appTokenRouteDecision>[2]> = {}) => {
    const hit = matchAppTokenRoute(m, p)!;
    return appTokenRouteDecision(hit.route, hit.params, { app: a, scopes, consent, bySlugAppId: 'app-1', ...ctx });
  };
  assert.deepEqual(d('GET', '/api/data/datasets/ds-1'), { ok: true });
  assert.equal(d('GET', '/api/data/datasets/ds-2').ok, false, 'not granted to the app');
  assert.equal(d('GET', '/api/data/datasets/ds-1', { consent: { ...consent, reads: [] } }).ok, false, 'granted but not consented');
  assert.equal(d('GET', '/api/files/f-1').ok, true);
  assert.equal(d('POST', '/api/agents/systems/review/run').ok, true);
  assert.equal(d('POST', '/api/agents/systems/other/run').ok, false);
  assert.equal(d('POST', '/api/agents/systems/review/run', { scopes: ['read'] }).ok, false, 'no agent-run scope');
  assert.equal(d('GET', '/api/apps/by-slug/orders/context').ok, true);
  assert.equal(d('GET', '/api/apps/by-slug/invoices/context').ok, false, 'another app');
  assert.equal(d('GET', '/api/apps/by-slug/orders/context', { bySlugAppId: 'app-in-other-domain' }).ok, false, 'same slug in another domain');
  assert.equal(d('POST', '/api/apps/by-slug/orders/records').ok, true);
  assert.equal(d('POST', '/api/apps/by-slug/orders/records', { scopes: ['agent-run', 'read'] }).ok, false, 'no write action scope');
  assert.equal(d('GET', '/api/apps/by-slug/orders/records', { app: app({ recordsDeclared: false }) }).ok, false, 'records not declared');
});

function deps(over: { principal?: AppPrincipal | null; consent?: ConsentView | null | 'down'; app?: AppTokenApp | null; bySlug?: string } = {}) {
  const a = over.app === undefined ? app() : over.app;
  const port: AppTokenPort = { appFor: async (p) => (p && a ? a : null), bySlugFor: async () => over.bySlug ?? 'app-1' };
  return {
    principal: async () => (over.principal === undefined ? ALICE : over.principal),
    consent: async () => (over.consent === 'down' ? undefined : over.consent === undefined ? fullConsent(app()) : over.consent),
    port,
    keys,
    issuer: ISS,
    now: () => NOW,
  };
}

test('accepting a bearer: the role and domains are the user record NOW, and the audit marker is the audience', async () => {
  const token = await mint();
  const ok = await authenticateAppBearer(token, 'GET', '/api/auth/me', deps());
  assert.equal(ok.principal.role, 'creator');
  assert.equal(ok.via, 'app:sales/orders:dev');
  const demoted = await authenticateAppBearer(token, 'GET', '/api/auth/me', deps({ principal: { ...ALICE, role: 'viewer', domains: [] } }));
  assert.equal(demoted.principal.role, 'viewer', 'the same valid token carries the demoted role, not the old one');
  assert.deepEqual(demoted.principal.domains, []);
});

test('accepting a bearer refuses: deactivated user, unseeable app, revoked or narrower consent, consent store down, scope beyond the app now, wrong route', async () => {
  const token = await mint();
  const r = (o: Parameters<typeof deps>[0], m = 'GET', p = '/api/auth/me') => authenticateAppBearer(token, m, p, deps(o));
  await assert.rejects(r({ principal: null }), /not active/);
  await assert.rejects(r({ app: null }), /not visible/);
  await assert.rejects(r({ consent: null }), /no consent/);
  await assert.rejects(r({ consent: { scopes: ['read'], reads: [], agents: [] } }), /no consent/, 'consent narrower than the token');
  await assert.rejects(r({ consent: 'down' }), /could not be checked/);
  await assert.rejects(r({ app: app({ agents: [], writeActions: [] }) }), /exceeds/, 'a removed grant shrinks the scope at once');
  await assert.rejects(r({}, 'POST', '/api/governance/approvals'), /does not accept/);
  await assert.rejects(r({}, 'GET', '/api/apps/by-slug/orders/context').then(() => r({ bySlug: 'other' }, 'GET', '/api/apps/by-slug/orders/context')), /another app/);
  const prodToken = await mint(app(), 'prod');
  await authenticateAppBearer(prodToken, 'GET', '/api/auth/me', deps());
  await assert.rejects(authenticateAppBearer(prodToken, 'GET', '/api/auth/me', deps({ app: app({ audience: { dev: 'app:sales/orders:dev', prod: 'app:sales/other:prod' } }) })), /audience/);
});
