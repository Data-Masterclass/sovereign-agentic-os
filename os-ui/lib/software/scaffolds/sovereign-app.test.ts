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
 *  5. Admin section — domain_admin-gated; lists THIS app's membership (owner + added
 *     users) from /api/apps/by-slug/<slug>/members, with add/remove for app admins.
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

test('sovereign-app scaffold: App.tsx is a thin entrypoint mounting the template Shell', () => {
  const app = byPath('src/App.tsx');
  assert.match(app, /IdentityProvider/, 'wires the OS identity provider');
  assert.match(app, /template\/shell\.tsx/, 'mounts the template Shell');
  assert.doesNotMatch(app, /AppShell/, 'no business logic in the thin entrypoint');
  const shell = byPath('src/template/shell.tsx');
  assert.match(shell, /AppShell/, 'the template shell wears AppShell');
  assert.match(shell, /@sovereign-os\/ui/, 'imports the OS design system');
  assert.match(shell, /SECTIONS/, 'nav is driven by the sections registry');
  const sections = byPath('src/template/sections.tsx');
  assert.match(sections, /EPICS ADD SECTIONS HERE/, 'documents where epics add nav items');
  assert.match(sections, /Overview/, 'seeds the Overview section');
  assert.match(sections, /Workspace/, 'seeds the placeholder section');
});

// -------------------------------------------------- template/core/epics structure --

test('sovereign-app scaffold: emits template/, core/ and an empty epics/ layout', () => {
  const paths = files().map((f) => f.path);
  // template/ carries the FIXED scaffold.
  for (const p of ['src/template/shell.tsx', 'src/template/identity.tsx', 'src/template/roles.ts', 'src/template/scope.ts', 'src/template/app-meta.ts', 'src/template/sections.tsx', 'src/template/pages/Admin.tsx', 'src/template/pages/Overview.tsx']) {
    assert.ok(paths.includes(p), `template carries ${p}`);
  }
  // core/ carries shared functionality + the governed data plane.
  assert.ok(paths.includes('src/core/store.ts'), 'core has the shared governed store');
  assert.match(byPath('src/core/store.ts'), /GOVERNED[\s\S]*DATA[\s\S]*PLANE/i, 'core store uses the governed data plane, not Supabase');
  assert.match(byPath('src/core/store.ts'), /@sovereign-os\/app-sdk|createOsClient/, 'core store uses the OS SDK, not a custom backend');
  // No app files import or wire Supabase anywhere.
  for (const f of files()) assert.doesNotMatch(f.content, /from ['"]@?supabase|createClient\(/i, `${f.path} does not wire Supabase`);
  // epics/ exists but is empty of features (only a README explaining the layout).
  const epicFiles = paths.filter((p) => p.startsWith('src/epics/'));
  assert.deepStrictEqual(epicFiles, ['src/epics/README.md'], 'epics/ ships empty except its README');
  assert.match(byPath('src/epics/README.md'), /<storyKey>/, 'epics README states the story layout');
  // thin entrypoints: no real logic under src/*.tsx at the root beyond App/main.
  assert.match(byPath('src/main.tsx'), /THIN entrypoint/, 'main is a thin entrypoint');
});

// ------------------------------------------------------- 2. OS-delegated identity --

test('sovereign-app scaffold: identity is delegated to the OS (no local auth)', () => {
  const identity = byPath('src/template/identity.tsx');
  assert.match(identity, /os\.whoami\(\)/, 'reads the OS session via the SDK');
  assert.match(identity, /Not signed in via the OS/, 'honest signed-out screen');
  assert.match(identity, /signed-out/, 'models the signed-out phase');
  for (const f of files()) {
    assert.ok(!/local\s*password|createUser|signUp|register\s*account/i.test(f.content), `${f.path} has no local account surface`);
  }
});

// --------------------------------------------------------- 3. Domain + scoping --

test('sovereign-app scaffold: owning domain is derived from the app host', () => {
  const meta = byPath('src/template/app-meta.ts');
  assert.match(meta, /owningDomain/, 'exports owningDomain');
  assert.match(meta, /labels\[0\] === APP_SLUG/, 'derives from <slug>.<domain>.<apps-domain>');
  assert.match(meta, /return null/, 'honestly returns null when underivable');
});

test('sovereign-app scaffold: osBaseUrl uses the baked build arg and has an honest runtime fallback', () => {
  const meta = byPath('src/template/app-meta.ts');
  // Primary: the OS URL baked at build time (Dockerfile ARG OS_API_URL → VITE_OS_API).
  assert.match(meta, /VITE_OS_API/, 'reads the build-time OS URL');
  assert.match(meta, /export function osBaseUrl/, 'exports osBaseUrl');
  // Fallback: derive the OS origin from the deployed app host when the arg is missing,
  // so a rebuilt/old app degrades gracefully instead of hitting its own origin.
  assert.match(meta, /deriveOsOriginFromHost/, 'has a host-derived runtime fallback');
  assert.match(meta, /labels\.slice\(2\)/, 'drops <slug>.<domain> to reach the OS parent host');
});

test('sovereign-app scaffold: scope helpers mirror My/Domain and stamp owner+domain', () => {
  const scope = byPath('src/template/scope.ts');
  for (const fn of ['isMine', 'inDomain', 'onlyMine', 'onlyDomain', 'visibleTo', 'stamp']) {
    assert.match(scope, new RegExp(`export function ${fn}`), `exports ${fn}`);
  }
  assert.match(scope, /owner: string; domain: string/, 'records carry owner + domain');
});

// ---------------------------------------------------------------- 4. Admin section --

test('sovereign-app scaffold: admin section is role-gated and lists THIS app\'s membership (not the OS directory)', () => {
  const admin = byPath('src/template/pages/Admin.tsx');
  assert.match(admin, /roleAtLeast\(role, 'domain_admin'\)/, 'domain_admin floor (roleAtLeast, not an exact set)');
  // The membership surface is the app's OWN members route, keyed by the baked slug —
  // NEVER the whole-domain user directory that leaked every cohort account.
  assert.match(admin, /\/api\/apps\/by-slug\/\$\{encodeURIComponent\(APP_SLUG\)\}\/members/, 'lists the app\'s own membership');
  assert.doesNotMatch(admin, /\/api\/users\/domain/, 'does NOT list the whole OS domain directory');
  assert.match(admin, /App members/, 'the section is the app\'s members, not "who can access"');
  // App admins can add/remove — gated client-side by canManage (the route re-checks).
  assert.match(admin, /canManage/, 'add/remove affordances gate on canManage');
  assert.match(admin, /method: 'POST'/, 'can add a member');
  assert.match(admin, /method: 'DELETE'/, 'can remove a member');
  const shell = byPath('src/template/shell.tsx');
  assert.match(shell, /roleAtLeast\(user\.role, 'domain_admin'\)/, 'nav gates Admin at domain_admin+');
});

// ------------------------------------------------------------------- 5. MCP link --

test('sovereign-app scaffold: MCP top-bar link targets this app connection in the OS', () => {
  const meta = byPath('src/template/app-meta.ts');
  assert.match(meta, /\/connections\?focus=/, 'links to the OS Connections page');
  assert.match(meta, /'app-' \+ APP_SLUG/, 'deterministic principal app-<slug>');
  const shell = byPath('src/template/shell.tsx');
  assert.match(shell, /mcpSetupUrl\(\)/, 'the top bar renders the MCP link');
  assert.match(shell, />\s*MCP\s*</, 'labelled MCP');
});

// ------------------------------------------------------------ 6. README / docs --

test('sovereign-app scaffold: README is the skeleton guide and doubles as docs', () => {
  const readme = byPath('README.md');
  assert.equal(readme, sovereignAppGuide(NAME, SLUG), 'README.md === the guide the app docs reuse');
  assert.match(readme, /src\/template\/sections\.tsx/, 'tells the agent where epics add sections');
  assert.match(readme, /src\/epics\/<epic>\/<story>/, 'documents the epics/story code layout');
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
