/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  type GcpConn,
  type GcpServiceAccount,
  base64url,
  signJwtAssertion,
  parseServiceAccount,
  gcpIdentityHealth,
  gcpListProjects,
  gcpGetIamPolicy,
  gcpListServiceAccounts,
} from './gcp-identity.ts';

// A throwaway RSA key-pair generated IN the test — never a real credential
// (gitleaks-safe). Used to prove the JWT signature verifies against the public key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const SA: GcpServiceAccount = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: PRIV_PEM };

function fakeFetch(script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Headers(r.headers ?? {}), json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

/** A fetch that answers the token endpoint with a bearer, then delegates reads. */
function tokenThen(readScript: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  return fakeFetch((url, init) => {
    if (url.includes('oauth2.googleapis.com/token')) return { status: 200, body: { access_token: 'ya29.fake-token', expires_in: 3600, token_type: 'Bearer' } };
    return readScript(url, init);
  });
}

function conn(fetchImpl: typeof fetch): GcpConn {
  return { sa: SA, fetchImpl };
}

// ---- JWT construction: provably signed by the SA private key ----------------
test('signJwtAssertion builds a 3-part RS256 JWT whose signature verifies with the public key', () => {
  const now = 1_700_000_000_000;
  const jwt = signJwtAssertion(SA, now);
  const [h, c, s] = jwt.split('.');
  assert.ok(h && c && s, 'three base64url parts');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, SA.client_email);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform.read-only');
  assert.equal(claims.iat, Math.floor(now / 1000));
  assert.equal(claims.exp, Math.floor(now / 1000) + 3600);
  // The signature must verify against the SA public key over `<header>.<claims>`.
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB_PEM, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'RS256 signature verifies with the public key (provably correct)');
});

test('signJwtAssertion is deterministic for a fixed clock', () => {
  const a = signJwtAssertion(SA, 1234, { ttlSec: 60 });
  const b = signJwtAssertion(SA, 1234, { ttlSec: 60 });
  assert.equal(a, b);
});

test('base64url is unpadded + URL-safe', () => {
  assert.equal(base64url(Buffer.from([251, 255, 191])), '-_-_');
  assert.ok(!base64url('any padding?').includes('='));
});

// ---- Credential handling ----------------------------------------------------
test('parseServiceAccount accepts JSON, normalizes \\n-escaped PEMs, rejects junk', () => {
  const escaped = JSON.stringify({ client_email: 'x@y', private_key: '-----BEGIN\\nKEY-----' });
  const p = parseServiceAccount(escaped);
  assert.ok(p && p.private_key.includes('\n') && !p.private_key.includes('\\n'), 'literal \\n → real newline');
  assert.equal(parseServiceAccount(''), undefined);
  assert.equal(parseServiceAccount('not json'), undefined);
  assert.equal(parseServiceAccount(JSON.stringify({ client_email: 'x' })), undefined); // no key
});

test('the private key never appears in the outbound headers/body (only the signed JWT does)', async () => {
  const t = tokenThen(() => ({ status: 200, body: { projects: [] } }));
  await gcpListProjects(conn(t.impl));
  const serialized = JSON.stringify(t.calls.map((x) => ({ url: x.url, init: x.init })));
  assert.ok(!serialized.includes('PRIVATE KEY'), 'no PEM material on the wire');
  assert.ok(!serialized.includes(PRIV_PEM.slice(40, 80)), 'no private-key bytes on the wire');
});

// ---- Reads: token exchange then a real read ---------------------------------
test('listProjects exchanges the JWT for a bearer, then reads Cloud Resource Manager', async () => {
  const t = tokenThen((url, init) => {
    assert.ok(url.includes('cloudresourcemanager.googleapis.com/v1/projects'));
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer ya29.fake-token');
    return { status: 200, body: { projects: [{ projectId: 'p1', name: 'Proj One', projectNumber: '42', lifecycleState: 'ACTIVE' }], nextPageToken: 'n' } };
  });
  const r = await gcpListProjects(conn(t.impl));
  assert.ok(r.ok && r.data[0].projectId === 'p1' && r.data[0].state === 'ACTIVE' && r.truncated === true);
  assert.ok(t.calls.some((x) => x.url.includes('oauth2.googleapis.com/token')), 'did a token exchange');
});

test('getIamPolicy POSTs :getIamPolicy and shapes bindings; needs a project id', async () => {
  const empty = await gcpGetIamPolicy(conn(tokenThen(() => ({ status: 200, body: {} })).impl), '');
  assert.ok(!empty.ok && /project id/.test(empty.reason));
  const t = tokenThen((url, init) => {
    assert.ok(url.endsWith(':getIamPolicy'));
    assert.equal(init.method, 'POST');
    return { status: 200, body: { bindings: [{ role: 'roles/viewer', members: ['user:a@x', 'group:g@x'] }] } };
  });
  const r = await gcpGetIamPolicy(conn(t.impl), 'p1');
  assert.ok(r.ok && r.data[0].role === 'roles/viewer' && r.data[0].members.length === 2);
});

test('listServiceAccounts reads IAM and shapes rows; needs a project id', async () => {
  const empty = await gcpListServiceAccounts(conn(tokenThen(() => ({ status: 200, body: {} })).impl), '');
  assert.ok(!empty.ok && /project id/.test(empty.reason));
  const t = tokenThen((url) => {
    assert.ok(url.includes('iam.googleapis.com/v1/projects/p1/serviceAccounts'));
    return { status: 200, body: { accounts: [{ email: 'svc@p1.iam', displayName: 'Svc', uniqueId: '9' }] } };
  });
  const r = await gcpListServiceAccounts(conn(t.impl), 'p1');
  assert.ok(r.ok && r.data[0].email === 'svc@p1.iam');
});

// ---- Honest failure ---------------------------------------------------------
test('no service account ⇒ honest refusal, no request sent', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await gcpListProjects({ sa: undefined, fetchImpl: f.impl });
  assert.ok(!r.ok && /no GCP service-account/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('a rejected token exchange → honest reason (never fabricates data)', async () => {
  const f = fakeFetch((url) => (url.includes('/token') ? { status: 400, body: { error: 'invalid_grant' } } : { status: 200, body: { projects: [] } }));
  const r = await gcpListProjects(conn(f.impl));
  assert.ok(!r.ok && /token exchange rejected/.test(r.reason));
});

test('403 on a read → honest forbidden; 429 → honest rate-limited', async () => {
  const forb = tokenThen(() => ({ status: 403 }));
  assert.match((await gcpListProjects(conn(forb.impl)) as { reason: string }).reason, /forbidden/);
  const rl = tokenThen(() => ({ status: 429, headers: { 'retry-after': '9' } }));
  assert.match((await gcpListProjects(conn(rl.impl)) as { reason: string }).reason, /rate-limited.*9/);
});

test('health: projects 2xx → connected; a rejected key → honest not-connected', async () => {
  const up = tokenThen(() => ({ status: 200, body: { projects: [] } }));
  const h = await gcpIdentityHealth(conn(up.impl));
  assert.ok(h.connected && /reachable/.test(h.detail ?? ''));
  const bad = fakeFetch((url) => (url.includes('/token') ? { status: 401 } : { status: 200 }));
  const h2 = await gcpIdentityHealth(conn(bad.impl));
  assert.ok(!h2.connected);
});

test('a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await gcpListProjects(conn(impl));
  assert.ok(!r.ok && r.reason === 'unreachable');
});
