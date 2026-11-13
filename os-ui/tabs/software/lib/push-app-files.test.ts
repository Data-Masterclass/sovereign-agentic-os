/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `push_app_files` — one verb, one service, two doors (night-2 S6)
 * USER STORY: As an engineer coding in Claude I want one call that commits my files, tells me the
 *             sha, says `changed:false` when nothing changed, and refuses BEFORE writing when the
 *             tree does not compile.
 * ARCHITECTURE:
 *   - Runs the REAL service over the real app store (offline: every OpenSearch call fails fast, so
 *     the store is in-memory) and a REAL git repo in a temp dir.
 *   - MCP/UI PARITY is asserted structurally: both doors call `pushAppFiles`, so the test drives
 *     the MCP tool and the service and compares the commits — they differ only in `OS-Surface`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';

const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp } = await import('./apps.ts');
const { pushAppFiles, previewLocation } = await import('./push-app-files.ts');
const { callPlatformMcp, platformMcpToolNames } = await import('./platform-mcp.ts');
const { log } = await import('@core/infra/git-store');
const { __setAppProjectGitForTests } = await import('./git-commit.ts');
const { config } = await import('@core/kernel/config');

let reposDir = '';
let priorReposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-push-'));
  // The service calls `commitSubtree` with `config.reposDir`, so point the config at the temp dir
  // (the same seam `tabs/data`'s commit tests use).
  priorReposDir = config.reposDir;
  (config as { reposDir: string }).reposDir = reposDir;
  __setAppProjectGitForTests(true);
});
after(() => {
  __setAppProjectGitForTests(null);
  (config as { reposDir: string }).reposDir = priorReposDir;
  globalThis.fetch = _realFetch;
  rmSync(reposDir, { recursive: true, force: true });
});

const dev: CurrentUser = testUser({ id: 'dan', name: 'Dan', domains: ['eng'], role: 'builder' });
const outsider: CurrentUser = testUser({ id: 'zed', name: 'Zed', domains: ['sales'], role: 'builder' });

const FILES = [{ path: 'docs/notes.md', content: '# notes\n' }];

test('push_app_files is a registered MCP tool, and it is a WRITE', async () => {
  assert.ok(platformMcpToolNames().includes('push_app_files'));
  const { PLATFORM_MCP_TOOLS } = await import('./platform-mcp.ts');
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === 'push_app_files');
  assert.equal(tool?.write, true);
  assert.match(tool!.description, /apps\/<slug>\//, 'the description says WHERE the files land');
  assert.match(tool!.description, /ONE commit/, 'the description states the idempotence');
});

test('pushAppFiles: commits, returns the sha + gate, and the SAME files twice = ONE commit', async () => {
  const app = await createApp(dev, { name: 'Pusher', template: 'sovereign-app' });
  const first = await pushAppFiles({ appId: app.id, files: FILES, message: 'add notes', surface: 'mcp:push_app_files' }, dev);
  assert.equal(first.slug, app.slug);
  assert.match(String(first.commit), /^[0-9a-f]{40}$/, 'a real commit sha');
  assert.equal(first.changed, true);
  assert.equal(first.gate.gated !== undefined, true, 'the gate verdict is reported, whatever it is');
  assert.deepEqual(first.actionIssues, []);

  const head = (await log(app.domain, { reposDir, limit: 1 }))[0];
  // The PUSHER is the author. `CurrentUser` carries no e-mail, so the store synthesizes one and
  // SAYS it did (`OS-Author-Email: synthesized`) — never a silently invented address.
  assert.equal(head.author.name, 'Dan');
  assert.equal(head.author.email, 'dan@os.local');
  assert.equal(head.trailers['OS-Author-Email'], 'synthesized');
  assert.equal(head.trailers['OS-Actor'], 'dan');
  assert.equal(head.committer.name, 'Sovereign OS');
  assert.equal(head.trailers['OS-Surface'], 'mcp:push_app_files');
  assert.equal(head.trailers['OS-Object'], `app:${app.id} (Pusher)`);

  const again = await pushAppFiles({ appId: app.id, files: FILES, message: 'add notes', surface: 'mcp:push_app_files' }, dev);
  assert.equal(again.changed, false, 'identical bytes ⇒ no new commit');
  assert.equal(again.commit, first.commit, 'the same head comes back');
  assert.equal((await log(app.domain, { reposDir, limit: 20 })).length, 1, 'ONE commit for two identical pushes');
});

test('pushAppFiles: MCP and UI are the SAME service — the commits differ only in OS-Surface', async () => {
  const app = await createApp(dev, { name: 'Parity', template: 'sovereign-app' });
  const viaMcp = await callPlatformMcp(dev, 'push_app_files', {
    appId: app.id,
    files: [{ path: 'docs/a.md', content: 'a\n' }],
    message: 'same change',
  });
  const mcpHead = (await log(app.domain, { reposDir, limit: 1 }))[0];

  const app2 = await createApp(dev, { name: 'Parity Two', template: 'sovereign-app' });
  await pushAppFiles(
    { appId: app2.id, files: [{ path: 'docs/a.md', content: 'a\n' }], message: 'same change', surface: 'ui:software/files' },
    dev,
  );
  const uiHead = (await log(app2.domain, { reposDir, limit: 1 }))[0];

  assert.ok((viaMcp as { result?: unknown }).result ?? viaMcp, 'the MCP tool answered');
  assert.equal(mcpHead.trailers['OS-Surface'], 'mcp:push_app_files');
  assert.equal(uiHead.trailers['OS-Surface'], 'ui:software/files');
  assert.equal(mcpHead.trailers['OS-Action'], uiHead.trailers['OS-Action'], 'the same action');
  const strip = (s: string) => s.split('—')[0].trim();
  assert.equal(
    strip(mcpHead.subject).replace('parity', 'x').replace(app.slug, 'x'),
    strip(uiHead.subject).replace('parity-two', 'x').replace(app2.slug, 'x'),
    'the subjects are the same shape, differing only in the surface half',
  );
});

test('pushAppFiles: a RED compile gate is a 422 and commits NOTHING', async () => {
  const app = await createApp(dev, { name: 'Gated', template: 'sovereign-app' });
  const before = await log(app.domain, { reposDir, limit: 50 });
  await assert.rejects(
    () =>
      pushAppFiles(
        {
          appId: app.id,
          // A .tsx that cannot possibly compile against the vendored API.
          files: [{ path: 'src/epics/x/y/Page.tsx', content: 'import { Nope } from "@sovereign-os/ui";\nexport default function P(){ return <Nope oops={{{ }} /> }\n' }],
          message: 'broken',
          surface: 'mcp:push_app_files',
        },
        dev,
      ),
    (e: unknown) => (e as { status?: number }).status === 422,
    'a red gate is 422',
  );
  const after = await log(app.domain, { reposDir, limit: 50 });
  assert.equal(after.length, before.length, 'NOTHING was committed');
});

test('pushAppFiles: input and scope refusals are typed, before any write', async () => {
  const app = await createApp(dev, { name: 'Refusals', template: 'sovereign-app' });
  await assert.rejects(() => pushAppFiles({ appId: app.id, files: [] }, dev), (e: unknown) => (e as { status?: number }).status === 400);
  await assert.rejects(
    () => pushAppFiles({ appId: app.id, files: [{ path: '', content: 'x' }] }, dev),
    (e: unknown) => (e as { status?: number }).status === 400,
  );
  await assert.rejects(
    () => pushAppFiles({ appId: app.id, files: FILES }, outsider),
    (e: unknown) => [403, 404].includes((e as { status?: number }).status ?? 0),
    'someone who cannot edit the app cannot push to it',
  );
});

test('previewLocation: honest — a URL only where something is really served', () => {
  assert.deepEqual(previewLocation({ slug: 's', serveMode: 'runtime', spec: undefined, deploy: {} } as never), {
    url: '/apps/s',
    note: null,
  });
  const noSpec = previewLocation({ slug: 's', serveMode: 'spec', spec: undefined, deploy: {} } as never);
  assert.equal(noSpec.url, null);
  assert.match(String(noSpec.note), /no AppSpec tabs yet/);
  const img = previewLocation({ slug: 's', serveMode: 'image', spec: undefined, deploy: { previewUrl: null } } as never);
  assert.equal(img.url, null);
  assert.match(String(img.note), /does not build images/);
  assert.deepEqual(
    previewLocation({ slug: 's', serveMode: 'image', spec: undefined, deploy: { previewUrl: 'https://s.example.com' } } as never),
    { url: 'https://s.example.com', note: null },
  );
});
