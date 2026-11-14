/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive endpoint is authenticated on EVERY phase, and fails closed
 * USER STORY: As the owner I want proof that nobody can drive the endpoint that holds a
 *             repository lock and reconciles the registry without the credential that opened the
 *             push — including the `post` and `abort` phases, which the first version left open
 *             because it gated them on a service bearer that is empty by default (review H-1).
 * ARCHITECTURE:
 *   - Direct unit tests over `handleReceive` (the route is a shell over it; a test may not import
 *     a route). A real temp-dir bare repo, so `pre` reaches the real gate.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { abortReceive, leaseHolder, MAX_FILE_BYTES, registerRepoKind, __clearRepoKinds, __openLeases } from '@core/infra/git-receive';
import { handleReceive } from '@core/infra/git-receive-server';
import { AUTH_FAILED } from '@core/auth/git-http-auth';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';

const ALEX = { id: 'alex', name: 'Alex', role: 'builder', domains: ['sales'] };
const NADIA = { id: 'nadia', name: 'Nadia', role: 'builder', domains: ['sales'] };
const lookup = async (id: string) => (id === 'alex' ? ALEX : id === 'nadia' ? NADIA : null);

let reposDir = '';
let alexToken = '';
let nadiaToken = '';
let head = '';

const basic = (token: string) => `Basic ${Buffer.from(`git:${token}`).toString('base64')}`;

before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-recv-srv-'));
  await openOrInit('sales', { reposDir });
  const r = await commitTree('sales', new Map([['models/gold/x.sql', 'select 1\n']]), {
    reposDir,
    author: { name: 'Sovereign OS', email: 'os@sovereign.local' },
    message: 'data(sales): generate — via boot:reconcile',
    timestamp: 1_700_000_000,
  });
  head = r.sha;
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

beforeEach(() => {
  __clearRepoKinds();
  __resetAccessTokens();
  abortReceive('sales');
  alexToken = createAccessToken({ userId: 'alex', name: 'laptop' }).token;
  nadiaToken = createAccessToken({ userId: 'nadia', name: 'laptop' }).token;
  registerRepoKind({
    kind: 'spy',
    matches: () => true,
    validate: () => null,
    ingest: async () => ({ kind: 'spy', created: 0, updated: 1, skipped: 0, notes: [] }),
  });
});

const deps = () => ({ lookup, reposDir, serviceBearerToken: '' });
const preBody = () => ({
  phase: 'pre',
  domain: 'sales',
  updates: [{ ref: 'refs/heads/main', oldSha: head, newSha: 'a'.repeat(40), fastForward: true }],
  files: [{ path: 'models/gold/x.sql', status: 'modified', content: Buffer.from('select 2\n').toString('base64') }],
});

test('EVERY phase is 401 without a token — pre, post and abort alike (review H-1)', async () => {
  for (const phase of ['pre', 'post', 'abort'] as const) {
    const out = await handleReceive({ phase, domain: 'sales', updates: [], files: [] }, { gitAuthorization: null, authorization: null }, deps());
    assert.equal(out.status, 401, `${phase} must be 401 without a token`);
    assert.equal(out.body.trim(), AUTH_FAILED);
  }
});

test('EVERY phase is 401 with a token that is not token-shaped, unknown, or for another domain', async () => {
  for (const phase of ['pre', 'post', 'abort'] as const) {
    const junk = await handleReceive({ phase, domain: 'sales' }, { gitAuthorization: basic('hunter2'), authorization: null }, deps());
    assert.equal(junk.status, 401);
    const foreign = await handleReceive({ phase, domain: 'finance' }, { gitAuthorization: basic(alexToken), authorization: null }, deps());
    assert.equal(foreign.status, 404, 'a domain the principal is not in is a 404, never a 403');
  }
});

test('an empty service bearer does NOT open the endpoint — the token is required either way', async () => {
  // This is the exact shape of the bug: `config.serviceBearerToken` is '' by default, and the
  // first version skipped its check and had no other, so `post`/`abort` were unauthenticated.
  const out = await handleReceive({ phase: 'post', domain: 'sales' }, { gitAuthorization: null, authorization: null }, { ...deps(), serviceBearerToken: '' });
  assert.equal(out.status, 401);
});

test('when a service bearer IS configured it is required as WELL, not instead', async () => {
  const withBearer = { ...deps(), serviceBearerToken: 'svc-123' };
  const noBearer = await handleReceive({ phase: 'pre', domain: 'sales' }, { gitAuthorization: basic(alexToken), authorization: null }, withBearer);
  assert.equal(noBearer.status, 403);
  assert.match(noBearer.body, /for the OS receive hook/);
  const wrongBearer = await handleReceive(
    { phase: 'pre', domain: 'sales' },
    { gitAuthorization: basic(alexToken), authorization: 'Bearer nope' },
    withBearer,
  );
  assert.equal(wrongBearer.status, 403);
  // With BOTH, the request reaches the gate (and fails on its own merits — no ref updates).
  const both = await handleReceive(
    { phase: 'pre', domain: 'sales', updates: [], files: [] },
    { gitAuthorization: basic(alexToken), authorization: 'Bearer svc-123' },
    withBearer,
  );
  assert.equal(both.status, 400);
  assert.match(both.body, /no ref updates/);
});

test('post and abort may only be driven by the principal holding the lease', async () => {
  const pre = await handleReceive(preBody(), { gitAuthorization: basic(alexToken), authorization: null }, deps());
  assert.equal(pre.status, 200, pre.body);
  assert.equal(leaseHolder('sales'), 'alex');

  const stolen = await handleReceive({ phase: 'post', domain: 'sales' }, { gitAuthorization: basic(nadiaToken), authorization: null }, deps());
  assert.equal(stolen.status, 403);
  assert.match(stolen.body, /belongs to someone else/);
  assert.equal(__openLeases(), 1, 'a refused post must not release the lease');

  const stolenAbort = await handleReceive({ phase: 'abort', domain: 'sales' }, { gitAuthorization: basic(nadiaToken), authorization: null }, deps());
  assert.equal(stolenAbort.status, 403);
  assert.equal(__openLeases(), 1);

  const mine = await handleReceive({ phase: 'abort', domain: 'sales' }, { gitAuthorization: basic(alexToken), authorization: null }, deps());
  assert.equal(mine.status, 200);
  assert.equal(__openLeases(), 0);
});

test('a missing file list is refused — the OS never reads the quarantine itself (review H-2)', async () => {
  const out = await handleReceive(
    { phase: 'pre', domain: 'sales', updates: preBody().updates },
    { gitAuthorization: basic(alexToken), authorization: null },
    deps(),
  );
  assert.equal(out.status, 400);
  assert.match(out.body, /no file list/);
});

test('content is base64 from the hook, and an oversize file is 413 rather than truncated', async () => {
  const big = { path: 'models/gold/x.sql', status: 'modified', content: Buffer.alloc(MAX_FILE_BYTES + 1, 0x61).toString('base64') };
  const out = await handleReceive(
    { ...preBody(), files: [big] },
    { gitAuthorization: basic(alexToken), authorization: null },
    deps(),
  );
  assert.equal(out.status, 413);
  assert.match(out.body, /larger than this door accepts/);
  assert.equal(__openLeases(), 0);
});

test('the accepted message names the pusher, and a post with no lease still answers 200', async () => {
  const pre = await handleReceive(preBody(), { gitAuthorization: basic(alexToken), authorization: null }, deps());
  assert.equal(pre.status, 200);
  assert.match(pre.body, /accepted 1 file change\(s\) as alex/);
  abortReceive('sales');
  // The push has landed by the time `post` runs; a non-200 would tell the developer it failed.
  const post = await handleReceive({ phase: 'post', domain: 'sales' }, { gitAuthorization: basic(alexToken), authorization: null }, deps());
  assert.equal(post.status, 200);
  assert.match(post.body, /no longer holds a lease/);
});
