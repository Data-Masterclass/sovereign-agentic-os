/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, createPublicKey, createHash } from 'node:crypto';
import {
  type SnowflakeGovConn,
  type SnowflakeGovCreds,
  base64url,
  publicKeyFingerprint,
  signSnowflakeJwt,
  snowflakeGovHost,
  parseSnowflakeGovCreds,
  snowflakeGovHealth,
  snowflakeGovListUsers,
  snowflakeGovGrantsToRoles,
  snowflakeGovLoginHistory,
} from './snowflake-governance.ts';

// A throwaway RSA key-pair generated IN the test — never a real credential
// (gitleaks-safe). Used to prove the JWT signature + fingerprint are correct.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const CREDS: SnowflakeGovCreds = { account: 'ORG-ACCT', user: 'gov_reader', privateKeyPem: PRIV_PEM, host: 'org-acct.snowflakecomputing.com' };

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

function conn(fetchImpl: typeof fetch): SnowflakeGovConn {
  return { creds: CREDS, fetchImpl };
}

/** A SQL-API response body: one row, one column. */
function sqlBody(cols: string[], rows: unknown[][]) {
  return { resultSetMetaData: { rowType: cols.map((name) => ({ name })) }, data: rows };
}

// ---- fingerprint: matches Snowflake's SHA256:base64(sha256(DER SPKI)) --------
test('publicKeyFingerprint = SHA256: + base64(sha256(DER SPKI)) derived from the private key', () => {
  const fp = publicKeyFingerprint(PRIV_PEM);
  const der = createPublicKey(PUB_PEM).export({ type: 'spki', format: 'der' });
  const expected = `SHA256:${createHash('sha256').update(der).digest('base64')}`;
  assert.equal(fp, expected, 'fp from private key matches fp from the public key (what Snowflake stores)');
});

// ---- JWT construction: provably signed + correct iss/sub --------------------
test('signSnowflakeJwt builds an RS256 JWT with iss/sub upper-cased + fp, verifying with the public key', () => {
  const now = 1_700_000_000_000;
  const jwt = signSnowflakeJwt(CREDS, now);
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const fp = publicKeyFingerprint(PRIV_PEM);
  assert.equal(claims.sub, 'ORG-ACCT.GOV_READER', 'sub = <ACCOUNT>.<USER> upper-cased');
  assert.equal(claims.iss, `ORG-ACCT.GOV_READER.${fp}`, 'iss = <ACCOUNT>.<USER>.<fp>');
  assert.equal(claims.iat, Math.floor(now / 1000));
  assert.equal(claims.exp, Math.floor(now / 1000) + 3600);
  const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB_PEM, Buffer.from(s, 'base64url'));
  assert.ok(ok, 'RS256 signature verifies with the public key (provably correct)');
});

test('base64url is unpadded + URL-safe', () => {
  assert.equal(base64url(Buffer.from([251, 255, 191])), '-_-_');
});

// ---- host + credential parsing ----------------------------------------------
test('snowflakeGovHost normalizes bare locator + full URL; rejects junk', () => {
  assert.equal(snowflakeGovHost('ORG-ACCT'), 'org-acct.snowflakecomputing.com');
  assert.equal(snowflakeGovHost('https://ORG-ACCT.snowflakecomputing.com'), 'org-acct.snowflakecomputing.com');
  assert.equal(snowflakeGovHost('bad host!'), '');
  assert.equal(snowflakeGovHost(''), '');
});

test('parseSnowflakeGovCreds splits account:user:PEM (PEM keeps its colons/newlines); rejects malformed', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----';
  const p = parseSnowflakeGovCreds(`ORG-ACCT:gov_reader:${pem}`);
  assert.ok(p && p.account === 'ORG-ACCT' && p.user === 'gov_reader');
  assert.ok(p!.privateKeyPem.includes('\n') && !p!.privateKeyPem.includes('\\n'), 'literal \\n → newline');
  assert.equal(p!.host, 'org-acct.snowflakecomputing.com');
  assert.equal(parseSnowflakeGovCreds(''), undefined);
  assert.equal(parseSnowflakeGovCreds('only-account'), undefined);
  assert.equal(parseSnowflakeGovCreds('acct:user'), undefined); // no PEM segment
});

test('the RSA private key never appears in the outbound headers/body (only the JWT does)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: sqlBody(['NAME'], [['ada']]) }));
  await snowflakeGovListUsers(conn(f.impl));
  const serialized = JSON.stringify(f.calls);
  assert.ok(!serialized.includes('PRIVATE KEY'));
  assert.ok(!serialized.includes(PRIV_PEM.slice(40, 80)), 'no private-key bytes on the wire');
});

// ---- reads: real key-pair-JWT round-trip over the SQL REST API ---------------
test('listUsers POSTs a bounded SELECT to /api/v2/statements with a KEYPAIR_JWT bearer + shapes rows', async () => {
  const f = fakeFetch((url, init) => {
    assert.ok(url === 'https://org-acct.snowflakecomputing.com/api/v2/statements');
    assert.equal(init.method, 'POST');
    const h = init.headers as Record<string, string>;
    assert.ok(h.authorization?.startsWith('Bearer '));
    assert.equal(h['x-snowflake-authorization-token-type'], 'KEYPAIR_JWT');
    const body = JSON.parse(String(init.body));
    assert.ok(/ACCOUNT_USAGE\.USERS/.test(body.statement) && /LIMIT/.test(body.statement), 'bounded ACCOUNT_USAGE SELECT');
    return { status: 200, body: sqlBody(['NAME', 'DISABLED'], [['ADA', 'false'], ['BOB', 'true']]) };
  });
  const r = await snowflakeGovListUsers(conn(f.impl));
  assert.ok(r.ok && (r.data[0] as Record<string, unknown>).NAME === 'ADA');
});

test('grantsToRoles + loginHistory query ACCOUNT_USAGE and shape objects from data+rowType', async () => {
  const g = fakeFetch(() => ({ status: 200, body: sqlBody(['GRANTEE_NAME', 'PRIVILEGE'], [['ANALYST', 'USAGE']]) }));
  const rg = await snowflakeGovGrantsToRoles(conn(g.impl));
  assert.ok(rg.ok && (rg.data[0] as Record<string, unknown>).PRIVILEGE === 'USAGE');
  const l = fakeFetch((_u, init) => {
    assert.ok(/LOGIN_HISTORY/.test(JSON.parse(String(init.body)).statement));
    return { status: 200, body: sqlBody(['USER_NAME', 'IS_SUCCESS'], [['ADA', 'YES']]) };
  });
  const rl = await snowflakeGovLoginHistory(conn(l.impl));
  assert.ok(rl.ok && (rl.data[0] as Record<string, unknown>).USER_NAME === 'ADA');
});

// ---- honest failure ---------------------------------------------------------
test('no credential ⇒ honest refusal, no request sent', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await snowflakeGovListUsers({ creds: undefined, fetchImpl: f.impl });
  assert.ok(!r.ok && /no Snowflake key-pair/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('401 → honest unauthorized; 403 → IMPORTED PRIVILEGES hint; 429 → rate-limited', async () => {
  assert.match((await snowflakeGovListUsers(conn(fakeFetch(() => ({ status: 401 })).impl)) as { reason: string }).reason, /unauthorized/);
  assert.match((await snowflakeGovListUsers(conn(fakeFetch(() => ({ status: 403 })).impl)) as { reason: string }).reason, /IMPORTED PRIVILEGES/);
  assert.match((await snowflakeGovListUsers(conn(fakeFetch(() => ({ status: 429, headers: { 'retry-after': '7' } })).impl)) as { reason: string }).reason, /rate-limited.*7/);
});

test('health: CURRENT_ACCOUNT() 2xx → connected; 401 → honest not-connected', async () => {
  const up = fakeFetch((_u, init) => {
    assert.ok(/CURRENT_ACCOUNT/.test(JSON.parse(String(init.body)).statement));
    return { status: 200, body: sqlBody(['ACCOUNT'], [['ORG-ACCT']]) };
  });
  const h = await snowflakeGovHealth(conn(up.impl));
  assert.ok(h.connected && /ORG-ACCT/.test(h.detail ?? ''));
  const h2 = await snowflakeGovHealth(conn(fakeFetch(() => ({ status: 401 })).impl));
  assert.ok(!h2.connected);
});

test('a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await snowflakeGovListUsers(conn(impl));
  assert.ok(!r.ok && r.reason === 'unreachable');
});
