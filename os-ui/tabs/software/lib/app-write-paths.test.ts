/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Pin the forbidden-paths rule for app files with a test, at every write door
 * USER STORY: As the OS I want every listed path refused whichever door app files come through,
 *             so the rule in `app-write-paths.ts` holds everywhere, not only where it was written.
 * ARCHITECTURE:
 *   - Walks EVERY entry of the two lists (reserved directories, root credential files) through
 *     each door that accepts a caller's app files: `assertPushable` / `push_app_files`, the
 *     `commit` tool (the builder chat's write tool), the builder's coder-reply parser, and the
 *     import route. Offline: every store call fails fast, so the app store is in-memory.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const dev: CurrentUser = testUser({ id: 'wpd', name: 'Write Paths Dev', domains: ['eng'], role: 'builder' });
mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => dev, currentUser: async () => dev },
});

const { APP_WRITE_FORBIDDEN_PREFIXES, APP_WRITE_FORBIDDEN_ROOT_FILES, forbiddenAppPathReason, assertNoForbiddenAppPaths } =
  await import('./app-write-paths.ts');
const { assertPushable } = await import('./push-app-files.ts');
const { callPlatformMcp } = await import('./platform-mcp.ts');
const { pathRefusal, parseCoderReply } = await import('./builder/prompts.ts');
const { createApp } = await import('./apps.ts');
const { updateSettings } = await import('@tabs/admin/lib/settings');

/** Every listed path, as a file inside each reserved directory, the bare directory name, and each
 *  root credential file. */
const FORBIDDEN_PATHS: string[] = [
  ...APP_WRITE_FORBIDDEN_PREFIXES.flatMap((pre) => [`${pre}x.txt`, `${pre}nested/y.yml`, pre.slice(0, -1)]),
  ...APP_WRITE_FORBIDDEN_ROOT_FILES,
];
const NOT_PUSHABLE = /is not pushable/;

test('the lists are what the rule enforces: every entry is refused, ordinary source is not', () => {
  assert.ok(APP_WRITE_FORBIDDEN_PREFIXES.length > 0 && APP_WRITE_FORBIDDEN_ROOT_FILES.length > 0);
  for (const p of FORBIDDEN_PATHS) assert.match(forbiddenAppPathReason(p) ?? '', NOT_PUSHABLE, p);
  // Case does not matter.
  assert.match(forbiddenAppPathReason('.GitHub/workflows/ci.yml') ?? '', NOT_PUSHABLE);
  for (const ok of ['src/App.tsx', 'public/logo.svg', 'index.html', 'docs/app-notes.md', 'src/env.ts']) {
    assert.equal(forbiddenAppPathReason(ok), null, ok);
  }
  assert.throws(() => assertNoForbiddenAppPaths([{ path: 'src/a.ts' }, { path: '.env' }]), (e: Error & { status?: number }) => e.status === 400);
  assert.doesNotThrow(() => assertNoForbiddenAppPaths([{ path: 'src/a.ts' }]));
  assert.doesNotThrow(() => assertNoForbiddenAppPaths(undefined));
});

test('door: assertPushable (push_app_files, UI and MCP) refuses every listed path', () => {
  for (const p of FORBIDDEN_PATHS) {
    assert.throws(
      () => assertPushable([{ path: p, content: 'x' }]),
      (e: Error & { status?: number }) => e.status === 400 && NOT_PUSHABLE.test(e.message),
      p,
    );
  }
});

test('door: the push_app_files MCP tool refuses every listed path', async () => {
  const app = await createApp(dev, { name: 'Write Paths Push', template: 'sovereign-app' });
  for (const p of FORBIDDEN_PATHS) {
    await assert.rejects(
      callPlatformMcp(dev, 'push_app_files', { appId: app.id, files: [{ path: p, content: 'x' }] }),
      (e: Error & { status?: number }) => e.status === 400 && NOT_PUSHABLE.test(e.message),
      p,
    );
  }
});

test('door: the commit tool (the builder chat writes through it) refuses every listed path', async () => {
  updateSettings({ codedAppsEnabled: true });
  const app = await createApp(dev, { name: 'Write Paths Commit', template: 'sovereign-app' });
  for (const p of FORBIDDEN_PATHS) {
    await assert.rejects(
      callPlatformMcp(dev, 'commit', { appId: app.id, files: [{ path: 'src/ok.ts', content: 'export {};\n' }, { path: p, content: 'x' }] }),
      (e: Error & { status?: number }) => e.status === 400 && NOT_PUSHABLE.test(e.message),
      p,
    );
  }
});

test('door: the builder coder reply refuses every listed path (dropped, with a reason)', () => {
  for (const p of FORBIDDEN_PATHS) {
    assert.ok(pathRefusal(p), p);
    const parsed = parseCoderReply(JSON.stringify({ files: [{ path: 'src/ok.ts', content: 'export {};\n' }, { path: p, content: 'x' }] }));
    assert.ok(parsed.ok, p);
    if (parsed.ok) {
      assert.deepEqual(parsed.files.map((f) => f.path), ['src/ok.ts'], p);
      assert.equal(parsed.refused.length, 1, p);
    }
  }
});

test('door: the import route refuses every listed path before creating the app', async () => {
  const { POST } = await import('../../../app/api/apps/import/route.ts');
  for (const p of FORBIDDEN_PATHS) {
    const req = new Request('http://x/api/apps/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Imported', files: [{ path: p, content: 'x' }] }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    assert.equal(res.status, 400, p);
    assert.match(((await res.json()) as { error: string }).error, NOT_PUSHABLE, p);
  }
});
