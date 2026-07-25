/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Sovereign standard app scaffold (lib/software/scaffolds/sovereign-app.ts).
 *
 * Asserts the template really carries the six base-app requirements as source:
 *  1. The expected file set (skeleton completeness).
 *  2. AppShell layout — src/App.tsx wears @sovereign-os/ui AppShell with a nav.
 *  3. OS-delegated identity — whoami-based provider, signed-out screen, no local auth.
 *  4. Domain/tenancy — owning-domain derivation + My/Domain scope helpers.
 *  5. Admin section — domain_admin-gated, read-only OS user list from /api/users/domain.
 *  6. MCP top-bar link — deterministic /connections?focus=app-<slug> deep link.
 *  Plus: the README guide doubles as build-assistant docs, and infra parity with vite-os.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sovereignAppFiles, sovereignAppGuide, SOVEREIGN_APP_EXPECTED_PATHS } from './sovereign-app.ts';

const SLUG = 'ops-hub';
const NAME = 'Ops Hub';

function files() {
  return sovereignAppFiles(NAME, SLUG);
}

function byPath(path: string): string {
  const f = files().find((x) => x.path === path);
  assert.ok(f, `${path} is present in the scaffold`);
  return f!.content;
}

// --------------------------------------------------------- file set completeness --

test('sovereign-app scaffold: produces the expected file set', () => {
  const produced = files().map((f) => f.path).sort();
  const expected = [...SOVEREIGN_APP_EXPECTED_PATHS].sort();
  assert.deepStrictEqual(produced, expected, 'file set matches SOVEREIGN_APP_EXPECTED_PATHS');
});

test('sovereign-app scaffold: package.json names the slug and both OS packages', () => {
  const pkg = JSON.parse(byPath('package.json')) as { name: string; dependencies: Record<string, string> };
  assert.equal(pkg.name, SLUG);
  assert.ok(pkg.dependencies['@sovereign-os/ui'], 'depends on @sovereign-os/ui');
  assert.ok(pkg.dependencies['@sovereign-os/app-sdk'], 'depends on @sovereign-os/app-sdk');
});

// ------------------------------------------------------------- 1. AppShell layout --

test('sovereign-app scaffold: App.tsx wears the OS AppShell with a section nav', () => {
  const app = byPath('src/App.tsx');
  assert.match(app, /AppShell/, 'uses AppShell');
  assert.match(app, /@sovereign-os\/ui/, 'imports the OS design system');
  assert.match(app, /SECTIONS/, 'nav is driven by the sections registry');
  const sections = byPath('src/sections.tsx');
  assert.match(sections, /EPICS ADD SECTIONS HERE/, 'documents where epics add nav items');
  assert.match(sections, /Overview/, 'seeds the Overview section');
  assert.match(sections, /Workspace/, 'seeds the placeholder section');
});

// ------------------------------------------------------- 2. OS-delegated identity --

test('sovereign-app scaffold: identity is delegated to the OS (no local auth)', () => {
  const identity = byPath('src/identity.tsx');
  assert.match(identity, /os\.whoami\(\)/, 'reads the OS session via the SDK');
  assert.match(identity, /Not signed in via the OS/, 'honest signed-out screen');
  assert.match(identity, /signed-out/, 'models the signed-out phase');
  for (const f of files()) {
    assert.ok(!/local\s*password|createUser|signUp|register\s*account/i.test(f.content), `${f.path} has no local account surface`);
  }
});

// --------------------------------------------------------- 3. Domain + scoping --

test('sovereign-app scaffold: owning domain is derived from the app host', () => {
  const meta = byPath('src/app-meta.ts');
  assert.match(meta, /owningDomain/, 'exports owningDomain');
  assert.match(meta, /labels\[0\] === APP_SLUG/, 'derives from <slug>.<domain>.<apps-domain>');
  assert.match(meta, /return null/, 'honestly returns null when underivable');
});

test('sovereign-app scaffold: scope helpers mirror My/Domain and stamp owner+domain', () => {
  const scope = byPath('src/scope.ts');
  for (const fn of ['isMine', 'inDomain', 'onlyMine', 'onlyDomain', 'visibleTo', 'stamp']) {
    assert.match(scope, new RegExp(`export function ${fn}`), `exports ${fn}`);
  }
  assert.match(scope, /owner: string; domain: string/, 'records carry owner + domain');
});

// ---------------------------------------------------------------- 4. Admin section --

test('sovereign-app scaffold: admin section is role-gated and read-only over the OS', () => {
  const admin = byPath('src/pages/Admin.tsx');
  assert.match(admin, /roleAtLeast\(role, 'domain_admin'\)/, 'domain_admin floor (roleAtLeast, not an exact set)');
  assert.match(admin, /\/api\/users\/domain/, 'lists users from the governed OS directory route');
  assert.match(admin, /managed in the Sovereign OS/, 'says management stays in the OS');
  const app = byPath('src/App.tsx');
  assert.match(app, /roleAtLeast\(user\.role, 'domain_admin'\)/, 'nav gates Admin at domain_admin+');
});

// ------------------------------------------------------------------- 5. MCP link --

test('sovereign-app scaffold: MCP top-bar link targets this app connection in the OS', () => {
  const meta = byPath('src/app-meta.ts');
  assert.match(meta, /\/connections\?focus=/, 'links to the OS Connections page');
  assert.match(meta, /'app-' \+ APP_SLUG/, 'deterministic principal app-<slug>');
  const app = byPath('src/App.tsx');
  assert.match(app, /mcpSetupUrl\(\)/, 'the top bar renders the MCP link');
  assert.match(app, />\s*MCP\s*</, 'labelled MCP');
});

// ------------------------------------------------------------ 6. README / docs --

test('sovereign-app scaffold: README is the skeleton guide and doubles as docs', () => {
  const readme = byPath('README.md');
  assert.equal(readme, sovereignAppGuide(NAME, SLUG), 'README.md === the guide the app docs reuse');
  assert.match(readme, /src\/sections\.tsx/, 'tells the agent where epics add sections');
  assert.match(readme, /identity contract/i, 'states the identity contract');
  assert.match(readme, new RegExp(`app-${SLUG}`), 'names the MCP principal');
});

// --------------------------------------------------------------- infra parity --

test('sovereign-app scaffold: serves like every governed SPA (nginx 8080, CI, surface ui)', () => {
  assert.match(byPath('Dockerfile'), /EXPOSE 8080/, 'serves on the runner probe port');
  assert.match(byPath('nginx.conf'), /listen 8080/, 'nginx on 8080');
  assert.match(byPath('app.yaml'), /surface: ui/, 'declares surface ui');
  assert.match(byPath('.forgejo/workflows/ci.yml'), /docker push/, 'sovereign CI builds + pushes');
});
