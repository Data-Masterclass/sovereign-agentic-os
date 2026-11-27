/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the living spec in git: commits, ids, history, migration (real repos, real principals)
 * USER STORY: As a business user I want each save to be a commit with my name and the OS-Source trailer, ids that never
 *             collide, a history that names who changed what from where, and my old record epics migrated once.
 * ARCHITECTURE: Real `createApp` (template nextjs-web@2, flag on) into a temp repos dir, the store functions as the
 *             routes and MCP tools call them, git read back through the git store. A developer's push is simulated
 *             with a plain `commitSubtree` carrying no OS trailers. Every "on" case has a refusal twin.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { APP_BUILDER_DISABLED } from '@core/kernel/app-builder-flag';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, persistApp, getAppByIdInternal } = await import('../apps.ts');
const store = await import('./store.ts');
const { specHistory, specSourceOf } = await import('./history.ts');
const { migrateEpicsToFiles, legacyEpicsToFiles } = await import('./migrate.ts');
const { nextEpicId, nextStoryId, nextCriterionId, idsInPaths, criterionIdsIn } = await import('./ids.ts');
const gs = await import('@core/infra/git-store');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-stories-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});
beforeEach(() => { process.env.SOFTWARE_APP_BUILDER = 'on'; });
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

const user = (id: string, domains: string[], role: CurrentUser['role'] = 'creator'): CurrentUser => ({ id, name: id[0].toUpperCase() + id.slice(1), domains, allDomains: domains, activeDomain: null, role });
const alice = user('alice', ['sales']);
const bob = user('bob', ['sales']);
const mallory = user('mallory', ['hr']);

const v2 = (name: string, by = alice) => createApp(by, { name, template: 'nextjs-web', templateVersion: 2 });
const epicIn = (title = 'Order intake') => ({ title, description: 'Take orders.', requirements: { technical: 'Postgres', ux: '', governance: '' } });
const storyIn = (epic: string, title = 'Submit an order') => ({
  epic,
  title,
  asA: 'sales rep',
  iWant: 'to submit an order',
  soThat: 'the warehouse can ship it',
  criteria: [{ title: 'Valid order is accepted', given: ['a signed-in sales rep'], when: ['they submit'], then: ['the order is saved'] }],
});
const headOf = async (domain: string) => (await gs.log(domain, { reposDir, limit: 1 }))[0];
const disabled = (e: unknown) => (e as { code?: string }).code === APP_BUILDER_DISABLED;

// ------------------------------------------------------------------- ids (pure) ---
test('ids: highest seen plus one; never below a seen id; criteria per story', () => {
  assert.equal(nextEpicId({ epics: [] }), 'EP-1');
  assert.equal(nextEpicId({ epics: [{ id: 'EP-2' }, { id: 'EP-9' }] }), 'EP-10');
  assert.equal(nextStoryId({ stories: [{ id: 'US-3' }] }, ['US-7']), 'US-8', 'an id seen in history is not reused');
  assert.equal(nextCriterionId({ criteria: [{ id: 'AC-1' }, { id: 'AC-2' }] }, ['AC-5']), 'AC-6');
  assert.equal(nextStoryId({ stories: [{ id: 'junk' }] }), 'US-1');
  assert.deepEqual(idsInPaths(['stories/EP-3-a/_epic.md', 'stories/EP-3-a/US-12-x.md']), { epics: ['EP-3'], stories: ['US-12'] });
  assert.deepEqual(criterionIdsIn('### AC-1 a\n- Given\n### AC-4\n'), ['AC-1', 'AC-4']);
});

// ---------------------------------------------------------------- store: writes ---
test('save an epic and a story: one commit each, authored by the user, OS-Source: ui; the index is rebuilt', async () => {
  const app = await v2('Order Desk');
  const e = await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  assert.equal(e.epic.id, 'EP-1');
  assert.equal(e.epic.path, 'stories/EP-1-order-intake/_epic.md');
  const s = await store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' });
  assert.equal(s.story.id, 'US-1');
  assert.equal(s.story.criteria[0].id, 'AC-1');
  assert.equal(s.story.state, 'draft');
  const head = await headOf(app.domain);
  assert.equal(head.sha, s.sha);
  assert.equal(head.author.name, 'Alice');
  assert.equal(head.trailers['OS-Source'], 'ui');
  assert.equal(head.trailers['OS-Actor'], 'alice');
  assert.match(head.subject, /stories .* add story Submit an order/);
  // Only stories/ changed: the app's code is untouched by a story save.
  const diff = await gs.diffPaths(app.domain, head.parents[0], head.sha, [`apps/${app.slug}/`], { reposDir });
  assert.deepEqual(diff.files.map((f) => f.path), [`apps/${app.slug}/stories/EP-1-order-intake/US-1-submit-an-order.md`]);
  const fresh = await getAppByIdInternal(app.id);
  assert.equal(fresh?.stories?.sha, s.sha);
  assert.deepEqual(fresh?.stories?.index.stories.map((x) => x.id), ['US-1']);
  const read = await store.readSpec(app.id, alice);
  assert.equal(read.spec.sha, s.sha);
  assert.equal(read.spec.stories[0].asA, 'sales rep');
  assert.deepEqual(read.issues, []);
});

test('an unchanged save is no commit; an edit keeps ids and the path, new criteria get the next id', async () => {
  const app = await v2('Edit Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  const s1 = await store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' });
  const same = await store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', criteria: [{ id: 'AC-1', ...storyIn('EP-1').criteria[0] }] }, { source: 'ui' });
  assert.equal(same.changed, false);
  assert.equal(same.sha, s1.sha);
  const s2 = await store.saveStory(
    app.id,
    alice,
    { ...storyIn('EP-1'), id: 'US-1', title: 'Renamed', state: 'agreed', criteria: [{ id: 'AC-1', ...storyIn('EP-1').criteria[0] }, { title: 'Empty order', given: ['a rep'], when: ['no lines'], then: ['refused'] }] },
    { source: 'ui' },
  );
  assert.equal(s2.story.path, s1.story.path, 'a title change never renames the file (names are cosmetic)');
  assert.deepEqual(s2.story.criteria.map((c) => c.id), ['AC-1', 'AC-2']);
  assert.equal(s2.story.state, 'agreed');
  // Remove AC-2, then add another one: AC-2 is in the file's history, so the new one is AC-3.
  await store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', criteria: [{ id: 'AC-1', ...storyIn('EP-1').criteria[0] }] }, { source: 'ui' });
  const s4 = await store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', criteria: [{ id: 'AC-1', ...storyIn('EP-1').criteria[0] }, { title: 'Later', given: ['g'], when: ['w'], then: ['t'] }] }, { source: 'ui' });
  assert.deepEqual(s4.story.criteria.map((c) => c.id), ['AC-1', 'AC-3']);
});

test('concurrent creates never collide: three stories at once get three ids', async () => {
  const app = await v2('Race Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  const out = await Promise.all([1, 2, 3].map((n) => store.saveStory(app.id, alice, storyIn('EP-1', `Story ${n}`), { source: 'ui' })));
  assert.deepEqual(out.map((o) => o.story.id).sort(), ['US-1', 'US-2', 'US-3']);
  const read = await store.readSpec(app.id, alice);
  assert.equal(read.spec.stories.length, 3);
  assert.deepEqual(read.issues, []);
});

test('a deleted top id is not handed out again (history window)', async () => {
  const app = await v2('Gap Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  const a = await store.saveStory(app.id, alice, storyIn('EP-1', 'A'), { source: 'ui' });
  await store.saveStory(app.id, alice, storyIn('EP-1', 'B'), { source: 'ui' });
  await store.commitSpecChange(app.id, alice, { writes: [], deletes: ['stories/EP-1-order-intake/US-2-b.md'], summary: 'drop B' }, { source: 'ui', message: '' });
  const c = await store.saveStory(app.id, alice, storyIn('EP-1', 'C'), { source: 'ui' });
  assert.equal(a.story.id, 'US-1');
  assert.equal(c.story.id, 'US-3');
});

test('commitSpecChange: OS-Proposal trailer, NEGATIVE duplicate id refused (422, both paths), NEGATIVE paths outside stories/ refused', async () => {
  const app = await v2('Change Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  const s = await store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' });
  const content = (await store.readSpec(app.id, alice)).spec.stories[0];
  const file = (await gs.readBlob(app.domain, 'main', `apps/${app.slug}/${content.path}`, { reposDir }));
  const ok = await store.commitSpecChange(app.id, alice, { writes: [{ path: content.path, content: file.replace('state: draft', 'state: agreed') }], deletes: [], summary: 'agree US-1' }, { source: 'chat', proposalId: 'prop_1', message: 'approve' });
  const head = await headOf(app.domain);
  assert.equal(head.sha, ok.sha);
  assert.equal(head.trailers['OS-Source'], 'chat');
  assert.equal(head.trailers['OS-Proposal'], 'prop_1');
  const before = (await headOf(app.domain)).sha;
  await assert.rejects(
    store.commitSpecChange(app.id, alice, { writes: [{ path: 'stories/EP-1-order-intake/US-1-copy.md', content: file }], deletes: [], summary: 'dup' }, { source: 'mcp', message: '' }),
    (e: Error & { status?: number; issues?: { reason: string }[] }) => e.status === 422 && /US-1 is used twice: .*US-1-copy\.md.*|US-1 is used twice: .*US-1-submit-an-order\.md/.test(e.issues?.[0]?.reason ?? ''),
  );
  for (const bad of ['src/app/page.tsx', 'stories/../src/x.md', '../stories/EP-1/US-9.md', 'stories/EP-1-order-intake/notes.txt', '/etc/passwd']) {
    await assert.rejects(store.commitSpecChange(app.id, alice, { writes: [{ path: bad, content: 'x' }], deletes: [], summary: 's' }, { source: 'mcp', message: '' }), (e: Error & { status?: number }) => e.status === 400, bad);
  }
  await assert.rejects(store.commitSpecChange(app.id, alice, { writes: [], deletes: ['Dockerfile'], summary: 's' }, { source: 'mcp', message: '' }), (e: Error & { status?: number }) => e.status === 400);
  await assert.rejects(store.commitSpecChange(app.id, alice, { writes: [{ path: content.path, content: 'not a story' }], deletes: [], summary: 's' }, { source: 'mcp', message: '' }), (e: Error & { status?: number }) => e.status === 422);
  assert.equal((await headOf(app.domain)).sha, before, 'no refused change wrote a commit');
  assert.ok(s.sha);
});

test('NEGATIVE validation refusals: 422 with issues, unknown criterion id, missing epic, stale save (409)', async () => {
  const app = await v2('Valid Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  await assert.rejects(store.saveStory(app.id, alice, { ...storyIn('EP-1'), title: '' }, { source: 'ui' }), (e: Error & { status?: number; issues?: unknown[] }) => e.status === 422 && Array.isArray(e.issues));
  await assert.rejects(store.saveStory(app.id, alice, { ...storyIn('EP-1'), asA: 'a **bold** rep' }, { source: 'ui' }), (e: Error & { status?: number }) => e.status === 422);
  await assert.rejects(store.saveStory(app.id, alice, storyIn('EP-9'), { source: 'ui' }), (e: Error & { status?: number }) => e.status === 422);
  const s = await store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' });
  await assert.rejects(store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', criteria: [{ id: 'AC-7', title: 'x', given: ['g'], when: ['w'], then: ['t'] }] }, { source: 'ui' }), (e: Error & { status?: number }) => e.status === 422);
  await assert.rejects(store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-99' }, { source: 'ui' }), (e: Error & { status?: number }) => e.status === 404);
  // Two editors: bob's view loaded at s.sha; alice saves; bob's save over the old version is refused.
  await store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', title: 'Alice was here' }, { source: 'ui' });
  await assert.rejects(store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', title: 'Stale', baseSha: s.sha }, { source: 'ui' }), (e: Error & { status?: number }) => e.status === 409);
});

test('NEGATIVE authorization: another domain 404, a colleague who can see but not edit 403, a v1 app 409', async () => {
  const app = await v2('Authz Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  await assert.rejects(store.readSpec(app.id, mallory), (e: Error & { status?: number }) => e.status === 404);
  await assert.rejects(store.saveEpic(app.id, mallory, epicIn(), { source: 'ui' }), (e: Error & { status?: number }) => e.status === 404);
  const shared = await getAppByIdInternal(app.id);
  shared!.visibility = 'Shared';
  await persistApp(shared!);
  assert.equal((await store.readSpec(app.id, bob)).spec.epics.length, 1, 'a domain colleague can read a Domain app');
  await assert.rejects(store.saveEpic(app.id, bob, epicIn('Bob'), { source: 'ui' }), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(await store.canEditSpec(app.id, bob), false);
  assert.equal(await store.canEditSpec(app.id, alice), true);
  const v1 = await createApp(alice, { name: 'Legacy Desk', template: 'nextjs-web' });
  await assert.rejects(store.readSpec(v1.id, alice), (e: Error & { status?: number }) => e.status === 409);
});

test('NEGATIVE flag off: every store entry refuses with app_builder_disabled and writes nothing', async () => {
  const app = await v2('Off Desk');
  delete process.env.SOFTWARE_APP_BUILDER;
  const before = (await headOf(app.domain)).sha;
  await assert.rejects(store.readSpec(app.id, alice), disabled);
  await assert.rejects(store.storiesView(app.id, alice), disabled);
  await assert.rejects(store.saveEpic(app.id, alice, epicIn(), { source: 'ui' }), disabled);
  await assert.rejects(store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' }), disabled);
  await assert.rejects(store.commitSpecChange(app.id, alice, { writes: [], deletes: ['stories/EP-1/_epic.md'], summary: '' }, { source: 'ui', message: '' }), disabled);
  await assert.rejects(specHistory(app.id, alice, 'US-1'), disabled);
  await assert.rejects(migrateEpicsToFiles(app.id, alice), disabled);
  assert.equal((await headOf(app.domain)).sha, before);
});

// ---------------------------------------------------------------------- history ---
test('history: every version with diff, author and source; a push without OS trailers is git; a move keeps the history', async () => {
  const app = await v2('History Desk');
  await store.saveEpic(app.id, alice, epicIn(), { source: 'ui' });
  await store.saveEpic(app.id, alice, epicIn('Second'), { source: 'ui' });
  await store.saveStory(app.id, alice, storyIn('EP-1'), { source: 'ui' });
  await store.saveStory(app.id, alice, { ...storyIn('EP-1'), id: 'US-1', title: 'Second title' }, { source: 'mcp' });
  // A developer's push: a plain commit, no OS trailers.
  const spec = (await store.readSpec(app.id, alice)).spec;
  const cur = await gs.readBlob(app.domain, 'main', `apps/${app.slug}/${spec.stories[0].path}`, { reposDir });
  const files = new Map<string, string>();
  for (const f of (await gs.readSubtree(app.domain, `apps/${app.slug}/stories`, { reposDir }))!.files) files.set(`apps/${app.slug}/stories/${f.path}`, f.content);
  files.set(`apps/${app.slug}/${spec.stories[0].path}`, cur.replace('Second title', 'Pushed title'));
  await gs.commitSubtree(app.domain, `apps/${app.slug}/stories`, files, { reposDir, author: { name: 'Dev Eloper', email: 'dev@example.com' }, message: 'tweak US-1 [US-1]' });
  // Move US-1 to EP-2 through the OS.
  await store.saveStory(app.id, alice, { ...storyIn('EP-2'), id: 'US-1', title: 'Pushed title' }, { source: 'ui' });

  const versions = await specHistory(app.id, alice, 'US-1');
  assert.deepEqual(versions.map((v) => v.source), ['ui', 'git', 'mcp', 'ui']);
  assert.equal(versions[1].author.name, 'Dev Eloper');
  assert.equal(versions[1].author.id, 'dev@example.com');
  assert.equal(versions[0].author.id, 'alice');
  assert.match(versions[1].diff, /-title: Second title\n\+title: Pushed title/);
  assert.match(versions[0].diff, /--- a\/stories\/EP-1-order-intake\/US-1-submit-an-order\.md\n\+\+\+ b\/stories\/EP-2-second\/US-1-pushed-title\.md/);
  assert.match(versions[3].diff, /^--- \/dev\/null|^--- a\//);
  assert.ok(versions.every((v) => /^[0-9a-f]{40}$/.test(v.sha) && !Number.isNaN(Date.parse(v.at))));
  const epicVersions = await specHistory(app.id, alice, 'EP-1');
  assert.equal(epicVersions.length, 1);
  await assert.rejects(specHistory(app.id, alice, '../x'), (e: Error & { status?: number }) => e.status === 400);
});

test('specSourceOf trusts OS-Source only on an OS commit', () => {
  const os = { committer: { name: 'Sovereign OS', email: gs.COMMITTER.email } };
  assert.equal(specSourceOf({ ...os, trailers: { 'OS-Request-Id': 'r', 'OS-Source': 'chat' } }), 'chat');
  assert.equal(specSourceOf({ ...os, trailers: { 'OS-Request-Id': 'r', 'OS-Surface': 'mcp:push_app_files' } }), 'mcp');
  assert.equal(specSourceOf({ ...os, trailers: { 'OS-Request-Id': 'r' } }), 'ui');
  assert.equal(specSourceOf({ ...os, trailers: { 'OS-Source': 'ui' } }), 'git', 'no request id: not an OS commit');
  assert.equal(specSourceOf({ committer: { name: 'Dev', email: 'dev@x' }, trailers: { 'OS-Request-Id': 'r', 'OS-Source': 'ui' } }), 'git');
  assert.equal(specSourceOf({ ...os, trailers: { 'OS-Request-Id': 'r', 'OS-Source': 'bogus' } }), 'ui');
});

// --------------------------------------------------------------------- migration ---
const legacyEpics = [
  {
    id: 'epic_1',
    title: 'Ticket triage',
    description: 'Sort tickets.\n## Not a heading',
    requirements: { technical: 'fast', ux: '', governance: '' },
    stories: [
      { id: 'story_1', title: 'Auto-label', asA: 'agent', iWant: 'tickets **labelled**\non arrival', soThat: 'I triage faster', acceptance: 'Labels within 1s', status: 'done' as const, spec: { features: ['Label on arrival'], nfrs: ['<200ms'], rules: [] } },
      { id: 'story_2', title: '', asA: '', iWant: '', soThat: '', acceptance: '' },
    ],
  },
  { id: 'epic_2', title: 'Reporting', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [{ id: 'story_3', title: 'Weekly report', asA: 'lead', iWant: 'a report', soThat: 'I plan', acceptance: '' }] },
];

test('migration: record epics become files in ONE commit (OS-Source: migration), drafts with zero criteria; idempotent', async () => {
  const app = await v2('Legacy Migrate');
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = legacyEpics;
  await persistApp(rec!);
  const before = (await headOf(app.domain)).sha;
  const r = await migrateEpicsToFiles(app.id, alice);
  assert.deepEqual({ ...r, sha: undefined }, { migrated: true, sha: undefined, epics: 2, stories: 3 });
  const head = await headOf(app.domain);
  assert.equal(head.parents[0], before, 'exactly one commit');
  assert.equal(head.trailers['OS-Source'], 'migration');
  const { spec, issues } = await store.readSpec(app.id, alice);
  assert.deepEqual(issues, []);
  assert.deepEqual(spec.epics.map((e) => e.id), ['EP-1', 'EP-2']);
  assert.deepEqual(spec.stories.map((s) => [s.id, s.epic, s.state, s.criteria.length]), [['US-1', 'EP-1', 'draft', 0], ['US-2', 'EP-1', 'draft', 0], ['US-3', 'EP-2', 'draft', 0]]);
  assert.equal(spec.stories[0].iWant, 'tickets labelled on arrival');
  assert.match(spec.stories[0].notes, /Labels within 1s/);
  assert.match(spec.stories[0].notes, /- Label on arrival/);
  assert.match(spec.stories[0].notes, /story story_1/);
  assert.equal(spec.stories[1].title, 'Untitled story');
  assert.match(spec.epics[0].description, /#### Not a heading/);
  assert.deepEqual((await getAppByIdInternal(app.id))!.epics, legacyEpics, 'the record keeps its epics, untouched');
  const again = await migrateEpicsToFiles(app.id, alice);
  assert.equal(again.migrated, false);
  assert.equal((await headOf(app.domain)).sha, head.sha);
  // Even after every story file is deleted, the migration does not run again.
  await store.commitSpecChange(app.id, alice, { writes: [], deletes: spec.stories.map((s) => s.path).concat(spec.epics.map((e) => e.path)), summary: 'clear' }, { source: 'ui', message: 'clear' });
  assert.deepEqual(await migrateEpicsToFiles(app.id, alice), { migrated: false, reason: 'already-migrated' });
});

test('migration: nothing to migrate is a no-op; NEGATIVE a non-editor cannot migrate', async () => {
  const app = await v2('Empty Migrate');
  assert.deepEqual(await migrateEpicsToFiles(app.id, alice), { migrated: false, reason: 'nothing-to-migrate' });
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = legacyEpics;
  rec!.visibility = 'Shared';
  await persistApp(rec!);
  await assert.rejects(migrateEpicsToFiles(app.id, bob), (e: Error & { status?: number }) => e.status === 403);
  assert.equal(legacyEpicsToFiles(legacyEpics).files.length, 5);
});

test('storiesView: status from the file state, light untested until B records one, legacy epic count, canEdit', async () => {
  const app = await v2('View Desk');
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = legacyEpics;
  await persistApp(rec!);
  const first = await store.storiesView(app.id, alice);
  assert.equal(first.legacyEpics, 2);
  assert.equal(first.canEdit, true);
  await migrateEpicsToFiles(app.id, alice);
  const fresh = await getAppByIdInternal(app.id);
  fresh!.stories = { ...fresh!.stories!, lights: { 'US-1': 'green' } };
  await persistApp(fresh!);
  const v = await store.storiesView(app.id, alice);
  assert.equal(v.legacyEpics, 0);
  assert.deepEqual(v.stories.map((s) => [s.id, s.status, s.light]), [['US-1', 'draft', 'green'], ['US-2', 'draft', 'untested'], ['US-3', 'draft', 'untested']]);
  const old = await store.storiesView(app.id, alice, (await gs.log(app.domain, { reposDir, limit: 3 }))[1].sha);
  assert.equal(old.epics.length, 0, 'the spec at the commit before the migration is empty');
  await assert.rejects(store.storiesView(app.id, alice, 'HEAD~1'), (e: Error & { status?: number }) => e.status === 400);
});

test('same slug in two domains: two apps, two living specs in two repositories', async () => {
  const sales = await v2('Twin Desk', alice);
  const hrUser = user('hanna', ['hr']);
  const hr = await v2('Twin Desk', hrUser);
  assert.equal(sales.slug, hr.slug);
  assert.notEqual(sales.domain, hr.domain);
  await store.saveEpic(sales.id, alice, epicIn('Sales epic'), { source: 'ui' });
  await store.saveEpic(hr.id, hrUser, epicIn('HR epic'), { source: 'ui' });
  assert.deepEqual((await store.readSpec(sales.id, alice)).spec.epics.map((e) => e.title), ['Sales epic']);
  assert.deepEqual((await store.readSpec(hr.id, hrUser)).spec.epics.map((e) => e.title), ['HR epic']);
});
