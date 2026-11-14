/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Personal access tokens — format, hashing at rest, one-time display, revocation
 * USER STORY: As the owner I want proof that a token is never stored or echoed in the clear, that
 *             it maps to exactly one identity, and that an unknown / revoked / expired token is
 *             indistinguishable to the client (checklist E2, E3's 401 half).
 * ARCHITECTURE:
 *   - Pure unit tests over `access-tokens.ts` + the in-memory half of `access-tokens-store.ts`
 *     (the durable mirror is fire-and-forget and unreachable here, which is the point: an empty
 *     mirror behaves exactly like a tenant that owns no tokens).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, isTokenHash, mintToken, parseAccessToken, redact, tokenFromAuthorization, tokenMatches, TOKEN_RE } from '@core/auth/access-tokens';
import {
  __resetAccessTokens,
  createAccessToken,
  listAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
  MAX_TTL_DAYS,
} from '@core/auth/access-tokens-store';
import { AUTH_FAILED, authenticateGitRequest, parseGitPath } from '@core/auth/git-http-auth';

/**
 * The SECRET half of a token: everything after the second `_`. Base64url includes `_`, so
 * `token.split('_')[2]` is only a FRAGMENT of the secret — and a short fragment can occur by
 * chance inside the hex prefix, which made the first version of the redaction test flaky.
 */
const secretOf = (token: string) => token.split('_').slice(2).join('_');

const alex = { id: 'alex', name: 'Alex', role: 'builder', domains: ['sales'] };
const lookup = async (id: string) => (id === 'alex' ? alex : null);

beforeEach(() => __resetAccessTokens());

test('a minted token is sos_<prefix>_<secret>, and only its hash is storable', () => {
  const m = mintToken();
  assert.match(m.token, TOKEN_RE);
  assert.equal(parseAccessToken(m.token)?.prefix, m.prefix);
  assert.equal(m.hash, hashToken(m.token));
  assert.equal(isTokenHash(m.hash), true);
  // The hash cannot be the token, and the token cannot pass as a hash.
  assert.notEqual(m.hash, m.token);
  assert.equal(isTokenHash(m.token), false);
  assert.equal(tokenMatches(m.token, m.hash), true);
  assert.equal(tokenMatches(`${m.token}x`, m.hash), false);
});

test('two mints never collide and a hash leaks nothing about the secret', () => {
  const a = mintToken();
  const b = mintToken();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.prefix, b.prefix);
  assert.equal(a.hash.includes(secretOf(a.token)), false);
});

test('create shows the token ONCE; the record and every list carry prefix + metadata only', () => {
  const { token, record } = createAccessToken({ userId: 'alex', name: 'laptop' });
  assert.match(token, TOKEN_RE);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'hash'), false);
  const listed = listAccessTokens('alex');
  assert.equal(listed.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(listed[0], 'hash'), false);
  // Nothing anywhere in the serialised record is the token or any part of its secret.
  const secret = secretOf(token);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(JSON.stringify(listed).includes(token), false);
  assert.equal(listed[0].prefix.length, 12);
});

test('a token maps to exactly one identity and nobody else can see or revoke it', () => {
  const mine = createAccessToken({ userId: 'alex', name: 'laptop' });
  createAccessToken({ userId: 'nadia', name: 'laptop' });
  assert.deepEqual(listAccessTokens('alex').map((t) => t.id), [mine.record.id]);
  const resolved = resolveAccessToken(mine.token);
  assert.equal(resolved.ok && resolved.userId, 'alex');
  assert.throws(() => revokeAccessToken('nadia', mine.record.id), /no such token/);
  assert.equal(resolveAccessToken(mine.token).ok, true);
});

test('revoked and expired tokens stop resolving, and an unknown one never did', () => {
  const t = createAccessToken({ userId: 'alex', name: 'laptop' });
  revokeAccessToken('alex', t.record.id);
  assert.deepEqual(resolveAccessToken(t.token), { ok: false, reason: 'revoked' });

  __resetAccessTokens();
  const short = createAccessToken({ userId: 'alex', name: 'ci', ttlDays: 1, now: 0 });
  assert.equal(resolveAccessToken(short.token, { now: 1 }).ok, true);
  assert.deepEqual(resolveAccessToken(short.token, { now: 2 * 24 * 3600_000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(resolveAccessToken(mintToken().token), { ok: false, reason: 'unknown' });
  assert.deepEqual(resolveAccessToken('not-a-token'), { ok: false, reason: 'malformed' });
});

test('a ttl is clamped to MAX_TTL_DAYS and a token always has a name', () => {
  const t = createAccessToken({ userId: 'alex', name: 'forever', ttlDays: 100_000, now: 0 });
  assert.equal(t.record.expiresAt, MAX_TTL_DAYS * 24 * 3600_000);
  assert.throws(() => createAccessToken({ userId: 'alex', name: '  ' }), /needs a name/);
});

test('redact replaces the secret half of any token-shaped string, wherever it appears', () => {
  const { token, prefix } = mintToken();
  const msg = `could not push with ${token} to sales`;
  assert.equal(redact(msg).includes(secretOf(token)), false);
  assert.equal(redact(msg).includes(`sos_${prefix}_***`), true);
});

test('a git client presents the token in Basic auth (either half) or as a Bearer', () => {
  const { token } = mintToken();
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  assert.equal(tokenFromAuthorization(basic('alex', token)), token);
  assert.equal(tokenFromAuthorization(basic(token, '')), token);
  assert.equal(tokenFromAuthorization(`Bearer ${token}`), token);
  assert.equal(tokenFromAuthorization(basic('alex', 'hunter2')), null);
  assert.equal(tokenFromAuthorization(''), null);
  assert.equal(tokenFromAuthorization(undefined), null);
});

test('parseGitPath routes only /git/<domain>.git and classifies read vs write', () => {
  assert.deepEqual(parseGitPath('/git/sales.git/info/refs?service=git-upload-pack'), { domain: 'sales', service: 'upload-pack' });
  assert.deepEqual(parseGitPath('/git/sales.git/info/refs?service=git-receive-pack'), { domain: 'sales', service: 'receive-pack' });
  assert.deepEqual(parseGitPath('/git/sales.git/git-receive-pack'), { domain: 'sales', service: 'receive-pack' });
  assert.deepEqual(parseGitPath('/git/sales.git'), { domain: 'sales', service: 'upload-pack' });
  assert.equal(parseGitPath('/git/../etc/passwd'), null);
  assert.equal(parseGitPath('/api/health'), null);
});

test('no token, an unknown token, a revoked token and a disabled user are all the SAME 401', async () => {
  const t = createAccessToken({ userId: 'alex', name: 'laptop' });
  const uri = '/git/sales.git/info/refs?service=git-upload-pack';
  for (const authorization of [null, `Bearer ${mintToken().token}`, 'Basic ' + Buffer.from('alex:hunter2').toString('base64')]) {
    const out = await authenticateGitRequest({ authorization, uri }, { lookup });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.status, 401);
    assert.equal(out.ok === false && out.message, AUTH_FAILED);
  }
  revokeAccessToken('alex', t.record.id);
  const revoked = await authenticateGitRequest({ authorization: `Bearer ${t.token}`, uri }, { lookup });
  assert.equal(revoked.ok === false && revoked.status, 401);
  assert.equal(revoked.ok === false && revoked.message, AUTH_FAILED);
  // The server-side reason names the PREFIX and never the token.
  assert.equal(revoked.ok === false && revoked.logReason.includes(secretOf(t.token)), false);
});

test('READ IS UNCONDITIONAL for a member, and a non-member is a 404 rather than a 403', async () => {
  const t = createAccessToken({ userId: 'alex', name: 'laptop' });
  const ok = await authenticateGitRequest(
    { authorization: `Bearer ${t.token}`, uri: '/git/sales.git/info/refs' },
    { lookup },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.principal.id, 'alex');
  assert.equal(ok.ok && ok.target.service, 'upload-pack');

  const foreign = await authenticateGitRequest(
    { authorization: `Bearer ${t.token}`, uri: '/git/finance.git/info/refs' },
    { lookup },
  );
  assert.equal(foreign.ok === false && foreign.status, 404);
  assert.equal(foreign.ok === false && foreign.message, 'no such repository');
});

test('the live principal is re-read on every request — a token is not a frozen snapshot', async () => {
  const t = createAccessToken({ userId: 'alex', name: 'laptop' });
  const demoted = await authenticateGitRequest(
    { authorization: `Bearer ${t.token}`, uri: '/git/sales.git/git-receive-pack' },
    { lookup: async () => ({ ...alex, role: 'creator', domains: ['sales'] }) },
  );
  assert.equal(demoted.ok && demoted.principal.role, 'creator');
  const gone = await authenticateGitRequest(
    { authorization: `Bearer ${t.token}`, uri: '/git/sales.git/git-receive-pack' },
    { lookup: async () => null },
  );
  assert.equal(gone.ok === false && gone.status, 401);
});
