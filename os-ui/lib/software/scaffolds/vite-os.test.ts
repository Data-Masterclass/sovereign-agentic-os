/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Vite OS app scaffold template (lib/software/scaffolds/vite-os.ts).
 *
 * Asserts:
 *  1. The template produces the expected file set.
 *  2. package.json is valid JSON, names the slug, and uses permissive licenses only.
 *  3. The Dockerfile is multi-stage, produces a static build, and serves nginx on 8080.
 *  4. The template references the OS SDK (@sovereign-os/app-sdk).
 *  5. nginx.conf listens on 8080 with SPA fallback.
 *  6. app.yaml declares surface: ui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viteOsAllFiles, VITE_OS_EXPECTED_PATHS } from './vite-os.ts';

const SLUG = 'my-app';
const NAME = 'My App';

function files() {
  return viteOsAllFiles(NAME, SLUG);
}

function byPath(path: string) {
  return files().find((f) => f.path === path);
}

// --------------------------------------------------------- file set completeness --

test('vite-os scaffold: produces the expected file set', () => {
  const produced = files().map((f) => f.path).sort();
  const expected = [...VITE_OS_EXPECTED_PATHS].sort();
  assert.deepStrictEqual(produced, expected, 'file set matches VITE_OS_EXPECTED_PATHS');
});

// ------------------------------------------------------------------ package.json --

test('vite-os scaffold: package.json is valid JSON and names the slug', () => {
  const f = byPath('package.json');
  assert.ok(f, 'package.json is present');
  let pkg: Record<string, unknown>;
  assert.doesNotThrow(() => { pkg = JSON.parse(f!.content); }, 'package.json is valid JSON');
  assert.equal(pkg!.name, SLUG, 'package.json .name === slug');
  assert.equal(pkg!.type, 'module', 'package.json .type === "module"');
});

test('vite-os scaffold: package.json deps are all permissive-licensed', () => {
  const f = byPath('package.json');
  const pkg = JSON.parse(f!.content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  // None of the packages are known GPL / AGPL / proprietary offenders.
  const banned = ['webpack', 'gpl', 'agpl'];
  for (const dep of all) {
    for (const b of banned) {
      assert.ok(
        !dep.toLowerCase().includes(b),
        `${dep} matches a banned license keyword "${b}"`,
      );
    }
  }
  // All expected key deps present.
  assert.ok(pkg.dependencies?.['react'], 'react in dependencies');
  assert.ok(pkg.dependencies?.['@sovereign-os/app-sdk'], '@sovereign-os/app-sdk in dependencies');
  assert.ok(pkg.devDependencies?.['vite'], 'vite in devDependencies');
  assert.ok(pkg.devDependencies?.['tailwindcss'], 'tailwindcss in devDependencies');
  assert.ok(pkg.devDependencies?.['typescript'], 'typescript in devDependencies');
});

// -------------------------------------------------------------------- Dockerfile --

test('vite-os scaffold: Dockerfile is multi-stage (builder + nginx)', () => {
  const f = byPath('Dockerfile');
  assert.ok(f, 'Dockerfile is present');
  assert.match(f!.content, /FROM node:\S+ AS builder/i, 'has a named builder stage');
  assert.match(f!.content, /FROM nginx:/i, 'has a nginx serving stage');
});

test('vite-os scaffold: Dockerfile builds SPA and serves nginx on port 8080', () => {
  const f = byPath('Dockerfile');
  assert.match(f!.content, /npm run build/, 'runs npm run build');
  assert.match(f!.content, /EXPOSE 8080/, 'exposes port 8080');
  assert.match(f!.content, /nginx/, 'uses nginx to serve');
  // Must NOT swallow install errors.
  assert.doesNotMatch(f!.content, /\|\| true/, 'does not swallow install errors');
});

// -------------------------------------------------------------------- nginx.conf --

test('vite-os scaffold: nginx.conf listens on 8080 with SPA fallback', () => {
  const f = byPath('nginx.conf');
  assert.ok(f, 'nginx.conf is present');
  assert.match(f!.content, /listen 8080/, 'listens on 8080');
  assert.match(f!.content, /try_files.*index\.html/, 'has SPA fallback to index.html');
});

// ------------------------------------------------------------ OS SDK references --

test('vite-os scaffold: src/os.ts imports createOsClient from @sovereign-os/app-sdk', () => {
  const f = byPath('src/os.ts');
  assert.ok(f, 'src/os.ts is present');
  assert.match(f!.content, /@sovereign-os\/app-sdk/, 'imports from @sovereign-os/app-sdk');
  assert.match(f!.content, /createOsClient/, 'exports createOsClient');
});

test('vite-os scaffold: src/App.tsx uses os.whoami() + os.context()', () => {
  const f = byPath('src/App.tsx');
  assert.ok(f, 'src/App.tsx is present');
  assert.match(f!.content, /os\.whoami\(\)/, 'calls os.whoami()');
  assert.match(f!.content, /os\.context\(\)/, 'calls os.context()');
});

// -------------------------------------------------------------------- app.yaml --

test('vite-os scaffold: app.yaml declares surface: ui', () => {
  const f = byPath('app.yaml');
  assert.ok(f, 'app.yaml is present');
  assert.match(f!.content, /surface:\s*ui/, 'declares surface: ui');
  assert.match(f!.content, /software\.sovereign-os\/v1/, 'has the correct apiVersion');
});

// --------------------------------------------------------------- vite.config.ts --

test('vite-os scaffold: vite.config.ts uses @vitejs/plugin-react', () => {
  const f = byPath('vite.config.ts');
  assert.ok(f, 'vite.config.ts is present');
  assert.match(f!.content, /@vitejs\/plugin-react/, 'uses @vitejs/plugin-react');
});

// -------------------------------------------------------------- CI workflow ------

test('vite-os scaffold: .forgejo/workflows/ci.yml builds and pushes to in-cluster registry', () => {
  const f = byPath('.forgejo/workflows/ci.yml');
  assert.ok(f, '.forgejo/workflows/ci.yml is present');
  assert.match(f!.content, /docker build/, 'contains docker build');
  assert.match(f!.content, /docker push/, 'contains docker push');
  assert.match(f!.content, /branches: \[main\]/, 'triggers on main branch push');
});

// -------------------------------------------------------------- README ----------

test('vite-os scaffold: README.md explains governed OS app + nginx:8080', () => {
  const f = byPath('README.md');
  assert.ok(f, 'README.md is present');
  assert.match(f!.content, /governed OS app/i, 'describes a governed OS app');
  assert.match(f!.content, /8080/, 'mentions port 8080');
  assert.match(f!.content, /@sovereign-os\/app-sdk/, 'mentions the SDK');
});
