/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Website scaffold (lib/software/scaffolds/website.ts).
 * A PUBLIC site: OS theme tokens for coherence, but NO sign-in/admin/identity;
 * one SECTIONS registry drives nav + page; same infra base as every governed SPA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { websiteFiles, websiteGuide, WEBSITE_EXPECTED_PATHS } from './website.ts';

const SLUG = 'acme-site';
const NAME = 'Acme Site';

function files() {
  return websiteFiles(NAME, SLUG);
}

function byPath(path: string): string {
  const f = files().find((x) => x.path === path);
  assert.ok(f, `${path} is present in the scaffold`);
  return f!.content;
}

test('website scaffold: produces the expected file set', () => {
  const produced = files().map((f) => f.path).sort();
  assert.deepStrictEqual(produced, [...WEBSITE_EXPECTED_PATHS].sort());
});

test('website scaffold: PUBLIC — no sign-in, no admin, no identity chrome in the app source', () => {
  for (const f of files().filter((x) => x.path.startsWith('src/'))) {
    assert.ok(!/whoami|sign[- ]?in|identity|AppShell|roleAtLeast|admin/i.test(f.content), `${f.path} carries no identity/admin surface`);
  }
});

test('website scaffold: coherent with the OS theme tokens, sections drive the page', () => {
  assert.match(byPath('src/index.css'), /@sovereign-os\/ui\/theme\.css/, 'imports the OS theme tokens');
  assert.match(byPath('src/App.tsx'), /--sb-/, 'uses the theme tokens');
  assert.match(byPath('src/App.tsx'), /SECTIONS/, 'renders from the sections registry');
  assert.match(byPath('src/sections.tsx'), /EPICS ADD SECTIONS HERE/, 'documents where epics add pages');
  assert.match(byPath('src/App.tsx'), new RegExp(NAME), 'the site names itself');
});

test('website scaffold: same infra base — nginx 8080, sovereign CI, surface ui', () => {
  assert.match(byPath('Dockerfile'), /EXPOSE 8080/);
  assert.match(byPath('nginx.conf'), /listen 8080/);
  assert.match(byPath('.forgejo/workflows/ci.yml'), /docker push/);
  assert.match(byPath('app.yaml'), /surface: ui/);
});

test('website scaffold: README is the page-adding contract and doubles as docs', () => {
  const readme = byPath('README.md');
  assert.equal(readme, websiteGuide(NAME) + '\n');
  assert.match(readme, /src\/sections\.tsx/, 'tells the agent where epics add pages');
  assert.match(readme, /no sign-in/i, 'states the public contract');
});
