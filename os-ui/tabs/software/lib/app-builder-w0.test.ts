/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the switch, the extension points and template versioning
 * USER STORY: As the owner I want merged App Builder code to change nothing while its switch is off (every new tool
 *             answers app_builder_disabled, `nextjs-web@2` cannot be created, golden-path apps keep today's paths),
 *             and every extension point a workstream relies on to behave as the plan says.
 * ARCHITECTURE: Real principals through `callPlatformMcp` and `createApp` (offline store, temp repos dir), the hook
 *             registries, the MCP dispatch, the receive path with a fake tree reader. The flag is the env variable
 *             config reads on every access. Every "on" case has its "off" twin.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool } from '@core/mcp/server';
import { structuredError } from '@core/mcp/server';
import { appBuilderGuard, appBuilderDisabledResponse, assertAppBuilderEnabled, APP_BUILDER_DISABLED } from '@core/kernel/app-builder-flag';
import type { Pusher } from '@core/infra/git-receive';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { callPlatformMcp } = await import('./platform-mcp.ts');
const { createApp, persistApp, listAppsForUser } = await import('./apps.ts');
const gp = await import('./golden-path.ts');
const { gatePolicyFor } = await import('./gate-policy.ts');
const { registerPreDeployHook, runPreDeployHooks, __resetPreDeployHooks } = await import('./pre-deploy-hooks.ts');
const { registerReceiveHook, runReceiveHooks, onlyStoriesChanged, __resetReceiveHooks } = await import('./receive-hooks.ts');
const { ingestApps } = await import('./app-receive.ts');
const { appDeployFiles } = await import('./native-deploy.ts');
const ab = await import('../mcp/app-builder/index.ts');
const { softwareWriteTools } = await import('../mcp/software-write-tools.ts');
const { usesAppBuilder } = await import('../ui/app-builder/routing.ts');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-ab-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});
const flag = (on: boolean) => { process.env.SOFTWARE_APP_BUILDER = on ? 'on' : 'off'; };
afterEach(() => { delete process.env.SOFTWARE_APP_BUILDER; __resetPreDeployHooks(); __resetReceiveHooks(); });

const alice: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };
const disabled = (e: unknown) => (e as { code?: string }).code === APP_BUILDER_DISABLED;
const ROOT = join(process.cwd(), '..');

// ---------------------------------------------------------------- the switch ----
test('the switch: only the exact string "on" enables it; absent, "off" or a typo is off', () => {
  delete process.env.SOFTWARE_APP_BUILDER;
  assert.equal(cfg.appBuilderEnabled, false);
  for (const v of ['off', 'true', 'ON', '1', 'yes']) { process.env.SOFTWARE_APP_BUILDER = v; assert.equal(cfg.appBuilderEnabled, false, v); }
  flag(true);
  assert.equal(cfg.appBuilderEnabled, true);
});

test('the guard: off ⇒ typed refusal (403 app_builder_disabled, mapped by the MCP dispatcher); on ⇒ null', async () => {
  flag(false);
  assert.equal(appBuilderGuard()?.code, APP_BUILDER_DISABLED);
  assert.throws(() => assertAppBuilderEnabled(), (e: Error & { status?: number }) => disabled(e) && e.status === 403);
  try { assertAppBuilderEnabled(); } catch (e) { assert.equal(structuredError(e).code, APP_BUILDER_DISABLED); assert.match(structuredError(e).hint, /softwareRunner\.environments\.enabled/); }
  const res = appBuilderDisabledResponse()!;
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, APP_BUILDER_DISABLED);
  flag(true);
  assert.equal(appBuilderGuard(), null);
  assert.equal(appBuilderDisabledResponse(), null);
});

// ------------------------------------------------------------ MCP extension point ----
test('a new App Builder tool answers app_builder_disabled while off and never runs its body; on, it runs', async () => {
  let ran = 0;
  const tool: McpTool = { name: 'x_tool', description: 'x', minRole: 'creator', tab: 'software', inputSchema: { type: 'object' }, call: async () => { ran += 1; return 'ok'; } };
  const guarded = ab.guardAppBuilderTool(tool);
  flag(false);
  await assert.rejects(guarded.call(alice, {}), disabled);
  assert.equal(ran, 0);
  flag(true);
  assert.equal(await guarded.call(alice, {}), 'ok');
});

test('W0 registers no new tool: softwareWriteTools is today\'s list, and a name registered twice is a load error', () => {
  assert.deepEqual(ab.appBuilderTools, []);
  assert.deepEqual(Object.keys(ab.appBuilderHandlers), []);
  assert.deepEqual(softwareWriteTools.map((t) => t.name), ['set_app_design']);
  assert.throws(() => ab.mergeUnique('tool', { a: { get_stories: 1 }, b: { get_stories: 2 } }), /registered by both a and b/);
});

test('routeToAppBuilder: off ⇒ null without reading the app; on ⇒ only a v2 app with a handler is routed', async () => {
  const v1 = await createApp(alice, { name: 'Route V1', template: 'nextjs-web' });
  let called = 0;
  const handlers = { build_software: async () => { called += 1; return { routed: true }; } };
  flag(false);
  assert.equal(await ab.routeToAppBuilder('build_software', alice, { appId: 'no-such-app' }, handlers), null, 'off: not even the lookup runs');
  flag(true);
  const v2 = await createApp(alice, { name: 'Route V2', template: 'nextjs-web', templateVersion: 2 });
  assert.equal(await ab.routeToAppBuilder('build_software', alice, { appId: v1.id }, handlers), null, 'v1 app: today\'s code');
  assert.equal(await ab.routeToAppBuilder('verify_software', alice, { appId: v2.id }, handlers), null, 'no handler: today\'s code');
  assert.deepEqual(await ab.routeToAppBuilder('build_software', alice, { appId: v2.id }, handlers), { result: { routed: true } });
  assert.equal(called, 1);
  flag(false);
  assert.equal(await ab.routeToAppBuilder('build_software', alice, { appId: v2.id }, handlers), null, 'off again: even a v2 app takes today\'s path');
  assert.equal(called, 1);
});

// ------------------------------------------------------------ template versions ----
test('flag OFF: nextjs-web@2 cannot be created from any door, and nothing is written', async () => {
  flag(false);
  const before = (await listAppsForUser(alice)).length;
  await assert.rejects(createApp(alice, { name: 'Nope', template: 'nextjs-web', templateVersion: 2 }), disabled);
  await assert.rejects(callPlatformMcp(alice, 'create_software', { name: 'Nope MCP', template: 'nextjs-web@2', kind: 'code' }), disabled);
  assert.equal((await listAppsForUser(alice)).length, before);
  await assert.rejects(createApp(alice, { name: 'Nope2', template: 'sovereign-app', templateVersion: 2 }), (e: Error & { status?: number }) => e.status === 400);
});

test('flag OFF: a v1 golden-path app is created exactly as before (no templateVersion field, v1 tree)', async () => {
  flag(false);
  const app = await createApp(alice, { name: 'Plain V1', template: 'nextjs-web' });
  assert.equal('templateVersion' in app, false);
  assert.ok(!app.repo.seeded.includes('docs/rules/identity.md'));
  assert.equal(gp.selectableTemplateVersions('nextjs-web', false).join(), '1');
});

test('flag ON: create_software with nextjs-web@2 stores templateVersion 2 and seeds the v2 tree', async () => {
  flag(true);
  const app = (await callPlatformMcp(alice, 'create_software', { name: 'Builder App', template: 'nextjs-web@2', kind: 'code' })) as { templateVersion?: number; template: string; repo: { seeded: string[] } };
  assert.equal(app.template, 'nextjs-web');
  assert.equal(app.templateVersion, 2);
  for (const f of ['docs/rules/identity.md', 'docs/rules/own-database.md', 'docs/rules/stories-and-tests.md']) assert.ok(app.repo.seeded.includes(f), f);
  assert.deepEqual(gp.selectableTemplateVersions('nextjs-web', true), [1, 2]);
});

test('get_app_template: off ⇒ today\'s answer (nextjs-web only, @2 unknown); on ⇒ nextjs-web@2 listed and readable', async () => {
  flag(false);
  const off = (await callPlatformMcp(alice, 'get_app_template', {})) as { templates: { key: string }[] };
  assert.deepEqual(off.templates.map((t) => t.key), ['nextjs-web']);
  await assert.rejects(callPlatformMcp(alice, 'get_app_template', { template: 'nextjs-web@2' }), (e: Error & { status?: number }) => e.status === 404);
  flag(true);
  const on = (await callPlatformMcp(alice, 'get_app_template', {})) as { templates: { key: string }[] };
  assert.deepEqual(on.templates.map((t) => t.key), ['nextjs-web', 'nextjs-web@2']);
  const v2 = (await callPlatformMcp(alice, 'get_app_template', { template: 'nextjs-web@2' })) as { template: string; rules: { agents: string } };
  assert.equal(v2.template, 'nextjs-web@2');
  assert.match(v2.rules.agents, /docs\/rules\/identity\.md/);
});

test('template refs, dirs and the v1 tree are unchanged; v2 is a copy whose AGENTS.md is an index', () => {
  assert.deepEqual(gp.parseTemplateRef('nextjs-web'), { key: 'nextjs-web', version: 1 });
  assert.deepEqual(gp.parseTemplateRef('nextjs-web@2'), { key: 'nextjs-web', version: 2 });
  assert.equal(gp.parseTemplateRef('nextjs-web@3'), null);
  assert.equal(gp.parseTemplateRef('sovereign-app@2'), null);
  assert.equal(gp.templateDirOf('nextjs-web', 2), 'nextjs-web-v2');
  assert.deepEqual(gp.readTemplate('nextjs-web', 1), gp.readTemplate('nextjs-web'), 'the default is v1');
  const v1 = new Map(gp.readTemplate('nextjs-web').map((f) => [f.path, f.content]));
  const v2 = new Map(gp.readTemplate('nextjs-web', 2).map((f) => [f.path, f.content]));
  for (const p of v1.keys()) assert.ok(v2.has(p), `v2 keeps ${p}`);
  const changed = [...v1.keys()].filter((p) => v1.get(p) !== v2.get(p)).sort();
  assert.deepEqual(changed, ['AGENTS.md', 'README.md', 'app.yaml'], 'v2 differs from v1 only where W0 says');
  const agents = v2.get('AGENTS.md')!;
  assert.doesNotMatch(agents, /Never connect to Trino, OpenSearch, MinIO, Postgres/, 'the "never a datastore client" rule moved to a page');
  assert.match(agents, /docs\/rules\/own-database\.md/);
  assert.match(agents, /docs\/rules\/stories-and-tests\.md/);
  // the chart's gate files per version equal that version's template copies
  for (const [v, dir] of [['v1', 'nextjs-web'], ['v2', 'nextjs-web-v2']]) {
    assert.equal(readFileSync(join(ROOT, 'charts/sovereign-agentic-os/files/tekton/platform', v, 'factory-gates.mjs'), 'utf8'), readFileSync(join(ROOT, 'templates', dir, 'scripts/factory-gates.mjs'), 'utf8'));
    assert.equal(readFileSync(join(ROOT, 'charts/sovereign-agentic-os/files/tekton/platform', v, 'app-rules.rego'), 'utf8'), readFileSync(join(ROOT, 'templates', dir, 'policy/app-rules.rego'), 'utf8'));
  }
  assert.deepEqual(gp.gateFilesOf('nextjs-web', 1), gp.gateFilesOf('nextjs-web'));
});

test('platform-owned paths and the gate policy follow the STORED template version; v1 is unchanged', () => {
  assert.deepEqual([...gp.platformOwnedOf(1)], [...gp.PLATFORM_OWNED]);
  for (const p of gp.platformOwnedOf(1)) assert.ok(gp.platformOwnedOf(2).includes(p), `v2 keeps ${p}`);
  assert.equal(gp.isPlatformOwnedPath('Dockerfile', 2), true);
  assert.equal(gp.isPlatformOwnedPath('src/app/page.tsx', 2), false);
  assert.equal(gatePolicyFor({ template: 'nextjs-web', serveMode: 'image' }).version, 1);
  assert.equal(gatePolicyFor({ template: 'nextjs-web', serveMode: 'image', templateVersion: 2 }).version, 2);
  assert.equal(gatePolicyFor({ template: 'vite-os', serveMode: 'image', templateVersion: 2 }).version, 1, 'a legacy template is always v1');
});

test('deploy files: the v2 env block is keyed on domain and slug and empty in W0, so every manifest is unchanged', () => {
  const base = { slug: 'orders', host: 'orders.sales.apps.local', registry: 'reg.example/apps' };
  const plain = appDeployFiles(base);
  assert.deepEqual(appDeployFiles({ ...base, domain: 'sales' }), plain);
  assert.deepEqual(appDeployFiles({ ...base, domain: 'sales', templateVersion: 2 }), plain);
});

// ---------------------------------------------------------------- hook registries ----
test('pre-deploy hooks: none ⇒ ok/[]; in order; the first refusal stops the run, named; a throw is a refusal', async () => {
  const i = { slug: 's', domain: 'd', env: 'dev' as const, namespace: 'apps-dev', image: 'reg/apps/d/s@sha256:x', sha: 'a'.repeat(40) };
  assert.deepEqual(await runPreDeployHooks(i), { ok: true, applied: [] });
  const seen: string[] = [];
  registerPreDeployHook('one', async () => { seen.push('one'); return { ok: true, applied: ['0001_init.sql'] }; });
  registerPreDeployHook('two', async () => { seen.push('two'); return { ok: true, applied: ['0002_more.sql'] }; });
  assert.deepEqual(await runPreDeployHooks(i), { ok: true, applied: ['0001_init.sql', '0002_more.sql'] });
  registerPreDeployHook('one', async () => { seen.push('one-b'); return { ok: false, reason: 'migration failed' }; });
  assert.deepEqual(await runPreDeployHooks(i), { ok: false, reason: 'one: migration failed' });
  assert.deepEqual(seen.slice(-1), ['one-b'], 're-registering keeps the position; later hooks do not run');
  __resetPreDeployHooks();
  registerPreDeployHook('boom', async () => { throw new Error('no cluster'); });
  assert.deepEqual(await runPreDeployHooks(i), { ok: false, reason: 'boom: no cluster' });
  assert.throws(() => registerPreDeployHook(' ', async () => ({ ok: true, applied: [] })), /needs a name/);
});

test('receive hooks: notes concatenated in order, a throw becomes a note naming the hook; onlyStoriesChanged', async () => {
  const app = { slug: 'orders' } as never;
  registerReceiveHook('index', async () => ['stories re-indexed']);
  registerReceiveHook('bad', async () => { throw new Error('parse'); });
  registerReceiveHook('posthoc', async (x) => [`${x.messages.length} message(s)`]);
  assert.deepEqual(await runReceiveHooks({ app, changed: [], sha: 'a', pusher: { id: 'p', role: 'builder', domains: ['d'] }, messages: ['m'] }), ['stories re-indexed', 'receive hook bad failed for orders: parse', '1 message(s)']);
  assert.equal(onlyStoriesChanged([]), false);
  assert.equal(onlyStoriesChanged([{ path: 'stories/EP-1-x/US-1-y.md' }, { path: 'apps/orders/stories/EP-1-x/_epic.md' }]), true);
  assert.equal(onlyStoriesChanged([{ path: 'apps/orders/stories/a.md' }, { path: 'apps/orders/src/app/page.tsx' }]), false);
  assert.equal(onlyStoriesChanged([{ path: 'apps/orders/storiesX/a.md' }]), false);
});

test('a push runs the receive hooks ONLY with the flag on, with the app\'s changed files and the commit messages', async () => {
  const dev: CurrentUser = { id: 'dan', name: 'Dan', domains: ['eng'], allDomains: ['eng'], activeDomain: null, role: 'builder' };
  const pusher: Pusher = { id: 'dan', name: 'Dan', role: 'builder', domains: ['eng'] };
  const app = await createApp(dev, { name: 'Hooked', template: 'sovereign-app' });
  await persistApp(app);
  const calls: { slug: string; changed: string[]; messages: string[] }[] = [];
  registerReceiveHook('spy', async (x) => { calls.push({ slug: x.app.slug, changed: x.changed.map((f) => f.path), messages: x.messages }); return ['spy ran']; });
  const yaml = 'name: X\nsurface: api\ndeclares:\n  connections: []\n  data: []\n  knowledge: []\n';
  const files = [{ path: `apps/${app.slug}/app.yaml`, status: 'modified' as const, content: yaml }];
  const deps = { readTree: async () => [{ path: 'app.yaml', content: yaml }], readMessages: async () => ['feat: x\n\nStory: US-1'] };
  flag(false);
  const off = await ingestApps({ domain: 'eng', files, pusher, sha: 'b'.repeat(40) }, deps);
  assert.equal(calls.length, 0);
  assert.ok(!off.notes.includes('spy ran'));
  flag(true);
  const on = await ingestApps({ domain: 'eng', files, pusher, sha: 'b'.repeat(40) }, deps);
  assert.deepEqual(calls, [{ slug: app.slug, changed: [`apps/${app.slug}/app.yaml`], messages: ['feat: x\n\nStory: US-1'] }]);
  assert.ok(on.notes.includes('spy ran'));
});

test('UI routing: the App Builder shell only for a v2 app AND the flag on; every other case is today\'s builder', () => {
  assert.equal(usesAppBuilder({ templateVersion: 2 }, true), true);
  assert.equal(usesAppBuilder({ templateVersion: 2 }, false), false, 'flag off: a v2 app keeps today\'s UI');
  assert.equal(usesAppBuilder({ templateVersion: 2 }, undefined), false, 'flag off: the API sends no appBuilder field');
  assert.equal(usesAppBuilder({}, true), false, 'a v1 app keeps today\'s UI with the flag on');
  assert.equal(usesAppBuilder({ templateVersion: 1 }, true), false);
});
