/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Git store unit tests (temp-dir bare repos)
 * USER STORY: As a maintainer I want proof that the one commit path inits, commits only on change,
 *             logs newest-first, reads blobs, exports a tar and formats trailers exactly as specified.
 * ARCHITECTURE:
 *   - Real isomorphic-git against a mkdtemp directory; no network. Push is validated only for its
 *     refusal paths (a remote needs a cluster — checklist X2 is a kind test).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openOrInit,
  commitTree,
  log,
  readBlob,
  listTree,
  archive,
  push,
  commitMessage,
  appendTrailers,
  parseTrailers,
  authorFor,
  repoPath,
  repoExists,
  COMMITTER,
  GitStoreError,
} from '@core/infra/git-store';
import { tarList } from '@core/infra/tar';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-'));
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const alex = { name: 'Alexander Borek', email: 'alex@datamasterclass.com' };

test('openOrInit creates a bare repo on main and is idempotent', async () => {
  assert.equal(repoExists('sales', { reposDir }), false);
  const a = await openOrInit('sales', { reposDir });
  const b = await openOrInit('sales', { reposDir });
  assert.equal(a.gitdir, b.gitdir);
  assert.equal(a.gitdir, repoPath('sales', { reposDir }));
  assert.equal(repoExists('sales', { reposDir }), true);
  assert.deepEqual(await log('sales', { reposDir }), []);
});

test('commitTree commits a nested tree, then returns changed:false for the identical tree', async () => {
  const files = new Map([
    ['dbt_project.yml', 'name: sales\n'],
    ['models/gold/gold_orders.sql', 'select 1\n'],
    ['models/gold/schema.yml', 'version: 2\n'],
  ]);
  const first = await commitTree('sales', files, { reposDir, author: alex, message: 'data(sales): build gold orders — via ui:data', timestamp: 1_700_000_000 });
  assert.equal(first.changed, true);
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  const again = await commitTree('sales', new Map(files), { reposDir, author: alex, message: 'data(sales): rebuild gold orders — via ui:data', timestamp: 1_700_000_100 });
  assert.equal(again.changed, false);
  assert.equal(again.sha, first.sha);
  assert.equal((await log('sales', { reposDir })).length, 1);
});

test('log is newest-first with author = the user and committer = Sovereign OS; blobs read back', async () => {
  const files = new Map([
    ['dbt_project.yml', 'name: sales\n'],
    ['models/gold/gold_orders.sql', 'select 2\n'],
    ['models/gold/schema.yml', 'version: 2\n'],
  ]);
  const second = await commitTree('sales', files, { reposDir, author: alex, message: 'second', timestamp: 1_700_000_200 });
  assert.equal(second.changed, true);
  const entries = await log('sales', { reposDir });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sha, second.sha);
  assert.equal(entries[0].subject, 'second');
  assert.deepEqual(entries[0].author, alex);
  assert.deepEqual(entries[0].committer, { name: COMMITTER.name, email: COMMITTER.email });
  assert.equal(entries[1].parents.length, 0);
  assert.equal(entries[0].parents[0], entries[1].sha);
  assert.equal(await readBlob('sales', 'main', 'models/gold/gold_orders.sql', { reposDir }), 'select 2\n');
  assert.equal(await readBlob('sales', entries[1].sha, 'models/gold/gold_orders.sql', { reposDir }), 'select 1\n');
  assert.equal(await readBlob('sales', second.sha.slice(0, 8), 'dbt_project.yml', { reposDir }), 'name: sales\n');
  await assert.rejects(readBlob('sales', 'main', 'nope.sql', { reposDir }), (e: unknown) => e instanceof GitStoreError && e.status === 404);
  const tree = await listTree('sales', 'main', { reposDir });
  assert.deepEqual(tree.map((t) => t.path), ['dbt_project.yml', 'models/gold/gold_orders.sql', 'models/gold/schema.yml']);
});

test('archive is a ustar tar holding every file at the ref', async () => {
  const { sha, tar } = await archive('sales', 'main', { reposDir });
  assert.match(sha, /^[0-9a-f]{40}$/);
  const listed = tarList(tar);
  assert.deepEqual(listed.map((e) => e.path), ['dbt_project.yml', 'models/gold/gold_orders.sql', 'models/gold/schema.yml']);
  assert.equal(listed[1].content.toString('utf8'), 'select 2\n');
  assert.equal(tar.length % 512, 0);
});

test('a removed file leaves the tree (full-tree semantics)', async () => {
  const r = await commitTree('sales', new Map([['dbt_project.yml', 'name: sales\n']]), { reposDir, author: alex, message: 'retire', timestamp: 1_700_000_300 });
  assert.equal(r.changed, true);
  assert.deepEqual((await listTree('sales', 'main', { reposDir })).map((t) => t.path), ['dbt_project.yml']);
});

test('commitMessage: subject + the four OS trailers; extra trailers join the block', () => {
  const m = commitMessage({ area: 'data', domain: 'sales', action: 'build gold', object: 'order_customer', surface: 'mcp:build_gold_join', requestId: 'req_01HX' });
  assert.equal(
    m,
    'data(sales): build gold order_customer — via mcp:build_gold_join\n\n' +
      'OS-Action: build gold\nOS-Object: order_customer\nOS-Surface: mcp:build_gold_join\nOS-Request-Id: req_01HX\n',
  );
  const withEmail = appendTrailers(m, { 'OS-Author-Email': 'synthesized' });
  assert.equal(withEmail.split('\n\n').length, 2, 'one trailer block, not two');
  assert.deepEqual(parseTrailers(withEmail), {
    'OS-Action': 'build gold',
    'OS-Object': 'order_customer',
    'OS-Surface': 'mcp:build_gold_join',
    'OS-Request-Id': 'req_01HX',
    'OS-Author-Email': 'synthesized',
  });
  // Trailers are what `log` returns.
});

test('trailers land in the commit and come back parsed from log', async () => {
  const msg = commitMessage({ area: 'data', domain: 'sales', action: 'add check', object: 'ds_1 (Orders)', surface: 'ui:data/datasets/ds_1/checks', requestId: 'req_x' });
  const r = await commitTree('sales', new Map([['dbt_project.yml', 'name: sales\nversion: "2"\n']]), { reposDir, author: alex, message: msg, trailers: { 'OS-Author-Email': 'synthesized' }, timestamp: 1_700_000_400 });
  const [head] = await log('sales', { reposDir, limit: 1 });
  assert.equal(head.sha, r.sha);
  assert.equal(head.trailers['OS-Surface'], 'ui:data/datasets/ds_1/checks');
  assert.equal(head.trailers['OS-Author-Email'], 'synthesized');
  assert.equal(head.subject, 'data(sales): add check ds_1 (Orders) — via ui:data/datasets/ds_1/checks');
});

test('authorFor: a user without e-mail gets <id>@os.local and is flagged synthesized', () => {
  assert.deepEqual(authorFor({ id: 'amir', name: 'Amir', email: 'amir@x.io' }), { author: { name: 'Amir', email: 'amir@x.io' }, synthesized: false });
  assert.deepEqual(authorFor({ id: 'amir' }), { author: { name: 'amir', email: 'amir@os.local' }, synthesized: true });
});

test('unsafe repository names and tree paths are refused', async () => {
  assert.throws(() => repoPath('../etc', { reposDir }), GitStoreError);
  assert.throws(() => repoPath('a/b', { reposDir }), GitStoreError);
  await assert.rejects(
    commitTree('sales', new Map([['../x', 'y']]), { reposDir, author: alex, message: 'bad' }),
    GitStoreError,
  );
  await assert.rejects(
    commitTree('sales', new Map([['/abs', 'y']]), { reposDir, author: alex, message: 'bad' }),
    GitStoreError,
  );
});

test('push refuses a non-http mirror and a missing token without leaking anything', async () => {
  const bad = await push('sales', { url: 'file:///tmp/x', tokenSecretRef: { name: 'm', key: 'token' } }, { reposDir });
  assert.deepEqual(bad, { ok: false, error: 'mirror url must be http(s)' });
  const noTok = await push('sales', { url: 'https://example.com/x.git', tokenSecretRef: { name: 'm', key: 'token' } }, { reposDir, resolveToken: () => null });
  assert.equal(noTok.ok, false);
  assert.match((noTok as { error: string }).error, /not set/);
  const unreachable = await push('sales', { url: 'http://127.0.0.1:9/x.git', tokenSecretRef: { name: 'm', key: 'token' } }, { reposDir, resolveToken: () => 'SECRET-TOKEN-VALUE' });
  assert.equal(unreachable.ok, false);
  assert.doesNotMatch((unreachable as { error: string }).error, /SECRET-TOKEN-VALUE/);
});
