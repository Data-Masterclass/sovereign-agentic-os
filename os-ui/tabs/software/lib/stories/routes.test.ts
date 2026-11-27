/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the Stories routes and MCP tools: read, save, migrate, history; refusals
 * USER STORY: As a business user I want the Stories view's saves to be governed commits, and as the owner I want every
 *             one of these doors to answer app_builder_disabled while the switch is off.
 * ARCHITECTURE: The real route modules with the session and OPA stood in (auth and the OPA decision are separate
 *             components with their own tests), real createApp into a temp repos dir. The MCP twins go through the W0
 *             dispatch (`appBuilderTools`, `routeToAppBuilder`) exactly as an MCP client reaches them. Negative twins:
 *             flag off, unauthenticated, another domain, OPA deny, a non-editor, a bad body, a too-large body.
 */
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';

let ACTING: { id: string; name: string; domains: string[]; allDomains: string[]; activeDomain: null; role: string } | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) throw Object.assign(new Error('Not authenticated'), { status: 401 });
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});
let OPA_ALLOWS = true;
const asked: { principal: string; tool: string }[] = [];
mock.module('@core/infra/governed', {
  namedExports: {
    authorize: async (principal: string, tool: string) => {
      asked.push({ principal, tool });
      return { allowed: OPA_ALLOWS, policy: OPA_ALLOWS ? 'opa-allow' : 'opa-deny' };
    },
  },
});

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { createApp, getAppByIdInternal, persistApp } = await import('../apps.ts');
const { appBuilderTools, routeToAppBuilder } = await import('../../mcp/app-builder/index.ts');
const gs = await import('@core/infra/git-store');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-stories-rt-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const mk = (id: string, domains: string[], role = 'creator') => ({ id, name: id[0].toUpperCase() + id.slice(1), domains, allDomains: domains, activeDomain: null, role });
const alice = mk('alice', ['sales']);
const bob = mk('bob', ['sales']);
const mallory = mk('mallory', ['hr']);
beforeEach(() => {
  ACTING = alice;
  OPA_ALLOWS = true;
  asked.length = 0;
  process.env.SOFTWARE_APP_BUILDER = 'on';
});
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; });

const stories = () => import(`../../../../app/api/apps/[id]/stories/route.ts?${Math.random()}`);
const history = () => import(`../../../../app/api/apps/[id]/stories/[sid]/history/route.ts?${Math.random()}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = async (id: string, qs = '') => (await stories()).GET(new Request(`http://x/api/apps/${id}/stories${qs}`), ctx(id));
const put = async (id: string, body: unknown) =>
  (await stories()).PUT(new Request(`http://x/api/apps/${id}/stories`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx(id));
const hist = async (id: string, sid: string) => (await history()).GET(new Request(`http://x/api/apps/${id}/stories/${sid}/history`), { params: Promise.resolve({ id, sid }) });

const v2 = () => createApp(alice as never, { name: `Route Desk ${Math.random().toString(36).slice(2, 6)}`, template: 'nextjs-web', templateVersion: 2 });
const epicBody = { op: 'saveEpic', epic: { title: 'Orders', description: '', requirements: {} } };
const storyBody = (extra: Record<string, unknown> = {}) => ({
  op: 'saveStory',
  story: { epic: 'EP-1', title: 'Submit', asA: 'rep', iWant: 'to submit', soThat: 'it ships', criteria: [{ title: 'ok', given: ['g'], when: ['w'], then: ['t'] }], ...extra },
});

test('GET → save epic → save story → GET → history: a commit per save with OS-Source ui, OPA asked first', async () => {
  const app = await v2();
  const empty = await get(app.id);
  assert.equal(empty.status, 200);
  const e = (await empty.json()) as { epics: unknown[]; canEdit: boolean; legacyEpics: number };
  assert.deepEqual([e.epics.length, e.canEdit, e.legacyEpics], [0, true, 0]);
  assert.equal((await put(app.id, epicBody)).status, 200);
  const s = await put(app.id, storyBody());
  assert.equal(s.status, 200);
  const saved = (await s.json()) as { sha: string; story: { id: string } };
  assert.equal(saved.story.id, 'US-1');
  assert.deepEqual(asked, [{ principal: 'user:alice', tool: 'software_checks' }, { principal: 'user:alice', tool: 'software_checks' }]);
  const head = (await gs.log(app.domain, { reposDir, limit: 1 }))[0];
  assert.equal(head.sha, saved.sha);
  assert.equal(head.trailers['OS-Source'], 'ui');
  assert.equal(head.author.name, 'Alice');
  assert.match(head.trailers['OS-Surface'] ?? '', /^ui:/);
  const view = (await (await get(app.id)).json()) as { stories: { id: string; status: string; light: string }[]; sha: string };
  assert.deepEqual(view.stories.map((x) => [x.id, x.status, x.light]), [['US-1', 'draft', 'untested']]);
  assert.equal(view.sha, saved.sha);
  const h = await hist(app.id, 'US-1');
  assert.equal(h.status, 200);
  const versions = ((await h.json()) as { versions: { source: string; author: { name: string } }[] }).versions;
  assert.deepEqual(versions.map((v) => [v.source, v.author.name]), [['ui', 'Alice']]);
});

test('PUT migrate: record epics become files once; the view then shows them', async () => {
  const app = await v2();
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = [{ id: 'e1', title: 'Old epic', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [{ id: 's1', title: 'Old story', asA: 'a', iWant: 'b', soThat: 'c', acceptance: 'free text' }] }];
  await persistApp(rec!);
  assert.equal(((await (await get(app.id)).json()) as { legacyEpics: number }).legacyEpics, 1);
  const m = (await (await put(app.id, { op: 'migrate' })).json()) as { migrated: boolean; stories: number };
  assert.deepEqual([m.migrated, m.stories], [true, 1]);
  const again = (await (await put(app.id, { op: 'migrate' })).json()) as { migrated: boolean };
  assert.equal(again.migrated, false);
  const view = (await (await get(app.id)).json()) as { stories: { title: string; notes: string }[]; legacyEpics: number };
  assert.equal(view.legacyEpics, 0);
  assert.equal(view.stories[0].title, 'Old story');
});

test('NEGATIVE a save that breaks the spec is 422 with issues; a bad op 400; bad JSON 400; a body over 64 KB 413', async () => {
  const app = await v2();
  await put(app.id, epicBody);
  const r = await put(app.id, storyBody({ title: '', criteria: [{ title: 'x', given: [], when: ['w'], then: ['t'] }] }));
  assert.equal(r.status, 422);
  const body = (await r.json()) as { code: string; issues: { reason: string; fix: string }[] };
  assert.equal(body.code, 'spec_invalid');
  assert.ok(body.issues.some((i) => /title is empty/.test(i.reason)));
  assert.ok(body.issues.some((i) => /no Given line/.test(i.reason)));
  assert.equal((await put(app.id, { op: 'delete' })).status, 400);
  assert.equal((await put(app.id, '{not json')).status, 400);
  assert.equal((await put(app.id, { op: 'saveStory', story: { epic: 'EP-1', title: 'x', notes: 'y'.repeat(70 * 1024) } })).status, 413);
  assert.equal((await get(app.id, '?sha=main')).status, 400);
});

test('NEGATIVE OPA deny: 403 and no commit', async () => {
  const app = await v2();
  const before = (await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha;
  OPA_ALLOWS = false;
  const r = await put(app.id, epicBody);
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /OPA refused/);
  assert.equal((await gs.log(app.domain, { reposDir, limit: 1 }))[0].sha, before);
});

test('NEGATIVE unauthenticated 401, another domain 404, a colleague who cannot edit 403', async () => {
  const app = await v2();
  ACTING = null;
  assert.equal((await get(app.id)).status, 401);
  assert.equal((await put(app.id, epicBody)).status, 401);
  ACTING = mallory;
  assert.equal((await get(app.id)).status, 404);
  assert.equal((await put(app.id, epicBody)).status, 404);
  assert.equal((await hist(app.id, 'US-1')).status, 404);
  const rec = await getAppByIdInternal(app.id);
  rec!.visibility = 'Shared';
  await persistApp(rec!);
  ACTING = bob;
  const view = (await (await get(app.id)).json()) as { canEdit: boolean };
  assert.equal(view.canEdit, false);
  assert.equal((await put(app.id, epicBody)).status, 403);
});

test('NEGATIVE flag off: every route answers 403 app_builder_disabled before the session or any read', async () => {
  const app = await v2();
  delete process.env.SOFTWARE_APP_BUILDER;
  ACTING = null; // the guard runs before the session gate
  for (const res of [await get(app.id), await put(app.id, epicBody), await hist(app.id, 'US-1')]) {
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'app_builder_disabled');
  }
  assert.equal(asked.length, 0);
});

// ------------------------------------------------------------------- MCP twins ---
const tool = (name: string) => appBuilderTools.find((t) => t.name === name)!;

test('MCP get_stories / get_story_history: the same payload as the UI; flag off ⇒ app_builder_disabled', async () => {
  const app = await v2();
  await put(app.id, epicBody);
  await put(app.id, storyBody());
  const s = (await tool('get_stories').call(alice as never, { appId: app.id })) as { stories: { id: string; criteria: unknown[] }[] };
  assert.deepEqual(s.stories.map((x) => x.id), ['US-1']);
  const h = (await tool('get_story_history').call(alice as never, { appId: app.id, id: 'US-1' })) as { versions: { source: string }[] };
  assert.equal(h.versions[0].source, 'ui');
  await assert.rejects(tool('get_stories').call(mallory as never, { appId: app.id }), (e: Error & { status?: number }) => e.status === 404);
  delete process.env.SOFTWARE_APP_BUILDER;
  await assert.rejects(tool('get_stories').call(alice as never, { appId: app.id }), (e: Error & { code?: string }) => e.code === 'app_builder_disabled');
  await assert.rejects(tool('get_story_history').call(alice as never, { appId: app.id, id: 'US-1' }), (e: Error & { code?: string }) => e.code === 'app_builder_disabled');
});

test('MCP design_software on a v2 app writes story files (OS-Source mcp) after migrating once; v1 and flag off keep today\'s path', async () => {
  const app = await v2();
  const rec = await getAppByIdInternal(app.id);
  rec!.epics = [{ id: 'e1', title: 'Old epic', description: '', requirements: { technical: '', ux: '', governance: '' }, stories: [{ id: 's1', title: 'Old story', asA: 'a', iWant: 'b', soThat: 'c', acceptance: '' }] }];
  await persistApp(rec!);
  const routed = await routeToAppBuilder('design_software', alice as never, {
    appId: app.id,
    purpose: 'Take orders',
    epics: [
      { title: 'Old epic', stories: [{ title: 'Old story', state: 'agreed', criteria: [{ title: 'c1', given: ['g'], when: ['w'], then: ['t'] }] }] },
      { title: 'New epic', stories: [{ title: 'Fresh', asA: 'rep', iWant: 'x', soThat: 'y', status: 'done' }] },
    ],
  });
  assert.ok(routed);
  const r = routed.result as { livingSpec: boolean; migration: { migrated: boolean }; touched: { epics: string[]; stories: string[] }; stories: { id: string; state: string; criteria: { id: string }[] }[] };
  assert.equal(r.livingSpec, true);
  assert.equal(r.migration.migrated, true);
  assert.deepEqual(r.touched, { epics: ['EP-1', 'EP-2'], stories: ['US-1', 'US-2'] });
  assert.deepEqual(r.stories.map((s) => [s.id, s.state, s.criteria.map((c) => c.id).join()]), [['US-1', 'agreed', 'AC-1'], ['US-2', 'draft', '']]);
  const head = (await gs.log(app.domain, { reposDir, limit: 2 }));
  assert.equal(head[0].trailers['OS-Source'], 'mcp');
  assert.equal(head[1].trailers['OS-Source'], 'migration');
  assert.equal((await getAppByIdInternal(app.id))!.purpose, 'Take orders');
  OPA_ALLOWS = false;
  await assert.rejects(routeToAppBuilder('design_software', alice as never, { appId: app.id, epics: [] }), (e: Error & { status?: number }) => e.status === 403);
  OPA_ALLOWS = true;
  const v1 = await createApp(alice as never, { name: 'Classic Route', template: 'nextjs-web' });
  assert.equal(await routeToAppBuilder('design_software', alice as never, { appId: v1.id, epics: [] }), null);
  delete process.env.SOFTWARE_APP_BUILDER;
  assert.equal(await routeToAppBuilder('design_software', alice as never, { appId: app.id, epics: [] }), null);
});
