/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Mirror push — credentials, scrubbing, status recording and the health row (X2)
 * USER STORY: As a platform admin I want proof that the push sends the token resolved from its
 *             Secret REFERENCE and nothing else, that a failure never leaks the token and never
 *             throws into a save, that the outcome is recorded where the health row reads it, and
 *             that the row is red when the remote is behind.
 * ARCHITECTURE:
 *   - A real bare repo in a temp dir plus a FAKE isomorphic-git HTTP transport (`deps.http`): a
 *     real remote needs a git smart-HTTP server, which is checklist X2's `kind` half. The fake
 *     records the request isomorphic-git actually makes, so the Authorization header, the URL and
 *     the ref are measured through the real library rather than asserted about our own wrapper.
 *   - The success path is driven through an injected `pushFn` (the pack negotiation is the
 *     library's business, the STATUS RECORDING is ours). The admin HEALTH ROW over these signals
 *     is tested beside the row itself (`tabs/admin/lib/components-git-mirror.test.ts`) — core
 *     must not import a tab, not even in a test.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTree, push } from '@core/infra/git-store';
import {
  pushMirror,
  pushMirrorAfterCommit,
  mirrorSignals,
  getMirror,
  __resetMirrors,
  __setMirrorForTests,
  type ProjectMirror,
} from '@core/infra/git-mirror';

let reposDir = '';
const TOKEN = 'ghp_SUPERSECRET_TOKEN_VALUE';
const author = { name: 'Amir Example', email: 'amir@example.com' };

before(async () => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-mirror-'));
  await commitTree('sales', new Map([['dbt_project.yml', 'name: sales\n']]), { author, message: 'data(sales): generate', reposDir });
});
after(() => {
  __resetMirrors();
  rmSync(reposDir, { recursive: true, force: true });
});
beforeEach(() => __resetMirrors());

function configure(domain = 'sales', url = 'https://git.example.com/os/sales.git'): ProjectMirror {
  const rec: ProjectMirror = {
    domain,
    url,
    tokenSecretRef: { name: 'os-git-mirror', key: domain },
    updatedAt: '2026-11-13T00:00:00.000Z',
    updatedBy: 'sara',
    status: {},
  };
  __setMirrorForTests(rec);
  return rec;
}

/**
 * A fake transport. isomorphic-git authenticates LAZILY — it asks `onAuth` only after a 401 — so
 * the fake answers the first request with a 401 challenge and the retry with a 403 whose message
 * embeds the token (the thing a careless implementation would then log).
 */
function fakeHttp(onRequest: (req: { url: string; method?: string; headers?: Record<string, string> }) => void) {
  let n = 0;
  return {
    request: async (req: { url: string; method?: string; headers?: Record<string, string> }) => {
      onRequest(req);
      n += 1;
      const challenge = n === 1;
      return {
        url: req.url,
        method: req.method ?? 'GET',
        statusCode: challenge ? 401 : 403,
        statusMessage: challenge ? 'Unauthorized' : `forbidden for token ${TOKEN}`,
        headers: challenge ? { 'www-authenticate': 'Basic realm="git"' } : {},
        body: (async function* () {
          yield new Uint8Array();
        })(),
      };
    },
  } as unknown as Parameters<typeof push>[2] extends { http?: infer H } ? H : never;
}

test('the push carries the token resolved from its Secret reference — and the error never does', async () => {
  const seen: { url: string; method?: string; headers?: Record<string, string> }[] = [];
  const res = await push(
    'sales',
    { url: 'https://git.example.com/os/sales.git', tokenSecretRef: { name: 'os-git-mirror', key: 'sales' } },
    { reposDir, resolveToken: () => TOKEN, http: fakeHttp((r) => seen.push(r)) },
  );
  assert.equal(res.ok, false);
  assert.ok(seen.length >= 2, 'isomorphic-git retried the request with credentials');
  assert.match(seen[0].url, /^https:\/\/git\.example\.com\/os\/sales\.git\/info\/refs\?service=git-receive-pack$/);
  const auth = Object.entries(seen[1].headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
  assert.match(auth, /^Basic /, 'the token is sent as the HTTP password, never in the URL');
  assert.equal(Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8'), `x-access-token:${TOKEN}`);
  assert.equal(res.ok === false && res.error.includes(TOKEN), false, 'the token is scrubbed from the error');
  assert.match(res.ok === false ? res.error : '', /\*\*\*/);
});

test('a mirror with no token Secret is refused before any request is made', async () => {
  let called = false;
  const res = await push(
    'sales',
    { url: 'https://git.example.com/os/sales.git', tokenSecretRef: { name: 'os-git-mirror', key: 'sales' } },
    { reposDir, resolveToken: () => null, http: fakeHttp(() => { called = true; }) },
  );
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error : '', /is not set/);
  assert.equal(called, false);
});

test('a non-http(s) mirror url is refused (no file:// side door)', async () => {
  const res = await push('sales', { url: 'file:///tmp/evil.git', tokenSecretRef: { name: 'x', key: 'y' } }, { reposDir, resolveToken: () => TOKEN });
  assert.deepEqual(res, { ok: false, error: 'mirror url must be http(s)' });
});

test('a successful push records lastSha/lastPushedAt and clears a previous error', async () => {
  const rec = configure();
  rec.status = { lastError: 'boom', lastErrorAt: '2026-11-12T00:00:00.000Z' };
  const out = await pushMirror('sales', { reposDir, pushFn: async () => ({ ok: true, sha: 'c'.repeat(40) }) });
  assert.deepEqual(out, { ok: true });
  const after = getMirror('sales')!;
  assert.equal(after.status.lastSha, 'c'.repeat(40));
  assert.ok(after.status.lastPushedAt);
  assert.equal(after.status.lastError, undefined, 'a success clears the prior failure');
});

test('a failed push records the scrubbed error and pushMirrorAfterCommit never throws', async () => {
  configure();
  await pushMirrorAfterCommit('sales', 'd'.repeat(40), { reposDir, pushFn: async () => ({ ok: false, error: 'remote rejected (token ***)' }) });
  assert.equal(getMirror('sales')!.status.lastError, 'remote rejected (token ***)');
  // A throwing push is swallowed too — a save is never failed by a mirror.
  await pushMirrorAfterCommit('sales', 'e'.repeat(40), { reposDir, pushFn: async () => { throw new Error('network down'); } });
});

test('no mirror configured ⇒ null, and the after-commit hook is a silent no-op', async () => {
  assert.equal(await pushMirror('sales', { reposDir }), null);
  await pushMirrorAfterCommit('sales', 'f'.repeat(40), { reposDir });
});

test('mirrorSignals exposes the record for the row without any token material', () => {
  configure('finance', 'https://git.example.com/os/finance.git');
  const signals = mirrorSignals();
  assert.deepEqual(signals.map((s) => s.domain), ['finance']);
  assert.equal(JSON.stringify(signals).includes('tokenSecretRef'), false);
  assert.equal(JSON.stringify(signals).includes(TOKEN), false);
});
