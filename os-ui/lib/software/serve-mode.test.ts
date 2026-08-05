/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase D — the serveMode flag + the runtime-serving orchestrator, end to end over the
 * real app store (offline). Pins:
 *   • flag nil-safety: a legacy record loads as 'image', byte-stable;
 *   • PATCH gating: setAppServeMode is edit-scoped and refuses 'runtime' for a
 *     non-Vite shape (400);
 *   • the runtime surface resolves by slug + visibility gate;
 *   • a gate-RED tree serves an honest "does not compile" page — never a bundle;
 *   • serveMode='image' apps are refused by the runtime surface (409, honest note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';

// Offline: every Forgejo/OpenSearch call fails fast → the store runs in-memory.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  createApp,
  setAppServeMode,
  serveModeOf,
  normalizeServeMode,
  getAppForUser,
  __resetAppsCache,
} = await import('./apps.ts');
const { serveAppRuntime } = await import('./app-runtime.ts');
const { __resetBundleCache } = await import('./preview-runtime.ts');
import type { App } from './apps.ts';

const owner: CurrentUser = { id: 'ola', name: 'Ola', domains: ['eng'], allDomains: ['eng'], activeDomain: 'eng', role: 'builder' };
const outsider: CurrentUser = { id: 'zed', name: 'Zed', domains: ['sales'], allDomains: ['sales'], activeDomain: 'sales', role: 'builder' };

function reset() {
  __resetAppsCache?.();
  __resetBundleCache();
}

// ------------------------------------------------------------- nil-safety ---

test('normalizeServeMode: only "runtime" opts in; everything else is "image"', () => {
  assert.equal(normalizeServeMode('runtime'), 'runtime');
  assert.equal(normalizeServeMode('image'), 'image');
  assert.equal(normalizeServeMode(undefined), 'image');
  assert.equal(normalizeServeMode(null), 'image');
  assert.equal(normalizeServeMode('garbage'), 'image');
  // serveModeOf reads a possibly-legacy record nil-safely.
  assert.equal(serveModeOf({ serveMode: undefined } as Pick<App, 'serveMode'>), 'image');
  assert.equal(serveModeOf({} as Pick<App, 'serveMode'>), 'image');
});

test('a fresh app defaults to image serving', async () => {
  reset();
  const app = await createApp(owner, { name: 'Fresh', template: 'sovereign-app' });
  assert.equal(serveModeOf(app), 'image', 'default is the historic per-app-image path');
});

// -------------------------------------------------------------- PATCH gate ---

test('setAppServeMode flips a Vite app to runtime and back; a no-op writes nothing new', async () => {
  reset();
  const app = await createApp(owner, { name: 'Vite App', template: 'sovereign-app' });
  const on = await setAppServeMode(app.id, owner, 'runtime');
  assert.equal(on.serveMode, 'runtime');
  const off = await setAppServeMode(app.id, owner, 'image');
  assert.equal(off.serveMode, 'image');
  // No-op (already image) returns the same record, still 'image'.
  const same = await setAppServeMode(app.id, owner, 'image');
  assert.equal(same.serveMode, 'image');
});

test('setAppServeMode refuses runtime for a non-Vite shape (400)', async () => {
  reset();
  const api = await createApp(owner, { name: 'Api Only', template: 'api-service' });
  await assert.rejects(
    () => setAppServeMode(api.id, owner, 'runtime'),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /Vite-shaped/i);
      return true;
    },
  );
  // Untouched: still image.
  const after = await getAppForUser(api.id, owner);
  assert.equal(serveModeOf(after), 'image');
});

test('setAppServeMode is edit-scoped — an outsider cannot even see the app (404)', async () => {
  reset();
  const app = await createApp(owner, { name: 'Private', template: 'sovereign-app' });
  await assert.rejects(() => setAppServeMode(app.id, outsider, 'runtime'), /not found/i);
});

// ------------------------------------------------------- runtime surface ---

test('serveAppRuntime refuses an image-served app with an honest 409 note', async () => {
  reset();
  const app = await createApp(owner, { name: 'Image Served', template: 'sovereign-app' });
  const res = await serveAppRuntime(app.slug, owner);
  assert.equal(res.status, 409);
  assert.match(res.html, /container image|Runtime serving/i);
  assert.doesNotMatch(res.html, /<div id="root">/, 'no app bundle for an image-served app');
});

test('serveAppRuntime enforces the visibility gate (404 for an outsider)', async () => {
  reset();
  const app = await createApp(owner, { name: 'Scoped', template: 'sovereign-app' });
  await setAppServeMode(app.id, owner, 'runtime');
  const res = await serveAppRuntime(app.slug, outsider);
  assert.equal(res.status, 404);
});

test('serveAppRuntime serves a gate-GREEN runtime app in a sandboxed iframe with strict CSP', async () => {
  reset();
  const app = await createApp(owner, { name: 'Green', template: 'sovereign-app' });
  await setAppServeMode(app.id, owner, 'runtime');
  const res = await serveAppRuntime(app.slug, owner);
  assert.equal(res.status, 200);
  // Sandboxed, same-origin iframe (the reused auth bridge) — no top-navigation.
  assert.match(res.html, /sandbox="allow-scripts allow-same-origin"/);
  assert.doesNotMatch(res.html, /allow-top-navigation/);
  // Strict CSP on the outer document; the SDK's same-origin OS calls are allowed.
  assert.match(res.csp, /default-src 'none'/);
  assert.match(res.csp, /connect-src 'self'/);
  // The import-map points React at the runtime facade route (no CDN).
  assert.match(res.html, /preview-runtime\?asset=react/);
});

test('serveAppRuntime serves an honest "does not compile" page for a gate-RED tree — NO bundle', async () => {
  reset();
  const app = await createApp(owner, { name: 'Broken', template: 'sovereign-app' });
  await setAppServeMode(app.id, owner, 'runtime');
  // Commit a file that will not compile (hallucinated UI member) via the build path.
  // commitToApp runs the compile gate itself; if it rejects, seed the snapshot directly
  // so the runtime surface sees a red tree. We assert the runtime's own gate behaviour.
  const { snapshotFiles } = await import('./snapshot.ts');
  const { sovereignAppFiles } = await import('./scaffolds/sovereign-app.ts');
  const base = sovereignAppFiles(app.name, app.slug);
  const red = [
    ...base.filter((f) => f.path !== 'src/App.tsx'),
    { path: 'src/App.tsx', content: 'export default function App(){ return <Nope />; }\n' },
  ];
  snapshotFiles(app.id, red);
  const res = await serveAppRuntime(app.slug, owner);
  assert.equal(res.status, 200);
  assert.match(res.html, /does not compile/i, 'the honest red page');
  assert.doesNotMatch(res.html, /type="importmap"/, 'no app bundle/import-map for a red tree');
});

// Keep the mocked fetch from leaking into other suites in the same process.
test('teardown', () => {
  globalThis.fetch = _realFetch;
});
