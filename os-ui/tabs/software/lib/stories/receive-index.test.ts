/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - a git push of story files: the receive validator and the index hook
 * USER STORY: As a developer I want a malformed story or a duplicate id refused at push time with the file and line,
 *             and an accepted push re-indexed so the Stories view shows it, with the flag off changing nothing.
 * ARCHITECTURE: The validator is called exactly as the receive gate calls it (synchronously, file by file, one loop);
 *             the hook runs through the REAL app ingest (`ingestApps`) with the registration this module makes on
 *             import, against a real repository commit made as a developer (no OS trailers).
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import type { Pusher } from '@core/infra/git-receive';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, getAppByIdInternal, appRegistryHydrated } = await import('../apps.ts');
const ri = await import('./receive-index.ts');
const { registeredRepoKinds } = await import('@core/infra/git-receive');
const { receiveHookNames } = await import('../receive-hooks.ts');
const { ingestApps } = await import('../app-receive.ts');
const { renderEpicFile, renderStoryFile } = await import('./files.ts');
const { specHistory } = await import('./history.ts');
const { recordFromOutcome } = await import('../check-record.ts');
const gs = await import('@core/infra/git-store');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-stories-rx-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });
const flag = (on: boolean) => { process.env.SOFTWARE_APP_BUILDER = on ? 'on' : 'off'; };

const alice: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const pusher: Pusher = { id: 'alice', name: 'Alice', role: 'creator', domains: ['sales'] };
const epic = renderEpicFile({ id: 'EP-1', title: 'Orders', description: '', requirements: { technical: '', ux: '', governance: '' } });
const story = (id = 'US-1', epicId = 'EP-1') =>
  renderStoryFile({ id: id as 'US-1', epic: epicId as 'EP-1', title: 'Submit', asA: 'rep', iWant: 'to submit', soThat: 'it ships', state: 'draft', criteria: [{ id: 'AC-1', title: 'ok', given: ['g'], when: ['w'], then: ['t'] }], notes: '' });

test('importing the module registers the stories repo kind and the index hook', () => {
  assert.ok(registeredRepoKinds().some((k) => k.kind === ri.STORIES_KIND));
  assert.ok(receiveHookNames().includes(ri.STORIES_HOOK));
});

test('flag OFF: the kind matches nothing and the validator accepts anything (no push is judged differently)', async () => {
  flag(false);
  const app = await (async () => { flag(true); const a = await createApp(alice, { name: 'Off Rx', template: 'nextjs-web', templateVersion: 2 }); flag(false); return a; })();
  const p = `apps/${app.slug}/stories/EP-1/US-1.md`;
  assert.equal(ri.matchesStories(p), false);
  assert.equal(ri.validateStoriesFile({ path: p, content: 'garbage' }), null);
  delete process.env.SOFTWARE_APP_BUILDER;
  assert.equal(ri.matchesStories(p), false);
});

test('flag ON: a malformed story is refused with path:line, reason and fix; a layout violation is refused; a good file passes', async () => {
  flag(true);
  const app = await createApp(alice, { name: 'Rx Desk', template: 'nextjs-web', templateVersion: 2 });
  const base = `apps/${app.slug}/stories`;
  assert.equal(ri.matchesStories(`${base}/EP-1/US-1.md`), true);
  assert.equal(ri.matchesStories(`apps/${app.slug}/src/stories/x.ts`), false);
  assert.equal(ri.validateStoriesFile({ path: `${base}/EP-1/_epic.md`, content: epic }), null);
  await Promise.resolve();
  const msg = ri.validateStoriesFile({ path: `${base}/EP-1/US-1.md`, content: story().replace('- Then t\n', '') });
  assert.match(msg ?? '', /^stories\/EP-1\/US-1\.md:\d+: AC-1 has no 'Then' line\. Add '- Then …'/);
  assert.match(ri.validateStoriesFile({ path: `${base}/notes.txt`, content: 'x' }) ?? '', /not part of the living spec layout/);
  assert.match(ri.validateStoriesFile({ path: `${base}/EP-1/US-2.md`, content: story() }) ?? '', /file name says US-2/);
  assert.equal(ri.validateStoriesFile({ path: `${base}/README.md`, content: '# how to' }), null);
  assert.equal(ri.validateStoriesFile({ path: `apps/${app.slug}/src/page.tsx`, content: 'x' }), null, 'not a stories path: not this kind');
});

test('flag ON: a duplicate story id within ONE push is refused naming both paths; the next push starts fresh', async () => {
  flag(true);
  const app = await createApp(alice, { name: 'Dup Desk', template: 'nextjs-web', templateVersion: 2 });
  const base = `apps/${app.slug}/stories`;
  await Promise.resolve();
  // One gate loop: synchronous calls.
  assert.equal(ri.validateStoriesFile({ path: `${base}/EP-1/US-1-a.md`, content: story() }), null);
  assert.equal(ri.validateStoriesFile({ path: `${base}/EP-1/_epic.md`, content: epic }), null);
  const dup = ri.validateStoriesFile({ path: `${base}/EP-1/US-1-b.md`, content: story() });
  assert.match(dup ?? '', /the story id US-1 is used twice in this push: stories\/EP-1\/US-1-a\.md and stories\/EP-1\/US-1-b\.md/);
  const dupEpic = ri.validateStoriesFile({ path: `${base}/EP-1-x/_epic.md`, content: epic });
  assert.match(dupEpic ?? '', /EP-1 has two folders in this push/);
  // The same id in ANOTHER app of the same push is fine.
  const other = await createApp(alice, { name: 'Dup Desk Two', template: 'nextjs-web', templateVersion: 2 });
  await Promise.resolve();
  assert.equal(ri.validateStoriesFile({ path: `apps/${app.slug}/stories/EP-1/US-1-a.md`, content: story() }), null);
  assert.equal(ri.validateStoriesFile({ path: `apps/${other.slug}/stories/EP-1/US-1-a.md`, content: story() }), null);
  await Promise.resolve();
  assert.equal(ri.validateStoriesFile({ path: `${base}/EP-1/US-1-b.md`, content: story() }), null, 'a new gate loop forgets the previous one');
});

test('a v1 app is never judged by the stories validator once the registry is hydrated', async () => {
  flag(true);
  const v1 = await createApp(alice, { name: 'Classic Desk', template: 'nextjs-web' });
  await Promise.resolve();
  if (await appRegistryHydrated()) assert.equal(ri.validateStoriesFile({ path: `apps/${v1.slug}/stories/whatever.txt`, content: 'x' }), null);
  else assert.ok(ri.validateStoriesFile({ path: `apps/${v1.slug}/stories/whatever.txt`, content: 'x' }), 'cold cache fails closed to v2');
});

test('the index hook through the real app ingest: a developer push re-indexes App.stories at the pushed sha; history says git', async () => {
  flag(true);
  const app = await createApp(alice, { name: 'Push Desk', template: 'nextjs-web', templateVersion: 2 });
  const files = new Map<string, string>([
    [`apps/${app.slug}/stories/EP-1-orders/_epic.md`, epic],
    [`apps/${app.slug}/stories/EP-1-orders/US-1-submit.md`, story()],
    [`apps/${app.slug}/stories/EP-1-orders/US-2-cancel.md`, story('US-2').replace('title: Submit', 'title: Cancel')],
  ]);
  const { sha } = await gs.commitSubtree(app.domain, `apps/${app.slug}/stories`, files, { reposDir, author: { name: 'Dev', email: 'dev@example.com' }, message: 'stories from VS Code' });
  const changed = [...files].map(([path, content]) => ({ path, status: 'added' as const, content }));
  const checks = async (i: { sha: string; trigger: string }) => ({
    record: { ...recordFromOutcome({ sha: i.sha, trigger: 'push', engine: 'tekton', startedAt: 't0', finishedAt: 't1', outcome: { ok: false, error: 'no engine in this test' } }) },
    superseded: [],
  });
  const report = await ingestApps({ domain: app.domain, files: changed, pusher, sha }, { checks: checks as never, readMessages: async () => ['stories from VS Code'] });
  assert.ok(report.notes.some((n) => n.includes(`indexed 1 epic(s) and 2 story(ies) at ${sha.slice(0, 12)}`)), report.notes.join('\n'));
  const fresh = await getAppByIdInternal(app.id);
  assert.equal(fresh?.stories?.sha, sha);
  assert.deepEqual(fresh?.stories?.index.stories.map((s) => s.title), ['Submit', 'Cancel']);
  const versions = await specHistory(app.id, alice, 'US-2');
  assert.equal(versions[0].source, 'git');
  assert.equal(versions[0].author.name, 'Dev');
  // A cross-file duplicate the per-file validator could not see is reported in the push output and not indexed twice.
  files.set(`apps/${app.slug}/stories/EP-1-orders/US-1-copy.md`, story());
  const second = await gs.commitSubtree(app.domain, `apps/${app.slug}/stories`, files, { reposDir, author: { name: 'Dev', email: 'dev@example.com' }, message: 'copy' });
  const r2 = await ri.storiesIndexHook({ app: fresh!, changed: [{ path: `apps/${app.slug}/stories/EP-1-orders/US-1-copy.md`, status: 'added', content: story() }], sha: second.sha, pusher, messages: [] });
  assert.ok(r2.some((n) => /US-1 is used twice/.test(n)), r2.join('\n'));
  assert.equal((await getAppByIdInternal(app.id))?.stories?.index.stories.length, 2);
});

test('the index hook ignores a v1 app and a push that touched no story of an indexed app', async () => {
  flag(true);
  const v1 = await createApp(alice, { name: 'Hook V1', template: 'nextjs-web' });
  assert.deepEqual(await ri.storiesIndexHook({ app: v1, changed: [], sha: 'a'.repeat(40), pusher, messages: [] }), []);
  const v2 = await createApp(alice, { name: 'Hook V2', template: 'nextjs-web', templateVersion: 2 });
  const withIndex = { ...v2, stories: { sha: 'x', index: { sha: 'x', epics: [], stories: [] } } };
  assert.deepEqual(await ri.storiesIndexHook({ app: withIndex, changed: [{ path: `apps/${v2.slug}/src/a.ts`, status: 'modified', content: 'x' }], sha: 'a'.repeat(40), pusher, messages: [] }), []);
});

test('the kind ingest counts story files created and updated', async () => {
  const r = await ri.ingestStories({ files: [{ path: 'a', status: 'added', content: 'x' }, { path: 'b', status: 'modified', content: 'y' }, { path: 'c', status: 'deleted', content: null }] });
  assert.deepEqual(r, { kind: 'stories', created: 1, updated: 1, skipped: 0, notes: [] });
});
