/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The role mapping is a real file, `os/models.yml`, in the platform repository.
 * USER STORY: As a platform admin I can see who changed the role mapping and when, diff two versions
 *             and restore an old one, because it is a committed file.
 * ARCHITECTURE:
 *   - A real git repository in a temp directory (the OS's own git store). Other files under `os/`
 *     belong to other writers and must survive a write.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitSubtree, log, readBlob } from '@core/infra/git-store';
import { PLATFORM_REPO } from '@core/infra/repo-layout';
import { MODELS_FILE, platformRoleStore } from '@core/models/role-store';

const reposDir = mkdtempSync(join(tmpdir(), 'os-roles-'));
after(() => rmSync(reposDir, { recursive: true, force: true }));
const M = { 'sovereign-strong': 'a', 'sovereign-worker': 'b', 'sovereign-embedding': 'c' } as const;

test('no file yet = null (unmapped), not an invented mapping', async () => {
  assert.equal(await platformRoleStore({ reposDir }).read(), null);
});

test('write commits os/models.yml in the platform repo as the actor; read returns it; history shows both versions', async () => {
  const store = platformRoleStore({ reposDir });
  await commitSubtree(PLATFORM_REPO, 'os/', new Map([['os/other-writer.yml', 'keep: me\n']]), { reposDir, author: { name: 'Other', email: 'o@x' }, message: 'another writer' });
  const first = await store.write({ ...M }, { id: 'admin1', name: 'Ada Admin', email: 'ada@example.com' });
  assert.equal(first.changed, true);
  assert.deepEqual(await store.read(), M);
  await store.write({ ...M, 'sovereign-strong': 'z' }, { id: 'admin1', name: 'Ada Admin', email: 'ada@example.com' });
  assert.equal((await store.read())!['sovereign-strong'], 'z');
  const commits = await log(PLATFORM_REPO, { reposDir });
  assert.ok(commits.length >= 3);
  assert.match(commits[0].message, /role mapping/i);
  assert.equal(commits[0].author.name, 'Ada Admin');
  // restore = read an old revision of the file
  assert.match(await readBlob(PLATFORM_REPO, commits[1].sha, MODELS_FILE, { reposDir }), /sovereign-strong: a/);
  // the other writer's file survived both writes
  assert.equal(await readBlob(PLATFORM_REPO, undefined, 'os/other-writer.yml', { reposDir }), 'keep: me\n');
});

test('an identical write is not a new commit', async () => {
  const store = platformRoleStore({ reposDir });
  const before = (await log(PLATFORM_REPO, { reposDir })).length;
  const r = await store.write({ ...M, 'sovereign-strong': 'z' }, { id: 'admin1' });
  assert.equal(r.changed, false);
  assert.equal((await log(PLATFORM_REPO, { reposDir })).length, before);
});

test('NEGATIVE TWIN: a file that does not parse is a typed error on read, never an empty or default mapping', async () => {
  await commitSubtree(PLATFORM_REPO, 'os/', new Map([[MODELS_FILE, 'roles: nonsense\n'], ['os/other-writer.yml', 'keep: me\n']]), { reposDir, author: { name: 'x', email: 'x@x' }, message: 'break it' });
  await assert.rejects(platformRoleStore({ reposDir }).read(), (e: unknown) => (e as { code?: string }).code === 'invalid_mapping');
});

test('the live IO commits as the admin: real name and email, no synthesized mailbox; the head revision moves with each commit', async () => {
  const { liveRoleIo } = await import('@core/models/role-live');
  const io = liveRoleIo({ reposDir });
  const before = await io.readRevision();
  await io.writeMapping({ ...M, 'sovereign-worker': 'w2' }, { id: 'admin1', name: 'Ada Admin', email: 'ada@example.com' });
  const head = (await log(PLATFORM_REPO, { reposDir, limit: 1 }))[0];
  assert.deepEqual([head.author.name, head.author.email], ['Ada Admin', 'ada@example.com']);
  assert.equal(head.trailers['OS-Author-Email'], undefined);
  assert.notEqual(await io.readRevision(), before);
  assert.equal(await io.readRevision(), head.sha);
  // an admin without a known email is marked as synthesized, never silently invented
  await io.writeMapping({ ...M, 'sovereign-worker': 'w3' }, { id: 'admin2' });
  const syn = (await log(PLATFORM_REPO, { reposDir, limit: 1 }))[0];
  assert.match(syn.author.email, /@os\.local$/);
  assert.equal(syn.trailers['OS-Author-Email'], 'synthesized');
});
