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

test('PIN · the Dockerfiles that run an install REQUIRE the app\'s .npmrc (the pin) before it, and never name the scope', () => {
  for (const template of ['vite-os', 'sovereign-app', 'website', 'empty', 'nextjs-supabase'] as AppTemplateKey[]) {
    for (const tree of [templateFiles(template, 'App', SLUG), lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG)]) {
      const text = tree.find((f) => f.path === 'Dockerfile')!.content;
      const lines = text.split('\n');
      const install = lines.findIndex((l) => /^RUN .*npm (ci|install)/.test(l));
      assert.ok(install >= 0, `${template}: has an install step`);
      // A plain `.npmrc` (no glob): the build fails without the pin instead of installing unpinned.
      const copy = lines.findIndex((l) => /^COPY /.test(l) && l.split(/\s+/).includes('.npmrc'));
      assert.ok(copy >= 0 && copy < install, `${template}: the .npmrc is copied, required, before the install`);
      assert.ok(tree.some((f) => f.path === '.npmrc' && hasScopePin(f.content)), `${template}: the tree carries the pin`);
      assert.doesNotMatch(text, /sovereign-os/i, `${template}: the Dockerfile never names the scope (the scan flags any mention)`);
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

// ------------------------------------------------------------ follow-ups (overrides, Dockerfile, nested .npmrc) --

test('DETECT · `overrides` / `resolutions` / `pnpm.overrides` that send the scope to a registry block; file: overrides pass', () => {
  const cases: [string, (j: any) => void][] = [
    ['npm overrides, direct', (j) => { j.overrides = { '@sovereign-os/ui': '1.0.0' }; }],
    ['npm overrides, nested under a parent', (j) => { j.overrides = { 'some-lib': { '@sovereign-os/app-sdk': '^2.0.0' } }; }],
    ['npm overrides, an alias onto the scope', (j) => { j.overrides = { 'left-pad': 'npm:@sovereign-os/ui@1' }; }],
    ['yarn resolutions, a path selector', (j) => { j.resolutions = { 'some-lib/@sovereign-os/ui': '1.0.0' }; }],
    ['pnpm overrides, a parent>child selector', (j) => { j.pnpm = { overrides: { 'some-lib>@sovereign-os/ui': 'https://evil.example/ui.tgz' } }; }],
  ];
  for (const [label, edit] of cases) {
    const found = blocking(scopePinFindings(replace(lockedVite(), 'package.json', editJson(edit))));
    assert.equal(found.length, 1, label);
    assert.match(found[0].detail, /overrides|resolutions/, label);
  }
  // twin: an override that keeps the scope on the vendored folder is fine, as is one on another package.
  const ok = replace(lockedVite(), 'package.json', editJson((j) => { j.overrides = { '@sovereign-os/ui': 'file:./vendor/@sovereign-os/ui', 'left-pad': '1.3.0' }; }));
  assert.deepEqual(blocking(scopePinFindings(ok)), []);
});

test('DETECT · a Dockerfile that installs the scope by name, or points it at a registry, blocks; the scaffold Dockerfiles pass', () => {
  const dockerfile = (tree: ScaffoldFile[]) => tree.find((f) => f.path === 'Dockerfile')!.content;
  const bad = [
    'RUN npm install @sovereign-os/ui@latest',
    'RUN npm i -g @sovereign-os/app-sdk',
    'RUN yarn add @sovereign-os/ui',
    'RUN pnpm add @sovereign-os/ui',
    'RUN npm ci --@sovereign-os:registry=https://registry.npmjs.org/',
    'RUN npm config set @sovereign-os:registry https://registry.npmjs.org/',
    'ENV npm_config_@sovereign-os:registry=https://registry.npmjs.org/',
  ];
  for (const line of bad) {
    const tree = replace(lockedVite(), 'Dockerfile', (c) => `${c.trimEnd()}\n${line}\n`);
    const found = blocking(scopePinFindings(tree));
    assert.equal(found.length, 1, line);
    assert.equal(found[0].path, 'Dockerfile', line);
  }
  // twins: every scaffold Dockerfile (they set the pin themselves) is clean, and an unrelated install is fine.
  for (const template of ALL_TEMPLATES) {
    const tree = lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG);
    assert.deepEqual(blocking(scopePinFindings(tree)), [], template);
  }
  const unrelated = replace(lockedVite(), 'Dockerfile', (c) => `${c.trimEnd()}\nRUN npm install -g serve@14.2.4\n`);
  assert.deepEqual(blocking(scopePinFindings(unrelated)), []);
  assert.ok(dockerfile(lockedVite()).length > 0);
});

test('PUSH · an .npmrc anywhere below the root is refused, even the pin; the root pin is still accepted', () => {
  for (const path of ['sub/.npmrc', 'packages/a/.npmrc', 'src/.NPMRC']) {
    assert.throws(() => assertPushable([{ path, content: SCOPE_PIN_LINE + '\n' }]), /\.npmrc/i, path);
    assert.throws(() => assertPushable([{ path, content: '//registry.npmjs.org/:_authToken=abc\n' }]), /\.npmrc/i, path);
  }
  // twin
  assert.doesNotThrow(() => assertPushable([{ path: '.npmrc', content: SCOPE_PIN_LINE + '\n' }]));
});

// -------------------------------------------- follow-ups 2: tools that do not read .npmrc (Yarn Berry, Bun) --

const YARNRC_SCOPE = 'npmScopes:\n  sovereign-os:\n    npmRegistryServer: "https://registry.example/"\n';
const BUNFIG_SCOPES = [
  '[install.scopes]\n"@sovereign-os" = "https://registry.example/"\n',
  '[install.scopes]\nsovereign-os = { url = "https://registry.example/" }\n',
  '[install.scopes."@sovereign-os"]\nurl = "https://registry.example/"\n',
  '[install]\nscopes = { "@sovereign-os" = "https://registry.example/" }\n',
];

test('DETECT · a .yarnrc.yml npmScopes entry or a bunfig.toml install.scopes entry for the scope blocks (they ignore .npmrc)', () => {
  for (const [path, content] of [['.yarnrc.yml', YARNRC_SCOPE], ['web/.yarnrc.yml', YARNRC_SCOPE.replace('sovereign-os:', '"@sovereign-os":')], ...BUNFIG_SCOPES.map((c) => ['bunfig.toml', c])]) {
    const found = blocking(scopePinFindings([...lockedVite(), { path, content }]));
    assert.equal(found.length, 1, `${path}: ${content}`);
    assert.equal(found[0].path, path);
  }
  // twins: the same files with no scope registry at all are clean.
  const other = [
    { path: '.yarnrc.yml', content: 'nodeLinker: node-modules\n' },
    { path: 'bunfig.toml', content: '[install]\nfrozenLockfile = true\n' },
  ];
  assert.deepEqual(blocking(scopePinFindings([...lockedVite(), ...other])), []);
});

test('PUSH · a .yarnrc.yml or bunfig.toml that configures the scope is refused; one without scope registries is accepted', () => {
  assert.throws(() => assertPushable([{ path: '.yarnrc.yml', content: YARNRC_SCOPE }]), /@sovereign-os/);
  for (const content of BUNFIG_SCOPES) assert.throws(() => assertPushable([{ path: 'bunfig.toml', content }]), /@sovereign-os/, content);
  assert.throws(() => assertPushable([{ path: '.yarnrc.yml', content: 'npmScopes: [not: valid' }]), /could not be read/);
  // twins
  assert.doesNotThrow(() => assertPushable([{ path: '.yarnrc.yml', content: 'nodeLinker: node-modules\n' }]));
  assert.doesNotThrow(() => assertPushable([{ path: 'bunfig.toml', content: '[install]\nfrozenLockfile = true\n' }]));
});

test('DETECT · bun add, bunx and pnpx of the scope in a Dockerfile block; so do scope installs in package.json scripts', () => {
  for (const line of ['RUN bun add @sovereign-os/ui', 'RUN bunx @sovereign-os/cli', 'RUN pnpx @sovereign-os/cli', 'RUN npx -y @sovereign-os/cli', 'RUN yarn dlx @sovereign-os/cli']) {
    const tree = replace(lockedVite(), 'Dockerfile', (c) => `${c.trimEnd()}\n${line}\n`);
    assert.equal(blocking(scopePinFindings(tree)).length, 1, line);
  }
  for (const script of ['yarn dlx @sovereign-os/cli init', 'bunx @sovereign-os/cli', 'npx -y @sovereign-os/cli', 'pnpx @sovereign-os/cli', 'bun add @sovereign-os/ui', 'npm i @sovereign-os/ui@latest']) {
    const tree = replace(lockedVite(), 'package.json', editJson((j) => { j.scripts = { ...(j.scripts ?? {}), setup: script }; }));
    const found = blocking(scopePinFindings(tree));
    assert.equal(found.length, 1, script);
    assert.match(found[0].detail, /scripts/, script);
  }
  // twins: the scaffold scripts and an unrelated bunx are clean.
  assert.deepEqual(blocking(scopePinFindings(lockedVite())), []);
  const unrelated = replace(lockedVite(), 'package.json', editJson((j) => { j.scripts = { ...(j.scripts ?? {}), fmt: 'bunx prettier@3.3.3 --write .' }; }));
  assert.deepEqual(blocking(scopePinFindings(unrelated)), []);
});

// ----------------------------------- follow-ups 3: parse the config files for real; any scope mention in a Dockerfile --

test('SCOPE CONFIG · any scope registry in bunfig.toml, .yarnrc or .yarnrc.yml is refused (scan and push) — parsed, not matched', () => {
  const refused: [string, string][] = [
    // bunfig.toml (TOML: dotted keys, quoted keys with escapes, any scope)
    ['bunfig.toml', '[install]\nscopes."@sovereign-os" = "https://registry.example/"\n'],
    ['bunfig.toml', 'install.scopes."@sovereign-os" = "https://registry.example/"\n'],
    ['bunfig.toml', '[install]\n"sc\\u006fpes" = { "@x" = "https://registry.example/" }\n'],
    ['bunfig.toml', '[install.scopes]\n"@acme" = "https://npm.acme.example/"\n'],
    // Yarn 1 .yarnrc
    ['.yarnrc', '"@sovereign-os:registry" "https://registry.example/"\n'],
    ['.yarnrc', '@acme:registry https://npm.acme.example/\n'],
    ['web/.yarnrc', '"@sovereign-os:regis\\u0074ry" "https://registry.example/"\n'],
    // Yarn Berry .yarnrc.yml, any scope
    ['.yarnrc.yml', 'npmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.example/"\n'],
  ];
  for (const [path, content] of refused) {
    assert.equal(blocking(scopePinFindings([...lockedVite(), { path, content }])).length, 1, `scan: ${path}: ${content}`);
    assert.throws(() => assertPushable([{ path, content }]), /scope registr|could not be read/, `push: ${path}: ${content}`);
  }
  // Files that cannot be parsed are refused as unreadable.
  for (const [path, content] of [['bunfig.toml', '[install\nscopes = '], ['.yarnrc', '"unterminated value\n']] as const) {
    assert.throws(() => assertPushable([{ path, content }]), /could not be read/, path);
    assert.equal(blocking(scopePinFindings([...lockedVite(), { path, content }])).length, 1, path);
  }
  // twins: the same files without any scope registry are accepted and clean.
  const fine: [string, string][] = [
    ['bunfig.toml', '[install]\nfrozenLockfile = true\n# scopes are not configured here\n'],
    ['.yarnrc', '--install.frozen-lockfile true\nnetwork-timeout 600000\n'],
    ['.yarnrc.yml', 'nodeLinker: node-modules\n'],
  ];
  for (const [path, content] of fine) {
    assert.doesNotThrow(() => assertPushable([{ path, content }]), path);
    assert.deepEqual(blocking(scopePinFindings([...lockedVite(), { path, content }])), [], path);
  }
});

test('DOCKERFILE · any mention of the scope blocks, including an ARG/ENV value used later, and a URL-encoded one', () => {
  const bad = [
    'ARG P=@sovereign-os/ui\nRUN bun add $P',
    'ENV S=@sovereign-os\nRUN npm i $S/ui',
    'RUN npm install https://registry.example/%40sovereign-os%2fui/-/ui-1.0.0.tgz',
    'LABEL x="@Sovereign-OS/ui"',
  ];
  for (const extra of bad) {
    const tree = replace(lockedVite(), 'Dockerfile', (c) => `${c.trimEnd()}\n${extra}\n`);
    const found = blocking(scopePinFindings(tree));
    assert.equal(found.length, 1, extra);
    assert.equal(found[0].path, 'Dockerfile', extra);
  }
  // twins: every scaffold Dockerfile is clean, and so is an unrelated ARG/ENV.
  for (const template of ALL_TEMPLATES) {
    assert.deepEqual(blocking(scopePinFindings(lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG))), [], template);
  }
  const unrelated = replace(lockedVite(), 'Dockerfile', (c) => `${c.trimEnd()}\nARG P=serve@14.2.4\nRUN npm install -g $P\n`);
  assert.deepEqual(blocking(scopePinFindings(unrelated)), []);
});
