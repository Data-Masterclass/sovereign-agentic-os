/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The additive tag/release API of the git store (night-2 S4, decision D17)
 * USER STORY: As an IT reviewer I want a release to be an IMMUTABLE annotated tag on the reviewed
 *             commit, listable per app as that app's release history, and I want a per-path log so
 *             "what changed in apps/<slug>/" is answerable from git rather than from a registry.
 * ARCHITECTURE:
 *   - Real isomorphic-git against a mkdtemp bare repo (the existing git-store.test.ts pattern);
 *     no network, no cluster.
 *   - Asserts the four new exports AND that the pre-existing exports still behave, because the
 *     whole contract of this block is "additive, changes no existing signature".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitTree,
  commitSubtree,
  log,
  annotatedTag,
  listTags,
  resolveTag,
  logPath,
  readSubtree,
  MAX_SUBTREE_FILES,
  assertTagName,
  tagRef,
  GitStoreError,
} from '@core/infra/git-store';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-tags-'));
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const alex = { name: 'Alexander Borek', email: 'alex@datamasterclass.com' };
const opts = () => ({ reposDir, author: alex, message: 'software(eng): test — via unit' });

test('tagRef / assertTagName: only safe, git-legal names reach the ref store', () => {
  assert.equal(tagRef('app/invoices/v1.0.0'), 'refs/tags/app/invoices/v1.0.0');
  assert.equal(assertTagName('app/invoices/v1.0.0'), 'app/invoices/v1.0.0');
  for (const bad of ['', '  ', '/leading', 'trailing/', 'a//b', '../escape', 'app/v1@{0}', 'x.lock', 'with space', 'a'.repeat(201)]) {
    assert.throws(() => assertTagName(bad), GitStoreError, `rejects '${bad}'`);
  }
});

test('annotatedTag: tags the reviewed commit, carries the message + tagger, and is IMMUTABLE', async () => {
  await commitSubtree('eng', 'apps/invoices', new Map([['apps/invoices/src/App.tsx', 'v1\n']]), opts());
  const head = (await log('eng', { reposDir, limit: 1 }))[0].sha;

  const t = await annotatedTag('eng', 'app/invoices/v1.0.0', {
    reposDir,
    tagger: alex,
    message: 'release app/invoices v1.0.0',
    trailers: { 'OS-Object': 'app:invoices', 'OS-Surface': 'mcp:release_software' },
    timestamp: 1_000,
  });
  assert.equal(t.name, 'app/invoices/v1.0.0');
  assert.equal(t.commit, head, 'the tag points at the reviewed commit');
  assert.match(t.oid, /^[0-9a-f]{40}$/);
  assert.match(t.message, /OS-Object: app:invoices/, 'the trailers are in the tag message');
  assert.equal(t.tagger.email, alex.email);

  await assert.rejects(
    () => annotatedTag('eng', 'app/invoices/v1.0.0', { reposDir, tagger: alex, message: 'again' }),
    (e: unknown) => e instanceof GitStoreError && (e as GitStoreError).status === 409,
    're-releasing the same version is a 409, never a moved tag',
  );
});

test('resolveTag: reads a tag back; an unknown tag and an unknown repo are null, never a throw', async () => {
  const t = await resolveTag('eng', 'app/invoices/v1.0.0', { reposDir });
  assert.ok(t);
  assert.equal(t!.commit, (await log('eng', { reposDir, limit: 1 }))[0].sha);
  assert.equal(await resolveTag('eng', 'app/invoices/v9.9.9', { reposDir }), null);
  assert.equal(await resolveTag('no-such-domain', 'app/x/v1.0.0', { reposDir }), null);
});

test('listTags(prefix): one app’s release history, newest first, other apps excluded', async () => {
  await commitSubtree('eng', 'apps/invoices', new Map([['apps/invoices/src/App.tsx', 'v2\n']]), opts());
  await annotatedTag('eng', 'app/invoices/v1.1.0', { reposDir, tagger: alex, message: 'v1.1.0', timestamp: 2_000 });
  await annotatedTag('eng', 'app/invoices/v1.2.0', { reposDir, tagger: alex, message: 'v1.2.0', timestamp: 3_000 });
  await commitSubtree('eng', 'apps/other', new Map([['apps/other/src/App.tsx', 'o\n']]), opts());
  await annotatedTag('eng', 'app/other/v1.0.0', { reposDir, tagger: alex, message: 'other v1', timestamp: 2_500 });

  const releases = await listTags('eng', 'app/invoices/v', { reposDir });
  assert.deepEqual(
    releases.map((r) => r.name),
    ['app/invoices/v1.2.0', 'app/invoices/v1.1.0', 'app/invoices/v1.0.0'],
    'newest first, and only this app',
  );
  assert.equal((await listTags('eng', 'app/other/v', { reposDir })).length, 1);
  assert.equal((await listTags('eng', '', { reposDir })).length, 4, 'no prefix ⇒ every tag');
  assert.equal((await listTags('eng', 'app/invoices/v', { reposDir, limit: 2 })).length, 2, 'limit honoured');
  assert.deepEqual(await listTags('no-such-domain', '', { reposDir }), [], 'a missing repo is an empty history');
});

test('logPath: the commits that CHANGED a path — a file and a directory prefix', async () => {
  const before = await logPath('eng', 'apps/other/src/App.tsx', { reposDir });
  assert.equal(before.entries.length, 1, 'one commit touched this file so far');

  await commitSubtree('eng', 'apps/other', new Map([['apps/other/src/App.tsx', 'o2\n']]), { ...opts(), message: 'software(eng): edit other — via unit' });
  const file = await logPath('eng', 'apps/other/src/App.tsx', { reposDir });
  assert.equal(file.entries.length, 2, 'the edit is in the file history');
  assert.match(file.entries[0].subject, /edit other/, 'newest first');

  const dir = await logPath('eng', 'apps/other', { reposDir });
  assert.equal(dir.entries.length, 2, 'a directory prefix works the same way');
  const trailingSlash = await logPath('eng', 'apps/other/', { reposDir });
  assert.equal(trailingSlash.entries.length, 2, 'a trailing slash is tolerated');

  const invoices = await logPath('eng', 'apps/invoices', { reposDir });
  assert.ok(
    invoices.entries.every((e) => !/edit other/.test(e.subject)),
    'another app’s commits are NOT in this app’s history',
  );
  assert.equal(file.truncated, false, 'honest truncation flag');
  assert.deepEqual((await logPath('no-such-domain', 'apps/x', { reposDir })).entries, []);
  await assert.rejects(() => logPath('eng', '../escape', { reposDir }), GitStoreError, 'an unsafe path is refused');
});

test('additive: commitTree and log still behave exactly as before the tag block', async () => {
  const r1 = await commitTree('plain', new Map([['README.md', 'hi\n']]), opts());
  assert.equal(r1.changed, true);
  const r2 = await commitTree('plain', new Map([['README.md', 'hi\n']]), opts());
  assert.equal(r2.changed, false, 'unchanged tree ⇒ no commit');
  assert.equal(r2.sha, r1.sha);
  assert.deepEqual(await listTags('plain', '', { reposDir }), [], 'a repo with no tags has no releases');
});


test('readSubtree: a BOUNDED read of one subtree — prefix stripped, the prefix’s own sha (M-5)', async () => {
  await commitSubtree('eng', 'apps/reader', new Map([
    ['apps/reader/app.yaml', 'name: Reader\n'],
    ['apps/reader/src/App.tsx', 'export default () => null;\n'],
  ]), { ...opts(), message: 'software(eng): push reader — via mcp:push_app_files' });
  // A LATER commit elsewhere in the repo must NOT become this subtree's sha.
  await commitSubtree('eng', 'apps/other2', new Map([['apps/other2/app.yaml', 'name: Other2\n']]), opts());

  const read = await readSubtree('eng', 'apps/reader', { reposDir });
  assert.ok(read);
  assert.deepEqual(read!.files.map((f) => f.path).sort(), ['app.yaml', 'src/App.tsx'], 'the prefix is stripped');
  assert.equal(read!.files.find((f) => f.path === 'app.yaml')?.content, 'name: Reader\n');
  assert.equal(read!.truncated, false, 'the honest completeness flag');
  const mine = await logPath('eng', 'apps/reader', { reposDir, limit: 1 });
  assert.equal(read!.sha, mine.entries[0].sha, 'the sha is the commit that last changed THIS prefix');
  assert.ok(read!.sha !== (await log('eng', { reposDir, limit: 1 }))[0].sha, 'and NOT the repository head');

  // An absent prefix or repository is null — never an empty tree that reads as "no files".
  assert.equal(await readSubtree('eng', 'apps/not-there', { reposDir }), null);
  assert.equal(await readSubtree('no-such-domain', 'apps/x', { reposDir }), null);
  assert.ok(MAX_SUBTREE_FILES > 0 && MAX_SUBTREE_FILES <= 1000, 'the file cap is a real bound');
});
