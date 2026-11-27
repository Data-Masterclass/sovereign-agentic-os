/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - a story saved in the OS survives every code door (review of #388, HIGH + MEDIUM + LOW)
 * USER STORY: As a business user I never want a code save, a push of files or a build to silently revert or delete the
 *             story I just saved; and as a developer I want a clear refusal when a code door tries to write stories/.
 * ARCHITECTURE: Real createApp (nextjs-web@2, flag on) into a temp repos dir. A story is saved through the store, then
 *             each whole-tree door runs: `pushAppFiles` (MCP/UI push), `saveAppFile` (code editor), `commitToApp`
 *             (build / generate / commit) — once with the cache the story save left, once with a deliberately STALE
 *             cache — and the story file must be in git byte-identical. Plus: the doors refuse stories/ writes, the
 *             App Builder tools are not advertised while the switch is off, the migration is attributed to the
 *             platform with the opening user in a trailer, and a pushed id far above the index is refused.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, saveAppFile, getAppByIdInternal, persistApp } = await import('../apps.ts');
const { pushAppFiles } = await import('../push-app-files.ts');
const { commitToApp, getSnapshot, snapshotFiles } = await import('../server.ts');
const store = await import('./store.ts');
const { migrateEpicsToFiles } = await import('./migrate.ts');
const ri = await import('./receive-index.ts');
const { renderStoryFile } = await import('./files.ts');
const { listToolsForRole } = await import('@core/mcp/server');
const { appBuilderTools } = await import('../../mcp/app-builder/index.ts');
const gs = await import('@core/infra/git-store');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-stories-doors-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});
beforeEach(() => { process.env.SOFTWARE_APP_BUILDER = 'on'; });
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

const bea: CurrentUser = { id: 'bea', name: 'Bea', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' };
const storyIn = (title: string) => ({ epic: 'EP-1', title, asA: 'rep', iWant: 'to submit', soThat: 'it ships', criteria: [{ title: 'ok', given: ['g'], when: ['w'], then: ['t'] }] });

async function appWithStory(name: string) {
  const app = await createApp(bea, { name, template: 'nextjs-web', templateVersion: 2 });
  await store.saveEpic(app.id, bea, { title: 'Orders' }, { source: 'ui' });
  const s = await store.saveStory(app.id, bea, storyIn('Submit'), { source: 'ui' });
  const path = `apps/${app.slug}/${s.story.path}`;
  const content = await gs.readBlob(app.domain, 'main', path, { reposDir });
  return { app, path, content, storyPath: s.story.path };
}
const inGit = async (domain: string, path: string) => gs.readBlob(domain, 'main', path, { reposDir }).catch(() => null);

test('HIGH: the story file survives push_app_files, the code editor and commitToApp — and the cache carries it', async () => {
  const { app, path, content, storyPath } = await appWithStory('Doors Desk');
  // (a) the story save merged stories/ into the file cache.
  assert.equal(getSnapshot(app.id)?.find((f) => f.path === storyPath)?.content, content);
  await pushAppFiles({ appId: app.id, files: [{ path: 'README.md', content: '# pushed\n' }] }, bea);
  assert.equal(await inGit(app.domain, path), content, 'push_app_files kept the story');
  const readme = getSnapshot(app.id)?.find((f) => f.path === 'README.md');
  await saveAppFile(app.id, bea, { path: 'README.md', content: '# edited\n', sha: '' });
  assert.ok(readme);
  assert.equal(await inGit(app.domain, path), content, 'the code editor kept the story');
  await commitToApp(app.id, bea, [{ path: 'docs/NOTE.md', content: 'build output\n' }], 'generate');
  assert.equal(await inGit(app.domain, path), content, 'commitToApp (build/generate) kept the story');
});

test('HIGH: with a STALE cache (from before the story existed / an older version), every door still commits the story from git', async () => {
  const { app, path, content, storyPath } = await appWithStory('Stale Desk');
  // A cache that predates the story entirely: the bug was "next code save deletes it".
  const stale = (getSnapshot(app.id) ?? []).filter((f) => !f.path.startsWith('stories/'));
  snapshotFiles(app.id, stale);
  await commitToApp(app.id, bea, [{ path: 'docs/A.md', content: 'a\n' }], 'generate');
  assert.equal(await inGit(app.domain, path), content, 'a stale cache did not delete the story');
  assert.equal(getSnapshot(app.id)?.find((f) => f.path === storyPath)?.content, content, 'the cache was healed from git');
  // A cache with an OLDER story version: the bug was "next code save reverts it".
  await store.saveStory(app.id, bea, { ...storyIn('Submit v2'), id: 'US-1' }, { source: 'ui' });
  const v2 = await inGit(app.domain, path);
  assert.match(v2 ?? '', /Submit v2/);
  snapshotFiles(app.id, [...stale, { path: storyPath, content }]);
  await saveAppFile(app.id, bea, { path: 'README.md', content: '# again\n', sha: '' });
  assert.equal(await inGit(app.domain, path), v2, 'a stale story in the cache did not revert the newer one');
  await pushAppFiles({ appId: app.id, files: [{ path: 'docs/B.md', content: 'b\n' }] }, bea);
  assert.equal(await inGit(app.domain, path), v2);
});

test('MEDIUM: code doors refuse stories/ writes with a pointer to the stories tools; nothing is written', async () => {
  const { app, path, content } = await appWithStory('Refuse Desk');
  const head = (await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha;
  const forged = renderStoryFile({ id: 'US-1', epic: 'EP-1', title: 'Forged', asA: '', iWant: '', soThat: '', state: 'agreed', criteria: [], notes: '' });
  await assert.rejects(
    pushAppFiles({ appId: app.id, files: [{ path: 'stories/EP-1-orders/US-1-submit.md', content: forged }] }, bea),
    (e: Error & { status?: number }) => e.status === 400 && /stories tools/.test(e.message),
  );
  await assert.rejects(saveAppFile(app.id, bea, { path: 'stories/EP-1-orders/US-1-submit.md', content: forged, sha: '' }), (e: Error & { status?: number }) => e.status === 400);
  await assert.rejects(commitToApp(app.id, bea, [{ path: 'stories/EP-9/_epic.md', content: 'x' }], 'build'), (e: Error & { status?: number }) => e.status === 400);
  assert.equal((await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha, head);
  assert.equal(await inGit(app.domain, path), content);
});

test('flag off: whole-tree commits and code doors behave exactly as before (no preservation, no refusal)', async () => {
  const app = await createApp(bea, { name: 'Classic Doors', template: 'nextjs-web' });
  delete process.env.SOFTWARE_APP_BUILDER;
  const r = await pushAppFiles({ appId: app.id, files: [{ path: 'stories/notes.md', content: 'a v1 app may have a stories folder\n' }] }, bea);
  assert.ok(r);
  assert.equal(await inGit(app.domain, `apps/${app.slug}/stories/notes.md`), 'a v1 app may have a stories folder\n');
});

test('LOW: App Builder tools are not advertised while the switch is off; a direct call is still refused', async () => {
  const names = appBuilderTools.map((t) => t.name);
  assert.ok(names.includes('get_stories'));
  const on = listToolsForRole('admin', appBuilderTools).map((t) => t.name);
  assert.deepEqual(on.sort(), [...names].sort());
  delete process.env.SOFTWARE_APP_BUILDER;
  assert.deepEqual(listToolsForRole('admin', appBuilderTools), []);
  await assert.rejects(appBuilderTools[0].call(bea, { appId: 'x' }), (e: Error & { code?: string }) => e.code === 'app_builder_disabled');
});

test('LOW: the migration commit is authored by the platform, with the opening user in OS-Requested-By', async () => {
  const app = await createApp(bea, { name: 'Migrate Author', template: 'nextjs-web', templateVersion: 2 });
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = [{ id: 'e1', title: 'Old', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [{ id: 's1', title: 'Old story', asA: '', iWant: '', soThat: '', acceptance: '' }] }];
  await persistApp(rec!);
  assert.equal((await migrateEpicsToFiles(app.id, bea)).migrated, true);
  const head = (await gs.log(app.domain, { reposDir, limit: 1 }))[0];
  assert.equal(head.author.name, 'Sovereign OS');
  assert.equal(head.trailers['OS-Requested-By'], 'bea');
  assert.equal(head.trailers['OS-Source'], 'migration');
});

test('LOW: a pushed id far above the indexed ids is refused (ids are the OS\'s to assign)', async () => {
  const hw = { epic: 1, story: 1 };
  assert.equal(ri.pushedIdRefusal('stories/EP-1/US-1001.md', 'story', `US-${1 + ri.PUSHED_ID_MARGIN}`, hw), null, 'within the margin');
  assert.match(ri.pushedIdRefusal('stories/EP-1/US-1002.md', 'story', `US-${2 + ri.PUSHED_ID_MARGIN}`, hw) ?? '', /more than 1000 above the highest story id/);
  assert.match(ri.pushedIdRefusal('stories/EP-1500/_epic.md', 'epic', 'EP-1500', hw) ?? '', /highest epic id/);
  assert.equal(ri.pushedIdRefusal('stories/EP-1/US-99999.md', 'story', 'US-99999', null), null, 'a cold index caps nothing');
  // Through the validator, when the registry is warm: the index holds US-1, so US-1002 is refused.
  const { app } = await appWithStory('Cap Desk');
  const { appRegistryHydrated } = await import('../apps.ts');
  await Promise.resolve();
  const body = renderStoryFile({ id: 'US-1002', epic: 'EP-1', title: 'x', asA: '', iWant: '', soThat: '', state: 'draft', criteria: [], notes: '' });
  const r = ri.validateStoriesFile({ path: `apps/${app.slug}/stories/EP-1-orders/US-1002-x.md`, content: body });
  if (await appRegistryHydrated()) assert.match(r ?? '', /more than 1000 above/);
});
