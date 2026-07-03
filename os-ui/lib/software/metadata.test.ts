/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppManifest, renderAppYaml, parseOpenApi, defaultOpenApi, detectSurface } from './metadata.ts';

test('app.yaml convention is parsed into the manifest (declared resources)', () => {
  const appYaml = renderAppYaml({
    name: 'Renewals Tracker',
    owner: 'alice',
    description: 'Track renewals',
    connections: ['salesforce'],
    data: ['accounts'],
    knowledge: ['discount-policy'],
  });
  const m = parseAppManifest(
    [
      { path: 'app.yaml', content: appYaml },
      { path: 'openapi.yaml', content: defaultOpenApi('renewals') },
      { path: '.app/decisions.md', content: '# decisions' },
    ],
    { name: 'fallback', owner: 'fallback' },
  );
  assert.equal(m.name, 'Renewals Tracker');
  assert.equal(m.owner, 'alice');
  assert.deepEqual(m.connections, ['salesforce']);
  assert.deepEqual(m.knowledge, ['discount-policy']);
  assert.equal(m.hasOpenApi, true);
  assert.equal(m.missing.length, 0);
});

test('imported/legacy repo (no app.yaml) derives what it can + flags the rest', () => {
  const m = parseAppManifest(
    [{ path: 'README.md', content: '# Orders API\nA legacy orders service.\n' }],
    { name: 'orders-api', owner: 'bob' },
  );
  assert.equal(m.name, 'orders-api');
  assert.equal(m.description.includes('legacy orders service'), true);
  assert.equal(m.missing.includes('app.yaml'), true);
  assert.equal(m.hasOpenApi, false);
  assert.equal(m.missing.some((x) => x.startsWith('openapi')), true);
});

test('parseOpenApi reads a committed spec', () => {
  const spec = parseOpenApi([{ path: 'openapi.yaml', content: defaultOpenApi('x') }]);
  assert.ok(spec);
  assert.ok(spec!.paths['/renewals']);
});

test('detectSurface: a Next.js app with an OpenAPI spec exposes BOTH ui + api', () => {
  const s = detectSurface([
    { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }) },
    { path: 'openapi.yaml', content: defaultOpenApi('renewals') },
    { path: 'app/page.tsx', content: 'export default function Page() { return null; }' },
  ]);
  assert.deepEqual(s, { ui: true, api: true });
});

test('detectSurface: a headless service (Python entrypoint, no frontend) is api-only', () => {
  const s = detectSurface([
    { path: 'main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n' },
    { path: 'requirements.txt', content: 'fastapi\n' },
  ]);
  assert.deepEqual(s, { ui: false, api: true });
});

test('detectSurface: a static HTML site with no API is ui-only', () => {
  const s = detectSurface([
    { path: 'public/index.html', content: '<!doctype html><title>site</title>' },
  ]);
  assert.deepEqual(s, { ui: true, api: false });
});

test('detectSurface: nothing detectable falls back to a headless api surface', () => {
  const s = detectSurface([{ path: 'README.md', content: '# just docs' }]);
  assert.deepEqual(s, { ui: false, api: true });
});
