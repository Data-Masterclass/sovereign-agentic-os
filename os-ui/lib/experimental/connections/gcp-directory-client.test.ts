/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  type GcpDirConn,
  type GcpDirectoryAccount,
  signDirectoryJwt,
  parseDirectoryAccount,
  gcpDirectoryHealth,
  gcpDirListUsers,
  gcpDirListGroups,
  gcpDirListOrgUnits,
  gcpDirListRoles,
  gcpDirListDomains,
} from './gcp-directory.ts';

// A throwaway RSA key-pair generated IN the test — never a real credential
// (gitleaks-safe). Used to prove the JWT signature verifies against the public key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const SA: GcpDirectoryAccount = {
  client_email: 'svc@proj.iam.gserviceaccount.com',
  private_key: PRIV_PEM,
  subject: 'admin@customer.example',
  customer: 'my_customer',
};

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

function conn(fetchImpl: typeof fetch): GcpDirConn {
  return { sa: SA, fetchImpl };
}

// ---- JWT construction: the DOMAIN-WIDE-DELEGATION `sub` + readonly scope ------
test('signDirectoryJwt sets `sub` = the impersonated admin and the admin.directory.readonly scope', () => {
  const now = 1_700_000_000_000;
  const jwt = signDirectoryJwt(SA, now);
  const [h, c, s] = jwt.split('.');
  assert.ok(h && c && s, 'three base64url parts');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, SA.client_email);
  // The domain-wide-delegation twist: `sub` is the impersonated Workspace admin.
  assert.equal(claims.sub, 'admin@customer.example');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/admin.directory.readonly');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, Math.floor(now / 1000));
  assert.equal(claims.exp, Math.floor(now / 1000) + 3600);
  // The signature must verify against the SA public key over `<header>.<claims>`.
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB_PEM, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'RS256 signature verifies with the public key (provably correct)');
});

test('signDirectoryJwt is deterministic for a fixed clock', () => {
  const a = signDirectoryJwt(SA, 1234, { ttlSec: 60 });
  const b = signDirectoryJwt(SA, 1234, { ttlSec: 60 });
  assert.equal(a, b);
});

// ---- Credential handling ----------------------------------------------------
test('parseDirectoryAccount reads subject/customer from the blob, accepts admin_email alias, defaults customer, rejects junk', () => {
  const full = JSON.stringify({ client_email: 'x@y', private_key: '-----BEGIN\\nKEY-----', subject: 'boss@x', customer: 'C0abc' });
  const p = parseDirectoryAccount(full);
  assert.ok(p && p.subject === 'boss@x' && p.customer === 'C0abc');
  assert.ok(p!.private_key.includes('\n') && !p!.private_key.includes('\\n'), 'literal \\n → real newline');
  // `admin_email` is accepted as an alias for `subject`; customer defaults to my_customer.
  const alias = parseDirectoryAccount(JSON.stringify({ client_email: 'x@y', private_key: 'k', admin_email: 'boss@x' }));
  assert.ok(alias && alias.subject === 'boss@x' && alias.customer === 'my_customer');
  // Missing subject ⇒ undefined (delegation cannot work without an admin to impersonate).
  assert.equal(parseDirectoryAccount(JSON.stringify({ client_email: 'x@y', private_key: 'k' })), undefined);
  assert.equal(parseDirectoryAccount(''), undefined);
  assert.equal(parseDirectoryAccount('not json'), undefined);
});

test('the private key never appears in the outbound headers/body (only the signed JWT does)', async () => {
  const t = tokenThen(() => ({ status: 200, body: { users: [] } }));
  await gcpDirListUsers(conn(t.impl));
  const serialized = JSON.stringify(t.calls.map((x) => ({ url: x.url, init: x.init })));
  assert.ok(!serialized.includes('PRIVATE KEY'), 'no PEM material on the wire');
  assert.ok(!serialized.includes(PRIV_PEM.slice(40, 80)), 'no private-key bytes on the wire');
});

// ---- Reads: token exchange then a real read ---------------------------------
test('listUsers exchanges the JWT for a bearer, then reads the Admin SDK with the customer', async () => {
  const t = tokenThen((url, init) => {
    assert.ok(url.includes('admin.googleapis.com/admin/directory/v1/users'));
    assert.ok(url.includes('customer=my_customer'));
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer ya29.fake-token');
    return { status: 200, body: { users: [{ id: 'u1', primaryEmail: 'ada@x', name: { fullName: 'Ada L' }, isAdmin: true, suspended: false, orgUnitPath: '/Eng' }], nextPageToken: 'n' } };
  });
  const r = await gcpDirListUsers(conn(t.impl));
  assert.ok(r.ok && r.data[0].primaryEmail === 'ada@x' && r.data[0].fullName === 'Ada L' && r.data[0].isAdmin === true && r.truncated === true);
  assert.ok(t.calls.some((x) => x.url.includes('oauth2.googleapis.com/token')), 'did a token exchange');
});

test('listGroups / listOrgUnits / listRoles / listDomains shape their rows', async () => {
  const g = await gcpDirListGroups(conn(tokenThen(() => ({ status: 200, body: { groups: [{ id: 'g1', email: 'eng@x', name: 'Eng', description: 'd', directMembersCount: '3' }] } })).impl));
  assert.ok(g.ok && g.data[0].email === 'eng@x' && g.data[0].directMembersCount === '3');
  const o = await gcpDirListOrgUnits(conn(tokenThen((url) => {
    assert.ok(url.includes('/customer/my_customer/orgunits'));
    return { status: 200, body: { organizationUnits: [{ orgUnitId: 'o1', name: 'Eng', orgUnitPath: '/Eng', parentOrgUnitPath: '/' }] } };
  }).impl));
  assert.ok(o.ok && o.data[0].orgUnitPath === '/Eng');
  const roles = await gcpDirListRoles(conn(tokenThen(() => ({ status: 200, body: { items: [{ roleId: 'r1', roleName: 'Admin', roleDescription: 'd', isSystemRole: true, isSuperAdminRole: true }] } })).impl));
  assert.ok(roles.ok && roles.data[0].roleName === 'Admin' && roles.data[0].isSuperAdminRole === true);
  const d = await gcpDirListDomains(conn(tokenThen(() => ({ status: 200, body: { domains: [{ domainName: 'x.com', isPrimary: true, verified: true }] } })).impl));
  assert.ok(d.ok && d.data[0].domainName === 'x.com' && d.data[0].verified === true);
});

// ---- Honest failure ---------------------------------------------------------
test('no service account ⇒ honest refusal, no request sent', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await gcpDirListUsers({ sa: undefined, fetchImpl: f.impl });
  assert.ok(!r.ok && /no GCP service-account/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('a rejected token exchange → honest reason mentioning the delegation (never fabricates data)', async () => {
  const f = fakeFetch((url) => (url.includes('/token') ? { status: 400, body: { error: 'unauthorized_client' } } : { status: 200, body: { users: [] } }));
  const r = await gcpDirListUsers(conn(f.impl));
  assert.ok(!r.ok && /token exchange rejected/.test(r.reason) && /delegation/.test(r.reason));
});

test('403 on a read → honest forbidden (delegation/subject hint); 429 → honest rate-limited', async () => {
  const forb = tokenThen(() => ({ status: 403 }));
  assert.match((await gcpDirListUsers(conn(forb.impl)) as { reason: string }).reason, /forbidden.*delegation|admin/);
  const rl = tokenThen(() => ({ status: 429, headers: { 'retry-after': '9' } }));
  assert.match((await gcpDirListUsers(conn(rl.impl)) as { reason: string }).reason, /rate-limited.*9/);
});

test('health: users 2xx → connected; a rejected key → honest not-connected', async () => {
  const up = tokenThen((url) => {
    assert.ok(url.includes('maxResults=1'));
    return { status: 200, body: { users: [] } };
  });
  const h = await gcpDirectoryHealth(conn(up.impl));
  assert.ok(h.connected && /reachable/.test(h.detail ?? ''));
  const bad = fakeFetch((url) => (url.includes('/token') ? { status: 401 } : { status: 200 }));
  const h2 = await gcpDirectoryHealth(conn(bad.impl));
  assert.ok(!h2.connected);
});

test('a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await gcpDirListUsers(conn(impl));
  assert.ok(!r.ok && r.reason === 'unreachable');
});
