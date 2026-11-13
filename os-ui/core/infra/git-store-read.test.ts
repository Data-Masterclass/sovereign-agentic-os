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
  logPaths,
  readFilesAt,
  diffPaths,
  unifiedDiff,
  pathMatches,
  pathMatchesAny,
  repoSummaries,
  MAX_VERSION_FILES,
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
  assert.deepEqual(old.files, [{ path: 'agents/one/system.yaml', content: 'name: One\nversion: 1\n' }]);
  assert.equal(old.truncated, false);
  const now = await readFilesAt('sales', 'main', ['agents/one/'], { reposDir });
  assert.equal(now.files[0].content, 'name: One\nversion: 2\nnodes: 2\n');
  // A path that did not exist yet is an empty list, never an error.
  assert.deepEqual((await readFilesAt('sales', shas.c1, ['models/'], { reposDir })).files, []);
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
