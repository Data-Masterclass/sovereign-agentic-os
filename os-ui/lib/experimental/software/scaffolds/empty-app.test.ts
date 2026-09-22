/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Empty App scaffold (lib/software/scaffolds/empty-app.ts).
 * The bare minimum that still builds/previews/deploys: Vite entry + one page
 * saying the app name + README. No imposed structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAppFiles, emptyAppGuide, EMPTY_APP_EXPECTED_PATHS } from './empty-app.ts';

const SLUG = 'scratch';
const NAME = 'Scratch';

function files() {
  return emptyAppFiles(NAME, SLUG);
}

function byPath(path: string): string {
  const f = files().find((x) => x.path === path);
  assert.ok(f, `${path} is present in the scaffold`);
  return f!.content;
}

test('empty-app scaffold: produces the minimal expected file set', () => {
  const produced = files().map((f) => f.path).sort();
  assert.deepStrictEqual(produced, [...EMPTY_APP_EXPECTED_PATHS].sort());
});

test('empty-app scaffold: a Vite entry that renders one page with the app name', () => {
  assert.match(byPath('src/main.tsx'), /createRoot/, 'boots React');
  assert.match(byPath('src/main.tsx'), /App\.tsx/, 'renders App');
  const app = byPath('src/App.tsx');
  assert.match(app, new RegExp(`<h1>${NAME}</h1>`), 'the page says the app name');
  assert.match(app, /blank canvas/i, 'declares itself a blank canvas');
});

test('empty-app scaffold: still builds/previews/deploys like every governed SPA', () => {
  assert.match(byPath('Dockerfile'), /EXPOSE 8080/);
  assert.match(byPath('nginx.conf'), /listen 8080/);
  assert.match(byPath('.forgejo/workflows/ci.yml'), /docker push/);
  assert.match(byPath('app.yaml'), /surface: ui/);
});

test('empty-app scaffold: README doubles as the docs contract', () => {
  assert.equal(byPath('README.md'), emptyAppGuide(NAME) + '\n');
});
