/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The git store's READ half — path-scoped log, read-at-commit, unified diff
 * USER STORY: As a maintainer I want proof that `git log -- <path>` really only returns the
 *             commits that touched that path, that a file reads back byte-exactly at an old
 *             commit, and that the diff is a unified diff an engineer could `git apply`
 *             (checklist G3, G4).
 * ARCHITECTURE:
 *   - Real isomorphic-git against a mkdtemp bare repo; no network. The diff is tested as text,
 *     including the empty-string "no change" contract and the too-large refusal.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitTree,
  log,
  logPaths,
  readFilesAt,
  diffPaths,
  unifiedDiff,
  pathMatches,
  pathMatchesAny,
  repoSummaries,
  commitAt,
  scrubSecrets,
  isBinaryBlob,
  REDACTED,
  MAX_VERSION_FILES,
  MAX_VERSION_BYTES,
} from '@core/infra/git-store';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-git-read-'));
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const alex = { name: 'Alexander Borek', email: 'alex@datamasterclass.com' };
const shas: Record<string, string> = {};

before(async () => {
  const base = new Map([
    ['dbt_project.yml', 'name: sales\n'],
    ['agents/one/system.yaml', 'name: One\nversion: 1\n'],
  ]);
  shas.c1 = (await commitTree('sales', new Map(base), { reposDir, author: alex, message: 'c1', timestamp: 1_700_000_000 })).sha;
  // c2 touches ONLY the dbt side.
  const two = new Map(base).set('models/gold/orders.sql', 'select 1\n');
  shas.c2 = (await commitTree('sales', new Map(two), { reposDir, author: alex, message: 'c2', timestamp: 1_700_000_100 })).sha;
  // c3 touches ONLY the agents side.
  const three = new Map(two).set('agents/one/system.yaml', 'name: One\nversion: 2\nnodes: 2\n');
  shas.c3 = (await commitTree('sales', new Map(three), { reposDir, author: alex, message: 'c3', timestamp: 1_700_000_200 })).sha;
  // c4 adds a SECOND system, so the first one's path log must not grow.
  const four = new Map(three).set('agents/two/system.yaml', 'name: Two\n');
  shas.c4 = (await commitTree('sales', new Map(four), { reposDir, author: alex, message: 'c4', timestamp: 1_700_000_300 })).sha;
});

test('pathMatches: a trailing slash means "everything under", without it one exact file', () => {
  assert.equal(pathMatches('agents/one/system.yaml', 'agents/one/'), true);
  assert.equal(pathMatches('agents/oneself/system.yaml', 'agents/one/'), false);
  assert.equal(pathMatches('agents/one/system.yaml', 'agents/one'), true);
  assert.equal(pathMatches('models/gold/orders.sql', 'models/gold/orders.sql'), true);
  assert.equal(pathMatches('models/gold/orders.sqlx', 'models/gold/orders.sql'), false);
  assert.equal(pathMatches('anything', ''), false);
  assert.equal(pathMatchesAny('models/gold/orders.sql', ['agents/', 'models/']), true);
  assert.equal(pathMatchesAny('models/gold/orders.sql', []), false);
});

test('logPaths returns only the commits that changed the content under the selectors', async () => {
  const agents = await logPaths('sales', ['agents/one/'], { reposDir, limit: 10 });
  assert.deepEqual(agents.entries.map((e) => e.sha), [shas.c3, shas.c1], 'c2 (dbt only) and c4 (another system) are not this path');
  assert.equal(agents.truncated, false);
  const dbt = await logPaths('sales', ['models/'], { reposDir, limit: 10 });
  assert.deepEqual(dbt.entries.map((e) => e.sha), [shas.c2]);
  const both = await logPaths('sales', ['agents/one/', 'models/'], { reposDir, limit: 10 });
  assert.deepEqual(both.entries.map((e) => e.sha), [shas.c3, shas.c2, shas.c1]);
  const none = await logPaths('sales', ['dashboards/nothing/'], { reposDir, limit: 10 });
  assert.deepEqual(none.entries, []);
  assert.deepEqual((await logPaths('sales', [], { reposDir })).entries, []);
  assert.deepEqual((await logPaths('never-seen', ['agents/'], { reposDir })).entries, []);
});

test('logPaths is bounded and says when its window ran out', async () => {
  // `scan` is raised to at least `limit` (asking for 10 entries out of a 2-commit walk is a
  // contradiction), so a bounded walk is expressed as a small limit AND a small scan.
  const narrow = await logPaths('sales', ['agents/one/'], { reposDir, limit: 2, scan: 2 });
  assert.deepEqual(narrow.entries.map((e) => e.sha), [shas.c3]);
  assert.equal(narrow.truncated, true, 'the walk ended before 2 matches — never claim completeness');
  assert.equal(narrow.scanned, 2);
  const wide = await logPaths('sales', ['agents/one/'], { reposDir, limit: 2, scan: 10 });
  assert.deepEqual(wide.entries.map((e) => e.sha), [shas.c3, shas.c1]);
  assert.equal(wide.truncated, false);
});

test('readFilesAt reads the object files byte-exactly at an old commit', async () => {
  const old = await readFilesAt('sales', shas.c1, ['agents/one/'], { reposDir });
  assert.equal(old.sha, shas.c1);
  assert.deepEqual(old.files, [
    { path: 'agents/one/system.yaml', content: 'name: One\nversion: 1\n', bytes: 21, binary: false },
  ]);
  assert.equal(old.truncated, false);
  assert.equal(old.truncatedBy, null);
  assert.equal(old.bytes, 21);
  const now = await readFilesAt('sales', 'main', ['agents/one/'], { reposDir });
  assert.equal(now.files[0].content, 'name: One\nversion: 2\nnodes: 2\n');
  // A path that did not exist yet is an empty list, never an error.
  assert.deepEqual((await readFilesAt('sales', shas.c1, ['models/'], { reposDir })).files, []);
  // And the empty-value guard the scrub needed: `password:` must not swallow the next line.
  assert.equal(scrubSecrets('password:\nname: sales\n').redactions, 0);
  assert.ok(MAX_VERSION_FILES > 0);
});

test('unifiedDiff produces a real unified diff, and "" for no change', () => {
  assert.equal(unifiedDiff('same\n', 'same\n'), '');
  const patch = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { aLabel: 'f.yml', bLabel: 'f.yml' });
  assert.equal(
    patch,
    ['--- a/f.yml', '+++ b/f.yml', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n'),
  );
  const added = unifiedDiff('', 'new\n', { aLabel: 'n', bLabel: 'n' });
  assert.match(added, /@@ -0,0 \+1,1 @@\n\+new/);
  const removed = unifiedDiff('gone\n', '', { aLabel: 'g', bLabel: 'g' });
  assert.match(removed, /@@ -1,1 \+0,0 @@\n-gone/);
  // Context is bounded, so a one-line change in a long file is a small hunk, not the whole file.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const edited = long.replace('line 20', 'LINE 20');
  const hunk = unifiedDiff(long, edited, { aLabel: 'l', bLabel: 'l', context: 1 });
  assert.equal(hunk.split('\n').filter((l) => l.startsWith('@@')).length, 1);
  assert.match(hunk, /@@ -20,3 \+20,3 @@/);
  assert.equal(hunk.split('\n').filter((l) => l.startsWith('-')).length, 2, 'one removed line plus the --- header');
});

test('unifiedDiff refuses to guess at a file too large to diff, and says so', () => {
  const a = Array.from({ length: 900 }, (_, i) => `a${i}`).join('\n') + '\n';
  const b = Array.from({ length: 900 }, (_, i) => `b${i}`).join('\n') + '\n';
  const patch = unifiedDiff(a, b, { aLabel: 'big', bLabel: 'big' });
  assert.match(patch, /file too large to diff line-by-line \(900 x 900 lines\)/);
});

test('diffPaths diffs only the object, naming added, modified and removed files', async () => {
  const d = await diffPaths('sales', shas.c1, shas.c3, ['agents/one/', 'models/'], { reposDir });
  assert.deepEqual(
    d.files.map((f) => [f.path, f.status]),
    [
      ['agents/one/system.yaml', 'modified'],
      ['models/gold/orders.sql', 'added'],
    ],
  );
  assert.equal(d.patch, d.files.map((f) => f.patch).join(''));
  const reverse = await diffPaths('sales', shas.c3, shas.c1, ['models/'], { reposDir });
  assert.deepEqual(reverse.files.map((f) => f.status), ['removed']);
  const identical = await diffPaths('sales', shas.c3, shas.c4, ['agents/one/'], { reposDir });
  assert.deepEqual(identical.files, [], 'c4 added another system; THIS one did not change');
});

test('repoSummaries gives an operator the head, the commit count and the last author', async () => {
  const rows = await repoSummaries({ reposDir });
  assert.deepEqual(rows.map((r) => r.domain), ['sales']);
  assert.equal(rows[0].head, shas.c4);
  assert.equal(rows[0].commits, 4);
  assert.equal(rows[0].countTruncated, false);
  assert.equal(rows[0].lastAuthor, 'Alexander Borek');
  assert.equal(rows[0].lastSubject, 'c4');
  assert.ok(Date.parse(rows[0].lastAt!) > 0);
  assert.deepEqual(await repoSummaries({ reposDir: join(reposDir, 'nope') }), []);
});

// ---- the review fixes -------------------------------------------------------

test('M-2: a trailing-newline-only change produces a patch git apply would accept', () => {
  const patch = unifiedDiff('x\n', 'x', { aLabel: 'f', bLabel: 'f' });
  assert.equal(
    patch,
    ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-x', '+x', '\\ No newline at end of file', ''].join('\n'),
    'the marker line must be emitted, or the patch is header-only and is rejected',
  );
  // And the other direction: adding the newline back.
  assert.equal(
    unifiedDiff('x', 'x\n', { aLabel: 'f', bLabel: 'f' }),
    ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-x', '\\ No newline at end of file', '+x', ''].join('\n'),
  );
  // A file that merely LACKS the newline on both sides is still diffed normally.
  assert.match(unifiedDiff('a\nb', 'a\nB', { aLabel: 'f', bLabel: 'f' }), /-b\n\\ No newline at end of file\n\+B\n\\ No newline at end of file/);
});

test('M-3: a binary blob is detected, reported with its size, and never decoded', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  assert.equal(isBinaryBlob(png), true, 'a PNG header carries a NUL');
  assert.equal(isBinaryBlob(Buffer.from([0xff, 0xfe, 0x41])), true, 'invalid UTF-8 is binary too');
  assert.equal(isBinaryBlob(Buffer.from('name: ok\n', 'utf8')), false);
  // Through a real repo: a binary blob reads back as binary with EMPTY content.
  const content = png.toString('latin1');
  await commitTree('bin', new Map([['apps/x/logo.png', content], ['apps/x/README.md', 'hi\n']]), {
    reposDir,
    author: alex,
    message: 'c1',
    timestamp: 1_700_000_000,
  });
  const at = await readFilesAt('bin', 'main', ['apps/x/'], { reposDir });
  const blob = at.files.find((f) => f.path === 'apps/x/logo.png')!;
  assert.equal(blob.binary, true);
  assert.equal(blob.content, '', 'never a UTF-8 mangling of the bytes');
  assert.ok(blob.bytes > 0);
  assert.equal(at.files.find((f) => f.path === 'apps/x/README.md')!.binary, false);
  // And in a diff it is NAMED, not rendered.
  await commitTree('bin', new Map([['apps/x/logo.png', content + '\u0001'], ['apps/x/README.md', 'hi\n']]), {
    reposDir,
    author: alex,
    message: 'c2',
    timestamp: 1_700_000_100,
  });
  const entries = await log('bin', { reposDir, limit: 10 });
  const d = await diffPaths('bin', entries[1].sha, entries[0].sha, ['apps/x/'], { reposDir });
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.binary]), [['apps/x/logo.png', 'modified', true]]);
  assert.match(d.files[0].patch, /^--- a\/apps\/x\/logo\.png\n\+\+\+ b\/apps\/x\/logo\.png\nBinary files .* differ\n$/);
});

test('L-2: an added EMPTY file is still listed in the diff', async () => {
  await commitTree('empty', new Map([['dashboards/d/dashboard.yaml', 'title: d\n']]), { reposDir, author: alex, message: 'c1', timestamp: 1_700_000_000 });
  await commitTree('empty', new Map([['dashboards/d/dashboard.yaml', 'title: d\n'], ['dashboards/d/NOTES.md', '']]), {
    reposDir,
    author: alex,
    message: 'c2',
    timestamp: 1_700_000_100,
  });
  const entries = await log('empty', { reposDir, limit: 10 });
  const d = await diffPaths('empty', entries[1].sha, entries[0].sha, ['dashboards/d/'], { reposDir });
  assert.deepEqual(d.files.map((f) => [f.path, f.status]), [['dashboards/d/NOTES.md', 'added']]);
  assert.match(d.files[0].patch, /\+\+\+ b\/dashboards\/d\/NOTES\.md/);
  assert.match(d.files[0].patch, /added \(empty file\)/, 'the reason is stated, not implied by an empty patch');
});

test('M-1: the secret scrub redacts secret shapes and leaves shas, oids and uuids alone', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQ\n-----END RSA PRIVATE KEY-----';
  const text = [
    'password: hunter2',
    "api_key: 'abcdef123456'",
    'token=ghp_0123456789abcdefghijklmnop',
    'url: postgres://os:s3cr3t@db:5432/os',
    'OPENAI: sk-abcdefghijklmnopqrstuvwxyz01',
    'aws: AKIAIOSFODNN7EXAMPLE',
    pem,
    'sha: 9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
    'id: 1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    'password:',
    'secret: null',
  ].join('\n');
  const out = scrubSecrets(text);
  assert.ok(out.redactions >= 7, `expected the secret shapes to be caught, got ${out.redactions}`);
  for (const leak of ['hunter2', 'abcdef123456', 'ghp_0123456789abcdefghijklmnop', 's3cr3t', 'sk-abcdefghijklmnopqrstuvwxyz01', 'AKIAIOSFODNN7EXAMPLE', 'MIIEvQ']) {
    assert.ok(!out.text.includes(leak), `${leak} survived the scrub`);
  }
  assert.match(out.text, /password: \*\*\*REDACTED-BY-OS\*\*\*/, 'the KEY stays so the file still reads as itself');
  assert.match(out.text, /url: postgres:\/\/os:\*\*\*REDACTED-BY-OS\*\*\*@db:5432\/os/);
  assert.ok(out.text.includes('9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456'), 'a commit sha is NOT a secret');
  assert.ok(out.text.includes('1b4e28ba-2fa1-11d2-883f-0016d3cca427'), 'a uuid is NOT a secret');
  assert.ok(out.text.includes('password:\n'), 'an EMPTY value is left alone — there is nothing to hide');
  assert.ok(out.text.includes('secret: null'), 'an explicit null is left alone');
  assert.equal(scrubSecrets('name: sales\n').redactions, 0);
  assert.equal(scrubSecrets('name: sales\n').text, 'name: sales\n');
  assert.ok(REDACTED.length > 0);
});

test('M-1: a change that is ENTIRELY inside redacted content is reported, never shown as no change', async () => {
  await commitTree('secrets', new Map([['models/x.sql', 'password: one\n']]), { reposDir, author: alex, message: 'c1', timestamp: 1_700_000_000 });
  await commitTree('secrets', new Map([['models/x.sql', 'password: two\n']]), { reposDir, author: alex, message: 'c2', timestamp: 1_700_000_100 });
  const entries = await log('secrets', { reposDir, limit: 10 });
  const redacted = await diffPaths('secrets', entries[1].sha, entries[0].sha, ['models/'], { reposDir, redact: true });
  assert.equal(redacted.files.length, 1, 'the file changed, so it must appear');
  assert.equal(redacted.redacted, true);
  assert.match(redacted.files[0].patch, /entirely inside redacted content/);
  assert.ok(!redacted.patch.includes('one') && !redacted.patch.includes('two'), 'neither secret value leaks into the patch');
  // Without `redact` the differ is unchanged (it is the primitive the restore path uses).
  const raw = await diffPaths('secrets', entries[1].sha, entries[0].sha, ['models/'], { reposDir });
  assert.match(raw.files[0].patch, /-password: one/);
  assert.equal(raw.redacted, false);
});

test('M-4: a version read is bounded in BYTES as well as in files, and says which', async () => {
  assert.ok(MAX_VERSION_BYTES > 0 && MAX_VERSION_FILES > 0);
  const big = 'x'.repeat(Math.floor(MAX_VERSION_BYTES / 2) + 10);
  await commitTree('bytes', new Map([['apps/a/one.txt', big], ['apps/a/two.txt', big], ['apps/a/three.txt', big]]), {
    reposDir,
    author: alex,
    message: 'c1',
    timestamp: 1_700_000_000,
  });
  const at = await readFilesAt('bytes', 'main', ['apps/a/'], { reposDir });
  assert.equal(at.truncated, true);
  assert.equal(at.truncatedBy, 'bytes');
  assert.ok(at.files.length < 3, 'the read stops at the byte budget');
  assert.ok(at.bytes <= MAX_VERSION_BYTES);
});

test('M-5: commitAt reads ONE commit by sha without walking the log', async () => {
  const entries = await log('sales', { reposDir, limit: 10 });
  const one = await commitAt('sales', entries[2].sha, { reposDir });
  assert.equal(one!.sha, entries[2].sha);
  assert.equal(one!.subject, entries[2].subject);
  assert.deepEqual(one!.trailers, entries[2].trailers);
  assert.equal(await commitAt('sales', 'HEAD~2', { reposDir }), null, 'a ref expression is not addressable, and answers null');
  assert.equal(await commitAt('never-seen', 'main', { reposDir }), null);
});

test('L-4: logPaths uses an already-read window instead of walking again', async () => {
  const window = await log('sales', { reposDir, limit: 10 });
  const withWindow = await logPaths('sales', ['agents/one/'], { reposDir, limit: 10, window });
  const without = await logPaths('sales', ['agents/one/'], { reposDir, limit: 10 });
  assert.deepEqual(withWindow.entries.map((e) => e.sha), without.entries.map((e) => e.sha));
  assert.equal(withWindow.scanned, window.length);
});
