/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The `@sovereign-os` scope pin (`scope-pin.ts`)
 * USER STORY: As the owner of an OS whose vendored packages live under an npm scope it does not
 *             own on the public registry, I want every generated app pinned away from that
 *             registry, and a tree that would fetch the scope from one refused at the deploy gate.
 * ARCHITECTURE: Pure assertions over the real scaffolds and the real committed lockfile. The npm
 *             behaviour itself (`file:` installs unaffected, a registry lookup for the scope fails
 *             on the `.invalid` host) was proven with a real `npm ci` / `npm install` and is
 *             recorded in ARCHITECTURE.md; a unit test must not need a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NPMRC_PATH,
  SCOPE_PIN_LINE,
  SCOPE_PIN_REGISTRY,
  hasScopePin,
  isScopePinOnlyNpmrc,
  scopePinFindings,
  scopePinNpmrc,
} from './scope-pin.ts';
import { lockInputs, lockedSeed, lockfileFor, withScopePin } from './scaffold-lock.ts';
import { npmLockEvidence } from './lockfile-evidence.ts';
import { viteBaseFiles, viteOsFiles } from './scaffolds/vite-os.ts';
import { sovereignAppFiles } from './scaffolds/sovereign-app.ts';
import { websiteFiles } from './scaffolds/website.ts';
import { emptyAppFiles } from './scaffolds/empty-app.ts';
import { apiServiceFiles } from './scaffolds/api-service.ts';
import type { AppTemplateKey } from './apps.ts';
import type { ScaffoldFile, ScanFinding } from './model.ts';

const { templateFiles } = await import('./apps.ts');
const { securityScan } = await import('./scan.ts');
const { assertPushable } = await import('./push-app-files.ts');

const SLUG = 'orders-app';
const ALL_TEMPLATES: AppTemplateKey[] = ['nextjs-supabase', 'service', 'script', 'dashboard', 'vite-os', 'sovereign-app', 'website', 'api-service', 'empty'];

const blocking = (fs: ScanFinding[]): ScanFinding[] => fs.filter((f) => f.severity === 'critical' || f.severity === 'high');
const lockedVite = (): ScaffoldFile[] => lockedSeed('vite-os', viteOsFiles('App', SLUG), SLUG);
const replace = (files: ScaffoldFile[], path: string, edit: (content: string) => string): ScaffoldFile[] =>
  files.map((f) => (f.path === path ? { path, content: edit(f.content) } : f));
const without = (files: ScaffoldFile[], path: string): ScaffoldFile[] => files.filter((f) => f.path !== path);
const editJson = (edit: (j: any) => void) => (content: string): string => {
  const j = JSON.parse(content);
  edit(j);
  return JSON.stringify(j, null, 2) + '\n';
};

// ------------------------------------------------------------------- the pin itself --

test('PIN · the registry is an https host under .invalid (RFC 6761: it can never resolve)', () => {
  const url = new URL(SCOPE_PIN_REGISTRY);
  assert.equal(url.protocol, 'https:');
  assert.match(url.hostname, /\.invalid$/);
  assert.equal(SCOPE_PIN_LINE, `@sovereign-os:registry=${SCOPE_PIN_REGISTRY}`);
  const npmrc = scopePinNpmrc();
  assert.equal(npmrc.path, '.npmrc');
  assert.ok(npmrc.content.split('\n').includes(SCOPE_PIN_LINE), 'the pin is a line of its own');
  assert.ok(isScopePinOnlyNpmrc(npmrc.content), 'and the file sets nothing else');
  assert.doesNotMatch(npmrc.content, /_auth|token|password/i, 'no credential');
});

test('PIN · every template a NEW app can be seeded from carries the pin, locked or not', () => {
  const raw: Partial<Record<AppTemplateKey, ScaffoldFile[]>> = {
    'vite-os': viteOsFiles('App', SLUG),
    'sovereign-app': sovereignAppFiles('App', SLUG),
    website: websiteFiles('App', SLUG),
    empty: emptyAppFiles('App', SLUG),
    'api-service': apiServiceFiles('App', SLUG),
  };
  for (const template of ALL_TEMPLATES) {
    // The raw scaffold where one exists (it has NO .npmrc: lockedSeed must add it), else the template tree.
    const seed = lockedSeed(template, raw[template] ?? templateFiles(template, 'App', SLUG), SLUG);
    const npmrc = seed.filter((f) => f.path === NPMRC_PATH);
    assert.equal(npmrc.length, 1, `${template}: exactly one .npmrc`);
    assert.ok(hasScopePin(npmrc[0].content), `${template}: it pins the scope`);
    assert.ok(hasScopePin(templateFiles(template, 'App', SLUG).find((f) => f.path === NPMRC_PATH)?.content ?? ''), `${template}: the fallback tree carries it too`);
  }
});

test('PIN · the Dockerfiles that run an install set the pin themselves, and copy the .npmrc in first', () => {
  for (const template of ['vite-os', 'sovereign-app', 'website', 'empty', 'nextjs-supabase'] as AppTemplateKey[]) {
    for (const tree of [templateFiles(template, 'App', SLUG), lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG)]) {
      const lines = tree.find((f) => f.path === 'Dockerfile')!.content.split('\n');
      const installs = lines.filter((l) => /^RUN .*npm (ci|install)/.test(l));
      assert.ok(installs.length > 0, `${template}: has an install step`);
      for (const l of installs) {
        // Every `npm ci` / `npm install` on the line runs with the pin in its environment.
        assert.equal(
          (l.match(/npm (ci|install)/g) ?? []).length,
          (l.match(new RegExp(`env "npm_config_@sovereign-os:registry=${SCOPE_PIN_REGISTRY}" npm (ci|install)`, 'g')) ?? []).length,
          `${template}: ${l}`,
        );
      }
      const copy = lines.findIndex((l) => /^COPY .*\.npmrc\*/.test(l));
      const install = lines.findIndex((l) => /^RUN .*npm (ci|install)/.test(l));
      assert.ok(copy >= 0 && copy < install, `${template}: the .npmrc is copied before the install`);
      assert.ok(lines.includes(`RUN npm config set "@sovereign-os:registry" "${SCOPE_PIN_REGISTRY}"`), `${template}: user-level pin`);
    }
  }
});

// ------------------------------------------------------- lock evidence is unaffected --

test('LOCK · the pin is configuration, not a resolution input: lockfile and lock evidence are unchanged by it', () => {
  const seed = lockedVite();
  const lock = seed.find((f) => f.path === 'package-lock.json')!;
  assert.equal(lock.content, lockfileFor('vite', SLUG).content, 'the seeded lockfile is the committed one');
  assert.deepEqual(npmLockEvidence(seed), npmLockEvidence(without(seed, NPMRC_PATH)), 'evidence ignores the .npmrc');
  for (const e of npmLockEvidence(seed)) assert.equal(e.state, 'consistent', `${e.manifest}: ${e.problems.join('; ')}`);
  // What the regeneration script writes: the manifests npm resolves, plus the pin beside them.
  const inputs = lockInputs('vite', viteBaseFiles('App', SLUG));
  assert.ok(inputs.every((f) => f.path.endsWith('package.json')), 'lock inputs stay manifests only');
  assert.deepEqual(
    withScopePin(inputs).map((f) => f.path),
    [...inputs.map((f) => f.path), NPMRC_PATH],
  );
});

// ----------------------------------------------------------------------- detection --

test('DETECT · a locked seed is clean: file: dependencies and local lock links pass', () => {
  for (const template of ['vite-os', 'sovereign-app', 'website', 'empty', 'api-service'] as AppTemplateKey[]) {
    const seed = lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG);
    assert.deepEqual(scopePinFindings(seed), [], template);
  }
  assert.equal(securityScan(lockedVite(), 'offline-mock').passed, true);
});

test('DETECT · a package.json or lockfile that cannot be read blocks: an unread manifest is not a clean one', () => {
  for (const path of ['package.json', 'package-lock.json']) {
    const tree = replace(lockedVite(), path, (c) => c.slice(0, Math.floor(c.length / 2)));
    const found = blocking(scopePinFindings(tree));
    assert.equal(found.length, 1, path);
    assert.equal(found[0].path, path);
    assert.match(found[0].title, /could not be checked/);
    assert.equal(securityScan(tree, 'offline-mock').passed, false, path);
  }
  // twin: the same files, intact, produce no finding at all
  assert.deepEqual(scopePinFindings(lockedVite()), []);
  // a JSON array is valid JSON but not a manifest: also unreadable for this check
  const arr = replace(lockedVite(), 'package.json', () => '[]');
  assert.equal(blocking(scopePinFindings(arr)).length, 1);
});

test('DETECT · a VERSION RANGE for the scope in a locked app blocks, with a plain message', () => {
  const tree = replace(lockedVite(), 'package.json', editJson((j) => (j.dependencies['@sovereign-os/ui'] = '^0.1.0')));
  const found = blocking(scopePinFindings(tree));
  assert.equal(found.length, 1);
  assert.equal(found[0].category, 'deps');
  assert.equal(found[0].path, 'package.json');
  assert.match(found[0].title, /@sovereign-os\/ui would be fetched from a package registry/);
  assert.match(found[0].detail, /"\^0\.1\.0"/);
  assert.match(found[0].detail, /file:/, 'it names the fix');
  assert.equal(securityScan(tree, 'offline-mock').passed, false, 'and the deploy gate reads it as blocking');
});

test('DETECT · a git reference, a URL and an npm: alias for the scope block — in any dependency field', () => {
  const cases: [string, (j: any) => void][] = [
    ['git', (j) => (j.dependencies['@sovereign-os/app-sdk'] = 'git+https://example.com/x/app-sdk.git')],
    ['github shorthand', (j) => (j.devDependencies['@sovereign-os/ui'] = 'someone/ui')],
    ['tarball url', (j) => (j.dependencies['@sovereign-os/ui'] = 'https://example.com/ui-0.1.0.tgz')],
    ['alias', (j) => (j.dependencies['harmless'] = 'npm:@sovereign-os/ui@^1.0.0')],
    ['a new scoped name', (j) => (j.optionalDependencies = { '@sovereign-os/extras': '1.0.0' })],
  ];
  for (const [label, edit] of cases) {
    const tree = replace(lockedVite(), 'package.json', editJson(edit));
    assert.ok(blocking(scopePinFindings(tree)).length >= 1, label);
  }
  // …and in a legacy tree too: only a plain version range is tolerated there.
  const legacy = replace(without(templateFiles('vite-os', 'App', SLUG), NPMRC_PATH), 'package.json', editJson((j) => (j.dependencies['@sovereign-os/ui'] = 'git+ssh://git@example.com/ui.git')));
  assert.equal(blocking(scopePinFindings(legacy)).length, 1);
});

test('DETECT · a lockfile that resolves the scope from a registry or from git blocks', () => {
  const fromRegistry = replace(lockedVite(), 'package-lock.json', editJson((j) => {
    j.packages['node_modules/@sovereign-os/ui'] = {
      version: '9.9.9',
      resolved: 'https://registry.npmjs.org/@sovereign-os/ui/-/ui-9.9.9.tgz',
      integrity: 'sha512-AAAA',
    };
  }));
  const a = blocking(scopePinFindings(fromRegistry));
  assert.equal(a.length, 1);
  assert.equal(a[0].path, 'package-lock.json');
  assert.match(a[0].detail, /registry\.npmjs\.org/);

  const fromGit = replace(lockedVite(), 'package-lock.json', editJson((j) => {
    j.packages['node_modules/@sovereign-os/app-sdk'] = { version: '0.1.0', resolved: 'git+ssh://git@github.com/someone/app-sdk.git#abc123' };
  }));
  assert.equal(blocking(scopePinFindings(fromGit)).length, 1);

  // A NESTED copy, and one with no source recorded at all, are caught the same way.
  const nested = replace(lockedVite(), 'package-lock.json', editJson((j) => {
    j.packages['node_modules/react/node_modules/@sovereign-os/ui'] = { version: '1.0.0' };
  }));
  assert.equal(blocking(scopePinFindings(nested)).length, 1);

  // npm lockfileVersion 1 and a yarn.lock naming a registry tarball.
  const v1: ScaffoldFile[] = [
    { path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 1, dependencies: { '@sovereign-os/ui': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@sovereign-os/ui/-/ui-1.0.0.tgz' } } }) },
  ];
  assert.equal(blocking(scopePinFindings(v1)).length, 1);
  const yarn: ScaffoldFile[] = [{ path: 'yarn.lock', content: '"@sovereign-os/ui@^1.0.0":\n  resolved "https://registry.yarnpkg.com/@sovereign-os/ui/-/ui-1.0.0.tgz#abc"\n' }];
  assert.equal(blocking(scopePinFindings(yarn)).length, 1);
});

test('DETECT · an .npmrc that points the scope at a real registry blocks; a second pin line does not', () => {
  const redirected = replace(lockedVite(), NPMRC_PATH, () => '@sovereign-os:registry=https://registry.npmjs.org/\n');
  const found = blocking(scopePinFindings(redirected));
  assert.equal(found.length, 1);
  assert.match(found[0].title, /pointed at a package registry/);
  // npm takes the LAST value: the pin followed by a redirect is still a redirect.
  const appended = replace(lockedVite(), NPMRC_PATH, (c) => c + '@sovereign-os:registry = "https://evil.example/"\n');
  assert.equal(blocking(scopePinFindings(appended)).length, 1);
  assert.deepEqual(scopePinFindings(replace(lockedVite(), NPMRC_PATH, (c) => c + SCOPE_PIN_LINE + '\n')), []);
});

// ------------------------------------------------- apps created before the pin existed --

test('EXISTING APP · a locked app without the .npmrc is NOT blocked: one info note names the file to add', () => {
  const tree = without(lockedVite(), NPMRC_PATH);
  const found = scopePinFindings(tree);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'info');
  assert.equal(found[0].path, NPMRC_PATH);
  assert.ok(found[0].detail.includes(SCOPE_PIN_LINE), 'the note carries the exact line');
  assert.equal(securityScan(tree, 'offline-mock').passed, true, 'the deploy gate is unaffected');
});

test('EXISTING APP · a pre-lockfile tree (registry range, no vendored folder) is reported, never blocked', () => {
  // Exactly what an app created before seeds were locked holds: `^0.1.0`, no vendor/, no .npmrc.
  const legacy = without(templateFiles('sovereign-app', 'App', SLUG), NPMRC_PATH);
  assert.match(legacy.find((f) => f.path === 'package.json')!.content, /"@sovereign-os\/ui": "\^0\.1\.0"/);
  const found = scopePinFindings(legacy);
  assert.deepEqual(blocking(found), []);
  const note = found.find((f) => f.path === NPMRC_PATH)!;
  assert.equal(note.severity, 'medium', 'the unpinned range is the exposed state: visible, not blocking');
  assert.match(note.detail, /public registry/);
  assert.equal(securityScan(legacy, 'offline-mock').passed, true);

  // Adding the one file closes it: the range can no longer reach a registry.
  const pinned = scopePinFindings([...legacy, scopePinNpmrc()]);
  assert.ok(pinned.length > 0 && pinned.every((f) => f.severity === 'info'));
  // The template fallback (what a declarative app's deploy is scanned over) is that pinned tree.
  assert.equal(securityScan(templateFiles('sovereign-app', 'App', SLUG), 'offline-mock').passed, true);
});

test('EXISTING APP · a tree that never mentions the scope gets no note at all', () => {
  assert.deepEqual(scopePinFindings(without(templateFiles('api-service', 'App', SLUG), NPMRC_PATH)), []);
  assert.deepEqual(scopePinFindings(without(templateFiles('nextjs-supabase', 'App', SLUG), NPMRC_PATH)), []);
});

// ------------------------------------------------------------------------- the push --

test('PUSH · the scope pin is the ONE .npmrc an app may push; anything more is still refused', () => {
  assert.doesNotThrow(() => assertPushable([scopePinNpmrc()]));
  assert.doesNotThrow(() => assertPushable([{ path: '.npmrc', content: SCOPE_PIN_LINE + '\n' }]));
  const refused = [
    '',
    '# only a comment\n',
    '//registry.npmjs.org/:_authToken=abc\n',
    SCOPE_PIN_LINE + '\n//registry.npmjs.org/:_authToken=abc\n',
    SCOPE_PIN_LINE + '\nregistry=https://mirror.example/\n',
    '@sovereign-os:registry=https://registry.npmjs.org/\n',
    SCOPE_PIN_LINE + '\n@sovereign-os:registry=https://evil.example/\n',
  ];
  for (const content of refused) {
    assert.throws(() => assertPushable([{ path: '.npmrc', content }]), /credential or registry file/, JSON.stringify(content));
  }
});
