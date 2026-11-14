/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Generic versioning over a REAL bare repo — history, version, diff, restore refusals
 * USER STORY: As a maintainer I want proof that every object kind resolves its history (including
 *             an object whose ONLY commit is a platform boot reconcile — the night-1 `git.head`
 *             null), that an object I may not see is indistinguishable from one that does not
 *             exist, and that a restore can only ever go back through the object's own writer
 *             (checklist G3, G4, G5, G9).
 * ARCHITECTURE:
 *   - Real isomorphic-git against a mkdtemp bare repo; no network, no tab imports. The kind
 *     resolvers are registered the way a tab registers them at boot, so the gate under test is
 *     the real one.
 *   - The boot-reconcile case is built literally: a commit whose `OS-Object` trailer names the
 *     DOMAIN (what `tabs/agents/lib/git/reconcile.ts` writes), so a trailer-only lookup finds
 *     nothing and only the path fallback can answer.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { commitTree, commitMessage, appendTrailers, log, REDACTED } from '@core/infra/git-store';
import {
  GIT_OBJECT_KINDS,
  GIT_OBJECT_LAYOUT,
  GitObjectError,
  objectGitInfo,
  objectReleases,
  getVersion,
  diffVersions,
  restoreVersion,
  registerGitObject,
  registerGitObjectRestorer,
  resolveTrailerForUser,
  repositoriesOverview,
  repositoryCommitLog,
  trailerObjectId,
  registeredGitObjectKinds,
  restorableGitObjectKinds,
  notFoundMessage,
  isGitObjectKind,
  __clearGitObjectRegistry,
  type GitObjectLocation,
} from '@core/infra/git-objects';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-git-objects-'));
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const amir: CurrentUser = { id: 'amir', name: 'Amir Example', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'creator' };
const author = { name: 'Amir Example', email: 'amir@example.com' };
const platform = { name: 'Sovereign OS', email: 'os@sovereign.local' };

/** The three commits every read test works against, built once per suite run. */
const shas: Record<string, string> = {};

async function seed(domain: string): Promise<void> {
  // 1. The BOOT RECONCILE: platform attribution, `OS-Object: <domain>` — never the object's id.
  const first = await commitTree(
    domain,
    new Map([
      ['dbt_project.yml', 'name: sales\n'],
      ['agents/support/system.yaml', 'name: Support\nversion: 1\n'],
      ['agents/other/system.yaml', 'name: Other\nversion: 1\n'],
    ]),
    {
      reposDir,
      author: platform,
      message: commitMessage({
        area: 'agents',
        domain,
        action: 'reconcile agent systems',
        object: domain,
        objectId: domain,
        surface: 'boot:reconcile',
        requestId: 'req-boot',
      }),
      trailers: { 'OS-Reason': 'boot-reconcile' },
      timestamp: 1_700_000_000,
    },
  );
  shas.boot = first.sha;
  // 2. A dataset write, attributed to the user, naming the dataset in the trailer.
  const second = await commitTree(
    domain,
    new Map([
      ['dbt_project.yml', 'name: sales\n'],
      ['agents/support/system.yaml', 'name: Support\nversion: 1\n'],
      ['agents/other/system.yaml', 'name: Other\nversion: 1\n'],
      ['models/gold/orders.sql', 'select 1 as id\n'],
    ]),
    {
      reposDir,
      author,
      message: commitMessage({ area: 'data', domain, action: 'build gold orders', object: 'orders', objectId: 'ds_1 (Orders)', surface: 'ui:data', requestId: 'req-2' }),
      timestamp: 1_700_000_100,
    },
  );
  shas.dataset = second.sha;
  // 3. An agent-system write, attributed to the user, naming the system in the trailer.
  const third = await commitTree(
    domain,
    new Map([
      ['dbt_project.yml', 'name: sales\n'],
      ['agents/support/system.yaml', 'name: Support\nversion: 2\nnodes: 3\n'],
      ['agents/other/system.yaml', 'name: Other\nversion: 1\n'],
      ['models/gold/orders.sql', 'select 1 as id\n'],
    ]),
    {
      reposDir,
      author,
      message: commitMessage({ area: 'agents', domain, action: 'set schedule cron', object: 'support', objectId: 'sys_1 (Support)', surface: 'mcp:commit_agent_files', requestId: 'req-3' }),
      timestamp: 1_700_000_200,
    },
  );
  shas.system = third.sha;
}

/** Register the two kinds this suite reads, exactly as a tab would at boot. */
function registerKinds(): void {
  __clearGitObjectRegistry();
  registerGitObject('agent-system', (_user, id) => {
    const map: Record<string, GitObjectLocation> = {
      sys_1: { domain: 'sales', paths: ['agents/support/'], trailerId: 'sys_1', name: 'Support' },
      // The F3-1 case: a system whose ONLY commit is the platform boot reconcile.
      sys_2: { domain: 'sales', paths: ['agents/other/'], trailerId: 'sys_2', name: 'Other' },
      // A system that exists and is visible but has no repository yet.
      sys_3: { domain: '', paths: [], trailerId: 'sys_3', name: 'Unassigned' },
    };
    return map[id] ?? null; // null = missing OR invisible; the caller cannot tell them apart
  });
  registerGitObject('dataset', (_user, id) =>
    id === 'ds_1' ? { domain: 'sales', paths: ['models/gold/orders.sql'], trailerId: 'ds_1', name: 'Orders' } : null,
  );
}

before(async () => {
  await seed('sales');
});
beforeEach(() => registerKinds());

test('the kind table covers every kind, and each kind says whether its writer commits', () => {
  for (const kind of GIT_OBJECT_KINDS) {
    const row = GIT_OBJECT_LAYOUT[kind];
    assert.equal(row.kind, kind, `${kind}: the table key and the row disagree`);
    assert.ok(row.paths.length > 0, `${kind}: no repo path declared`);
    assert.ok(row.label.length > 0, `${kind}: no tool-native label`);
    if (row.writer.state === 'backlog') assert.ok(row.writer.reason.length > 20, `${kind}: backlog without a reason`);
    else assert.ok(row.writer.via.includes('.ts'), `${kind}: ${row.writer.state} without naming its writer module`);
    if (row.writer.state === 'landing') assert.ok(row.writer.stream.length > 0, `${kind}: landing without naming the stream`);
  }
  assert.equal(isGitObjectKind('agent-system'), true);
  assert.equal(isGitObjectKind('nonsense'), false);
});

test('objectGitInfo resolves by the OS-Object trailer and merges the path log, newest first', async () => {
  const info = await objectGitInfo(amir, 'agent-system', 'sys_1', { reposDir });
  assert.equal(info.domain, 'sales');
  assert.equal(info.name, 'Support');
  assert.deepEqual(info.paths, ['agents/support/']);
  assert.equal(info.head!.sha, shas.system);
  assert.equal(info.head!.action, 'set schedule cron');
  assert.equal(info.head!.surface, 'mcp:commit_agent_files');
  assert.equal(info.head!.author, 'Amir Example');
  // The boot reconcile CREATED this system's file, so the path fallback adds it to the history —
  // the trailer alone would have shown one commit and implied the system appeared from nowhere.
  assert.deepEqual(info.history.map((h) => h.sha), [shas.system, shas.boot]);
  assert.equal(info.via, 'trailer+path');
  assert.equal(info.truncated, false);
});

test('git.head is NOT null for an object whose only commit is a platform boot reconcile (F3-1)', async () => {
  const info = await objectGitInfo(amir, 'agent-system', 'sys_2', { reposDir });
  assert.equal(info.via, 'path', 'no commit trailer names this system — only the path fallback can answer');
  assert.ok(info.head, 'a system with files in the tree must never report a null head');
  assert.equal(info.head!.sha, shas.boot);
  assert.equal(info.head!.reason, 'boot-reconcile', 'the commit says WHY it exists, so the badge can label it');
  assert.equal(info.head!.author, 'Sovereign OS');
  assert.deepEqual(info.history.map((h) => h.sha), [shas.boot]);
});

test('a one-file object (a dbt model) resolves its own history and ignores other objects commits', async () => {
  const info = await objectGitInfo(amir, 'dataset', 'ds_1', { reposDir });
  assert.equal(info.head!.sha, shas.dataset);
  assert.deepEqual(info.history.map((h) => h.sha), [shas.dataset]);
  assert.equal(info.via, 'trailer+path');
});

test('an object that exists but has no repository yet is an honest empty history', async () => {
  const info = await objectGitInfo(amir, 'agent-system', 'sys_3', { reposDir });
  assert.equal(info.head, null);
  assert.deepEqual(info.history, []);
  assert.equal(info.via, 'none');
  assert.equal(info.truncated, false);
});

test('an object the caller cannot see is BYTE-IDENTICAL to one that does not exist (G5)', async () => {
  const invisible = await objectGitInfo(amir, 'agent-system', 'sys_hidden', { reposDir }).catch((e) => e);
  const missing = await objectGitInfo(amir, 'agent-system', 'sys_hidden', { reposDir }).catch((e) => e);
  const other = await objectGitInfo(amir, 'agent-system', 'sys_nope', { reposDir }).catch((e) => e);
  for (const e of [invisible, missing, other]) {
    assert.ok(e instanceof GitObjectError);
    assert.equal((e as GitObjectError).status, 404);
    assert.equal((e as GitObjectError).code, 'not_found');
  }
  assert.equal(invisible.message, missing.message);
  assert.equal(invisible.message, notFoundMessage('agent-system', 'sys_hidden'));
  assert.equal(other.message, notFoundMessage('agent-system', 'sys_nope'));
  // A resolver that THROWS (the shape a tab's governed read has for a forbidden object) must
  // produce the same answer, never a 403 that confirms the object exists.
  registerGitObject('dataset', () => {
    const e = new Error('Not permitted to view this dataset') as Error & { status?: number };
    e.status = 403;
    throw e;
  });
  const thrown = await objectGitInfo(amir, 'dataset', 'ds_1', { reposDir }).catch((e) => e);
  assert.equal(thrown.message, notFoundMessage('dataset', 'ds_1'));
  assert.equal(thrown.status, 404);
});

test('all three reads refuse a kind whose tab has not registered a resolver, and say why', async () => {
  for (const call of [
    () => objectGitInfo(amir, 'dashboard', 'dash_1', { reposDir }),
    () => getVersion(amir, 'dashboard', 'dash_1', shas.boot, { reposDir }),
    () => diffVersions(amir, 'dashboard', 'dash_1', shas.boot, shas.system, { reposDir }),
  ]) {
    const e = await call().catch((x) => x);
    assert.ok(e instanceof GitObjectError);
    assert.equal(e.status, 501);
    assert.equal(e.code, 'kind_not_wired');
    assert.match(e.message, /registerGitObject/);
  }
  assert.deepEqual(registeredGitObjectKinds(), ['agent-system', 'dataset']);
});

test('getVersion returns the object files AT that commit, and says so when it had none', async () => {
  const now = await getVersion(amir, 'agent-system', 'sys_1', shas.system, { reposDir });
  assert.equal(now.present, true);
  assert.equal(now.truncated, false);
  assert.deepEqual(now.files, [
    { path: 'agents/support/system.yaml', content: 'name: Support\nversion: 2\nnodes: 3\n', bytes: 34, binary: false },
  ]);
  assert.equal(now.redacted, false, 'nothing secret-shaped in this version');
  assert.deepEqual(now.redactedPaths, []);
  assert.equal(now.truncatedBy, null);
  assert.equal(now.bytes, 34);
  assert.equal(now.commit!.action, 'set schedule cron');
  const before = await getVersion(amir, 'agent-system', 'sys_1', shas.boot, { reposDir });
  assert.deepEqual(before.files, [
    { path: 'agents/support/system.yaml', content: 'name: Support\nversion: 1\n', bytes: 25, binary: false },
  ]);
  assert.equal(before.commit!.reason, 'boot-reconcile');
  // An abbreviated sha resolves; a non-sha is a typed bad_request, not a 404 that leaks nothing.
  const short = await getVersion(amir, 'agent-system', 'sys_1', shas.system.slice(0, 8), { reposDir });
  assert.equal(short.sha, shas.system);
  const bad = await getVersion(amir, 'agent-system', 'sys_1', 'HEAD~1', { reposDir }).catch((e) => e);
  assert.equal(bad.code, 'bad_request');
  assert.equal(bad.status, 400);
});

test('getVersion is gated BEFORE the sha is even parsed', async () => {
  const e = await getVersion(amir, 'agent-system', 'sys_hidden', 'not-a-sha', { reposDir }).catch((x) => x);
  assert.equal(e.message, notFoundMessage('agent-system', 'sys_hidden'));
});

test('diffVersions returns a unified diff of the object between two commits', async () => {
  const diff = await diffVersions(amir, 'agent-system', 'sys_1', shas.boot, shas.system, { reposDir });
  assert.equal(diff.identical, false);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, 'agents/support/system.yaml');
  assert.equal(diff.files[0].status, 'modified');
  assert.match(diff.files[0].patch, /^--- a\/agents\/support\/system\.yaml\n\+\+\+ b\/agents\/support\/system\.yaml\n/);
  assert.match(diff.files[0].patch, /-version: 1/);
  assert.match(diff.files[0].patch, /\+version: 2/);
  assert.match(diff.files[0].patch, /\+nodes: 3/);
  assert.equal(diff.patch, diff.files[0].patch);
  // A file that only APPEARS between the two commits is reported as added, not as modified.
  const added = await diffVersions(amir, 'dataset', 'ds_1', shas.boot, shas.dataset, { reposDir });
  assert.equal(added.files[0].status, 'added');
  // The same commit twice is identical — a real answer, not an empty-looking failure.
  const same = await diffVersions(amir, 'agent-system', 'sys_1', shas.system, shas.system, { reposDir });
  assert.equal(same.identical, true);
  assert.deepEqual(same.files, []);
});

test('restoreVersion REFUSES a kind whose tab registered no writer — it never rewrites history', async () => {
  const e = await restoreVersion(amir, 'agent-system', 'sys_1', shas.boot, { reposDir }).catch((x) => x);
  assert.ok(e instanceof GitObjectError);
  assert.equal(e.status, 501);
  assert.equal(e.code, 'restore_unsupported');
  assert.match(e.message, /normal write path/);
  assert.deepEqual(restorableGitObjectKinds(), []);
  // The log is untouched: a refusal commits nothing.
  assert.equal((await log('sales', { reposDir, limit: 50 })).length, 3);
});

test('restoreVersion is gated and refuses a version with no files, before any writer is called', async () => {
  let called = 0;
  registerGitObjectRestorer('dataset', async () => {
    called++;
    return { sha: 'x', changed: true };
  });
  const hidden = await restoreVersion(amir, 'dataset', 'ds_nope', shas.dataset, { reposDir }).catch((x) => x);
  assert.equal(hidden.message, notFoundMessage('dataset', 'ds_nope'));
  // `ds_1` did not exist at the boot commit, so there is nothing to put back.
  const empty = await restoreVersion(amir, 'dataset', 'ds_1', shas.boot, { reposDir }).catch((x) => x);
  assert.equal(empty.code, 'nothing_to_restore');
  assert.equal(called, 0, 'the writer must not be reached by a refused restore');
});

test('restoreVersion re-applies a version THROUGH the writer and produces ONE NEW commit', async () => {
  const seen: { id: string; sha: string; files: { path: string; content: string }[] }[] = [];
  registerGitObjectRestorer('agent-system', async (user, id, version) => {
    seen.push({ id, sha: version.sha, files: version.files });
    // A real restorer calls the tab's normal writer; here that writer is `commitTree` itself, so
    // the test proves the result is a NEW commit on top, never a rewrite.
    const files = new Map([
      ['dbt_project.yml', 'name: sales\n'],
      ['agents/other/system.yaml', 'name: Other\nversion: 1\n'],
      ['models/gold/orders.sql', 'select 1 as id\n'],
      ...version.files.map((f) => [f.path, f.content] as [string, string]),
    ]);
    const result = await commitTree('sales', files, {
      reposDir,
      author: { name: user.name, email: 'amir@example.com' },
      message: appendTrailers(`agents(sales): restore ${id} to ${version.sha.slice(0, 7)} — via ui:agents`, {
        'OS-Action': 'restore version',
        'OS-Object': `${id} (Support)`,
        'OS-Surface': 'ui:agents',
        'OS-Request-Id': 'req-restore',
      }),
      timestamp: 1_700_000_300,
    });
    return { sha: result.sha, changed: result.changed };
  });
  const before = await log('sales', { reposDir, limit: 50 });
  const result = await restoreVersion(amir, 'agent-system', 'sys_1', shas.boot, { reposDir });
  assert.equal(result.restoredFrom, shas.boot);
  assert.equal(result.changed, true);
  assert.equal(result.files, 1);
  assert.deepEqual(seen.map((s) => s.id), ['sys_1']);
  assert.deepEqual(seen[0].files, [
    { path: 'agents/support/system.yaml', content: 'name: Support\nversion: 1\n', bytes: 25, binary: false },
  ]);
  const after = await log('sales', { reposDir, limit: 50 });
  assert.equal(after.length, before.length + 1, 'exactly ONE new commit');
  assert.equal(after[0].sha, result.sha);
  assert.deepEqual(after.slice(1).map((e) => e.sha), before.map((e) => e.sha), 'the existing history is byte-identical — no rewrite');
  // And the object now reads back at the restored content, through the generic reader.
  const version = await getVersion(amir, 'agent-system', 'sys_1', result.sha, { reposDir });
  assert.equal(version.files[0].content, 'name: Support\nversion: 1\n');
  assert.deepEqual(restorableGitObjectKinds(), ['agent-system']);
});

test('objectReleases is HIDDEN-with-a-reason rather than empty when there are no tags to read', async () => {
  // A kind that does not publish release tags (every kind but software today).
  const none = await objectReleases(amir, 'agent-system', 'sys_1', { reposDir });
  assert.equal(none.available, false);
  assert.match(none.reason, /does not publish release tags/);
  assert.deepEqual(none.releases, []);
  // An object with no repository at all.
  const noRepo = await objectReleases(amir, 'agent-system', 'sys_3', { reposDir });
  assert.equal(noRepo.available, false);
  assert.match(noRepo.reason, /no domain repository/);
  // A kind that DOES declare a tag prefix, while the annotated-tag API is not in the build yet:
  // unavailable WITH the reason — never an empty list that reads as "never released".
  registerGitObject('software', () => ({ domain: 'sales', paths: ['apps/orders/'], tagPrefix: 'app/orders/' }));
  const pending = await objectReleases(amir, 'software', 'app_1', { reposDir });
  assert.equal(pending.available, false);
  assert.match(pending.reason, /annotated-tag API is not in this build yet/);
  // And it is gated like every other read.
  const hidden = await objectReleases(amir, 'dataset', 'ds_nope', { reposDir }).catch((e) => e);
  assert.equal((hidden as Error).message, notFoundMessage('dataset', 'ds_nope'));
});


// ---- the review fixes -------------------------------------------------------

test('X: a whole-subtree commit is found through its OS-Objects list, whole-token only', async () => {
  // Stream X's R1 shape: ONE commit carrying several objects, listed space-separated.
  const many = await commitTree(
    'batch',
    new Map([
      ['agents/a/system.yaml', 'name: A\n'],
      ['agents/b/system.yaml', 'name: B\n'],
    ]),
    {
      reposDir,
      author: platform,
      message: appendTrailers('agents(batch): reconcile agent systems batch — via boot:reconcile', {
        'OS-Action': 'reconcile agent systems',
        'OS-Object': 'batch',
        'OS-Objects': 'sys_abcd sys_b',
        'OS-Surface': 'boot:reconcile',
        'OS-Reason': 'boot-reconcile',
      }),
      timestamp: 1_700_000_000,
    },
  );
  __clearGitObjectRegistry();
  registerGitObject('agent-system', (_user, id) =>
    ['sys_abc', 'sys_abcd', 'sys_b'].includes(id) ? { domain: 'batch', paths: [`agents/none-${id}/`], trailerId: id } : null,
  );
  assert.equal(trailerObjectId('sys_abcd (A)'), 'sys_abcd');
  assert.equal(trailerObjectId(''), '');
  const listed = await objectGitInfo(amir, 'agent-system', 'sys_abcd', { reposDir });
  assert.equal(listed.head!.sha, many.sha, 'the id is in OS-Objects, so the commit is its history');
  assert.equal(listed.via, 'trailer');
  // WHOLE TOKEN: `sys_abc` is a prefix of `sys_abcd` and must NOT match it.
  const prefix = await objectGitInfo(amir, 'agent-system', 'sys_abc', { reposDir });
  assert.equal(prefix.head, null, 'a prefix of a listed id is not that id');
  registerKinds();
});

test('L-1: an unregistered kind is refused BEFORE any version is read', async () => {
  // A sha that does not exist in the repo at all: if the read ran first it would throw something
  // else (or 500), so this pins the ORDER as well as the answer.
  const e = await restoreVersion(amir, 'agent-system', 'sys_1', 'deadbeef', { reposDir }).catch((x) => x);
  assert.equal(e.code, 'restore_unsupported');
  assert.equal(e.status, 501);
});

test('M-3: a version containing a BINARY file cannot be restored — it would truncate the file', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('latin1');
  const commit = await commitTree('bin2', new Map([['apps/x/logo.png', png], ['apps/x/app.ts', 'export const a = 1;\n']]), {
    reposDir,
    author,
    message: commitMessage({ area: 'data', domain: 'bin2', action: 'push app files', object: 'x', objectId: 'app_1 (X)', surface: 'mcp:push_app_files', requestId: 'r' }),
    timestamp: 1_700_000_000,
  });
  __clearGitObjectRegistry();
  registerGitObject('software', () => ({ domain: 'bin2', paths: ['apps/x/'], trailerId: 'app_1' }));
  let called = 0;
  registerGitObjectRestorer('software', async () => {
    called++;
    return { sha: 'x', changed: true };
  });
  const e = await restoreVersion(amir, 'software', 'app_1', commit.sha, { reposDir }).catch((x) => x);
  assert.equal(e.code, 'binary_in_version');
  assert.equal(e.status, 409);
  assert.match(e.message, /logo\.png/);
  assert.equal(called, 0, 'the writer must never be handed an empty binary file');
  // The version READ still works and names the binary file rather than decoding it.
  const version = await getVersion(amir, 'software', 'app_1', commit.sha, { reposDir });
  const blob = version.files.find((f) => f.path === 'apps/x/logo.png')!;
  assert.equal(blob.binary, true);
  assert.equal(blob.content, '');
  registerKinds();
});

test('M-1: getVersion and diffVersions REDACT secret-shaped bytes, and say that they did', async () => {
  const one = await commitTree('secret-obj', new Map([['agents/s/system.yaml', 'name: S\napi_key: abcdef1234567890\n']]), {
    reposDir,
    author,
    message: commitMessage({ area: 'agents', domain: 'secret-obj', action: 'create system', object: 's', objectId: 'sys_s (S)', surface: 'ui:agents', requestId: 'r1' }),
    timestamp: 1_700_000_000,
  });
  const two = await commitTree('secret-obj', new Map([['agents/s/system.yaml', 'name: S2\napi_key: 0987654321fedcba\n']]), {
    reposDir,
    author,
    message: commitMessage({ area: 'agents', domain: 'secret-obj', action: 'edit system', object: 's', objectId: 'sys_s (S)', surface: 'ui:agents', requestId: 'r2' }),
    timestamp: 1_700_000_100,
  });
  __clearGitObjectRegistry();
  registerGitObject('agent-system', () => ({ domain: 'secret-obj', paths: ['agents/s/'], trailerId: 'sys_s' }));
  const version = await getVersion(amir, 'agent-system', 'sys_s', two.sha, { reposDir });
  assert.equal(version.redacted, true);
  assert.deepEqual(version.redactedPaths, [{ path: 'agents/s/system.yaml', kinds: ['keyed-value'] }]);
  assert.ok(!version.files[0].content.includes('0987654321fedcba'), 'the secret never leaves the OS');
  assert.ok(version.files[0].content.includes(REDACTED));
  assert.ok(version.files[0].content.includes('name: S2'), 'the rest of the file is untouched');
  const diff = await diffVersions(amir, 'agent-system', 'sys_s', one.sha, two.sha, { reposDir });
  assert.equal(diff.redacted, true);
  assert.ok(!diff.patch.includes('abcdef1234567890') && !diff.patch.includes('0987654321fedcba'));
  assert.match(diff.patch, /-name: S\n\+name: S2/, 'the real change is still visible');
  registerKinds();
});

test('H-2: resolveTrailerForUser answers only for an object the caller may actually see', async () => {
  assert.deepEqual(await resolveTrailerForUser(amir, 'sys_1 (Support)'), { kind: 'agent-system', id: 'sys_1' });
  assert.deepEqual(await resolveTrailerForUser(amir, 'ds_1 (Orders)'), { kind: 'dataset', id: 'ds_1' });
  assert.equal(await resolveTrailerForUser(amir, 'sys_hidden (Someone else)'), null, 'an invisible object is not resolvable');
  assert.equal(await resolveTrailerForUser(amir, 'sales'), null, 'a DOMAIN-attributed reconcile trailer names no object');
  assert.equal(await resolveTrailerForUser(amir, ''), null);
  // A kind with NO registered resolver cannot be checked, so it must answer null (fail closed).
  __clearGitObjectRegistry();
  assert.equal(await resolveTrailerForUser(amir, 'dash_1 (Sales)'), null);
  registerKinds();
});

test('H-1: the repositories overview HYDRATES the mirror records before reading them', async () => {
  // The cold-pod hazard, reproduced: `signals()` answers nothing until `hydrate()` has resolved.
  let hydrated = false;
  const order: string[] = [];
  const overview = await repositoriesOverview({
    reposDir,
    hydrate: async () => {
      order.push('hydrate');
      await new Promise((r) => setTimeout(r, 5));
      hydrated = true;
    },
    signals: () => {
      order.push('signals');
      return hydrated
        ? [{ domain: 'sales', url: 'https://git.example/sales.git', lastSha: 'abc', lastPushedAt: '2026-11-14T09:00:00.000Z' }]
        : [];
    },
    summaries: async () => [
      { domain: 'sales', head: 'abc', commits: 3, countTruncated: false, lastAuthor: 'Amir', lastSubject: 'c', lastAt: '2026-11-14T09:00:00.000Z' },
    ],
  });
  assert.deepEqual(order, ['hydrate', 'signals'], 'the await must come FIRST, or a cold pod reports no mirror at all');
  assert.ok(overview.repos[0].mirror, 'the configured mirror is found — not a false "no push-mirror configured"');
  assert.equal(overview.repos[0].mirror!.url, 'https://git.example/sales.git');
  // The layout table travels with it, so the section cannot drift from the kernel's own table.
  assert.deepEqual(overview.layout.map((l) => l.kind), [...GIT_OBJECT_KINDS]);
});

test('H-2: the repository commit log lists ONLY commits whose object the caller can resolve', async () => {
  const visible = await repositoryCommitLog(amir, 'sales', { reposDir, limit: 50 });
  // The seeded repo holds a boot reconcile attributed to the DOMAIN plus per-object commits. The
  // reconcile names no object, so it cannot be shown; every listed row resolves to a real kind.
  assert.ok(visible.commits.length >= 2);
  assert.deepEqual(
    [...new Set(visible.commits.map((c) => `${c.kind}:${c.object}`))].sort(),
    ['agent-system:sys_1 (Support)', 'dataset:ds_1 (Orders)'],
  );
  assert.ok(
    visible.commits.every((c) => c.object && c.kind),
    'a listed row always names the object it was about',
  );
  assert.ok(visible.hidden >= 1, 'the domain-attributed reconcile is withheld');
  assert.match(visible.note, /could not be resolved for you/);
  // With NOTHING registered, nothing resolves — and the count says so instead of looking empty.
  __clearGitObjectRegistry();
  const blind = await repositoryCommitLog(amir, 'sales', { reposDir, limit: 50 });
  assert.deepEqual(blind.commits, []);
  assert.ok(blind.hidden >= 3);
  assert.match(blind.note, /no resolver registered yet/);
  registerKinds();
  // A domain with no repository is an empty log, not an error.
  const none = await repositoryCommitLog(amir, 'never-seen', { reposDir });
  assert.deepEqual(none.commits, []);
  assert.equal(none.hidden, 0);
  assert.equal(none.note, '');
});
