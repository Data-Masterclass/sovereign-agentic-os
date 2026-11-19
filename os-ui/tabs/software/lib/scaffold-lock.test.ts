/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    Locked seeds — the DRIFT test for the scaffold lockfiles
 * USER STORY: As a maintainer who bumps a scaffold dependency I want the build to fail until the
 *             lockfile is regenerated, so a generated app never ships a lock that describes a
 *             different manifest than the one beside it.
 * ARCHITECTURE: Offline. The committed lockfiles are npm's own output
 *             (`scripts/regen-scaffold-locks.mjs`); this file holds every scaffold manifest to
 *             them through the SAME predicate the live scanner uses (`lockfile-evidence.ts`), and
 *             pins the seed shape, the licence picture, the scan outcome and the unchanged
 *             behaviour of apps created before lockfiles shipped.
 *
 *             WHAT THIS CANNOT PROVE: that the pinned versions are still what the registry would
 *             resolve today, or that Trivy itself emits a `lang-pkgs` result for these files — no
 *             Trivy binary runs here. The report fixtures below follow Trivy v0.58.2's source
 *             (`pkg/scanner/langpkg/scan.go`: one `lang-pkgs` result per lockfile with packages,
 *             `Target` = the lockfile path, and NO result for a lockfile with none).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCK_PATH,
  LOCK_PLACEHOLDER_NAME,
  committedLock,
  lockFamilyOf,
  lockInputs,
  lockedSeed,
  lockfileFor,
  type LockFamily,
} from './scaffold-lock.ts';
import { compareManifestToLock, npmLockEvidence } from './lockfile-evidence.ts';
import { VENDORED_SDK_DEP, VENDORED_UI_DEP, viteBaseFiles } from './scaffolds/vite-os.ts';
import { apiServiceFiles } from './scaffolds/api-service.ts';
import { applyUiFileDep } from './app-ui-vendor.ts';
import { applySdkFileDep } from './app-sdk-vendor.ts';
import { pathRefusal } from './builder/prompts.ts';
import type { AppTemplateKey } from './apps.ts';
import type { ScaffoldFile } from './model.ts';

const { templateFiles } = await import('./apps.ts');
const { mapTrivyReport, writerScript, DEFAULT_MAX_PAYLOAD } = await import('./scan-trivy.ts');
const { securityScan } = await import('./scan.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const SLUG = 'orders-app';

const ALL_TEMPLATES: AppTemplateKey[] = [
  'nextjs-supabase',
  'service',
  'script',
  'dashboard',
  'vite-os',
  'sovereign-app',
  'website',
  'api-service',
  'empty',
];
const LOCKED_TEMPLATES = ALL_TEMPLATES.filter((t) => lockFamilyOf(t) !== null);

/**
 * Templates that emit a `package.json` and deliberately ship NO lockfile. Every entry needs a
 * reason; a new template with a manifest fails the first test until it is locked or listed here.
 */
const UNLOCKED_ON_PURPOSE: Partial<Record<AppTemplateKey, string>> = {
  'nextjs-supabase':
    'legacy, not offered for new apps; `next` resolves sharp/libvips binaries under LGPL-3.0, outside the scaffold licence rule',
  // The three generic legacy templates reuse the nextjs-supabase file set verbatim.
  service: 'legacy, not offered for new apps; same file set (and same reason) as nextjs-supabase',
  script: 'legacy, not offered for new apps; same file set (and same reason) as nextjs-supabase',
  dashboard: 'legacy, not offered for new apps; same file set (and same reason) as nextjs-supabase',
};

const PLAIN: Record<LockFamily, (slug: string) => ScaffoldFile[]> = {
  vite: (slug) => viteBaseFiles('App', slug),
  'api-service': (slug) => apiServiceFiles('App', slug),
};
const FAMILIES: LockFamily[] = ['vite', 'api-service'];

const manifestOf = (files: ScaffoldFile[]): Record<string, unknown> =>
  JSON.parse(files.find((f) => f.path === 'package.json')!.content) as Record<string, unknown>;

/** What Trivy returns for a tree whose one lockfile resolves packages and has no known vuln. */
const TRIVY_RESOLVED = JSON.stringify({
  SchemaVersion: 2,
  Results: [{ Target: LOCK_PATH, Class: 'lang-pkgs', Type: 'npm' }],
});
/** What Trivy returns when no lockfile resolved any package. */
const TRIVY_NOTHING = JSON.stringify({ SchemaVersion: 2, Results: [] });

// ------------------------------------------------------------------ which templates --

test('every template that emits a package.json is either LOCKED or unlocked for a stated reason', () => {
  for (const t of ALL_TEMPLATES) {
    const emitsManifest = templateFiles(t, 'App', SLUG).some((f) => f.path === 'package.json');
    const family = lockFamilyOf(t);
    if (!emitsManifest) {
      assert.equal(family, null, `${t} emits no package.json, so it must not claim a lockfile`);
      continue;
    }
    assert.ok(
      family !== null || UNLOCKED_ON_PURPOSE[t],
      `template '${t}' emits a package.json but has no lockfile and no stated reason — lock it ` +
        `(scaffold-lock.ts + scripts/regen-scaffold-locks.mjs) or add it to UNLOCKED_ON_PURPOSE`,
    );
  }
  assert.deepEqual(LOCKED_TEMPLATES.sort(), ['api-service', 'empty', 'sovereign-app', 'vite-os', 'website']);
});

// ----------------------------------------------------------------------------- drift --

for (const family of FAMILIES) {
  test(`DRIFT · ${family}: the manifest the seed emits matches the committed lockfile's root entry`, () => {
    const inputs = lockInputs(family, PLAIN[family](LOCK_PLACEHOLDER_NAME));
    const problems = compareManifestToLock(manifestOf(inputs), committedLock(family));
    assert.deepEqual(
      problems,
      [],
      `the '${family}' scaffold manifest and its committed lockfile have drifted apart. Run ` +
        '`node --experimental-strip-types os-ui/scripts/regen-scaffold-locks.mjs` and commit the result.',
    );
  });

  test(`DRIFT · ${family}: every manifest in the lock inputs (vendored packages included) is consistent`, () => {
    const inputs = lockInputs(family, PLAIN[family](LOCK_PLACEHOLDER_NAME));
    const lock = { path: LOCK_PATH, content: JSON.stringify(committedLock(family)) };
    const ev = npmLockEvidence([...inputs, lock]);
    assert.equal(ev.length, inputs.length);
    for (const e of ev) assert.equal(e.state, 'consistent', `${e.manifest}: ${e.problems.join('; ')}`);
  });

  test(`DRIFT · ${family}: the committed file is npm's serialisation, byte for byte, under the placeholder name`, () => {
    const onDisk = readFileSync(join(HERE, 'scaffolds', 'locks', `${family}.package-lock.json`), 'utf8');
    assert.equal(JSON.stringify(committedLock(family), null, 2) + '\n', onDisk);
    const lock = committedLock(family) as { name: string; lockfileVersion: number; packages: Record<string, { name?: string }> };
    assert.equal(lock.name, LOCK_PLACEHOLDER_NAME);
    assert.equal(lock.packages[''].name, LOCK_PLACEHOLDER_NAME);
    assert.equal(lock.lockfileVersion, 3);
  });

  test(`SEED · ${family}: the seeded lockfile differs from the committed one in the two name fields ONLY`, () => {
    const seeded = JSON.parse(lockfileFor(family, SLUG).content) as { name: string; packages: Record<string, { name?: string }> };
    assert.equal(seeded.name, SLUG);
    assert.equal(seeded.packages[''].name, SLUG);
    seeded.name = LOCK_PLACEHOLDER_NAME;
    seeded.packages[''].name = LOCK_PLACEHOLDER_NAME;
    assert.deepEqual(seeded, committedLock(family));
  });
}

test('DRIFT · the test bites: a bumped scaffold range without a regenerated lock is reported', () => {
  const manifest = manifestOf(lockInputs('vite', PLAIN.vite(LOCK_PLACEHOLDER_NAME))) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies.react = '^19.0.0';
  const problems = compareManifestToLock(manifest, committedLock('vite'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"react" is \^19\.0\.0 in package\.json but \^18\.3\.1 in the lockfile/);
});

test('the regeneration script resolves under the same placeholder name', () => {
  const script = readFileSync(join(HERE, '..', '..', '..', 'scripts', 'regen-scaffold-locks.mjs'), 'utf8');
  assert.ok(script.includes(`const SLUG = '${LOCK_PLACEHOLDER_NAME}';`));
});

// --------------------------------------------------------------------------- licences --

/** The scaffold licence rule: Apache-2.0 / MIT / BSD / ISC. */
const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD']);
/**
 * Transitive packages OUTSIDE that rule, named one by one so a new one fails this test instead
 * of arriving quietly. `caniuse-lite` is browser-support DATA under CC-BY-4.0, pulled in by
 * `autoprefixer` / `browserslist` (build-time only). It was already a transitive dependency of
 * every Vite scaffold before lockfiles shipped; the lockfile makes it visible, it did not add it.
 */
const LICENCE_EXCEPTIONS: Record<string, string> = { 'node_modules/caniuse-lite': 'CC-BY-4.0' };

test('LICENCES · every package the committed lockfiles resolve is permissive, bar named exceptions', () => {
  for (const family of FAMILIES) {
    const packages = (committedLock(family) as { packages: Record<string, { license?: string; link?: boolean }> }).packages;
    const seenExceptions = new Set<string>();
    for (const [path, pkg] of Object.entries(packages)) {
      if (path === '' || pkg.link === true) continue;
      if (path in LICENCE_EXCEPTIONS) {
        assert.equal(pkg.license, LICENCE_EXCEPTIONS[path], `${path}: the recorded exception no longer matches`);
        seenExceptions.add(path);
        continue;
      }
      assert.ok(
        typeof pkg.license === 'string' && PERMISSIVE.has(pkg.license),
        `${family}: ${path} is licensed "${pkg.license ?? '(none recorded)'}" — outside Apache-2.0/MIT/BSD/ISC. ` +
          'Do not hide it: remove the dependency or record it in LICENCE_EXCEPTIONS with the reason.',
      );
    }
    if (family === 'vite') {
      assert.deepEqual([...seenExceptions], Object.keys(LICENCE_EXCEPTIONS), 'a stale exception must be removed');
    }
  }
});

// ------------------------------------------------------------------------ seed shape --

test('SEED · the Vite manifest points at the vendored OS packages exactly as the vendor helpers would', () => {
  const plain = PLAIN.vite(SLUG).find((f) => f.path === 'package.json')!.content;
  const locked = lockedSeed('sovereign-app', PLAIN.vite(SLUG), SLUG).find((f) => f.path === 'package.json')!.content;
  assert.equal(locked, applyUiFileDep(applySdkFileDep(plain)));
  const deps = (JSON.parse(locked) as { dependencies: Record<string, string> }).dependencies;
  assert.equal(deps['@sovereign-os/ui'], VENDORED_UI_DEP);
  assert.equal(deps['@sovereign-os/app-sdk'], VENDORED_SDK_DEP);
});

for (const template of LOCKED_TEMPLATES) {
  test(`SEED · ${template}: a new app's tree carries a lockfile that agrees with every manifest in it`, () => {
    const seed = lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG);
    assert.equal(seed.filter((f) => f.path === LOCK_PATH).length, 1);
    assert.equal(new Set(seed.map((f) => f.path)).size, seed.length, 'no path is seeded twice');
    const ev = npmLockEvidence(seed);
    assert.ok(ev.length > 0);
    for (const e of ev) assert.equal(e.state, 'consistent', `${e.manifest}: ${e.problems.join('; ')}`);
    assert.equal(manifestOf(seed).name, SLUG);
  });

  test(`SCAN · ${template}: a freshly seeded app has its dependencies COVERED when the engine runs`, () => {
    const seed = lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG);
    // The Vite lock resolves packages, so Trivy returns a result for it; the zero-dependency API
    // service lock resolves none, so Trivy returns nothing — and that is the right answer there.
    const report = lockFamilyOf(template) === 'vite' ? TRIVY_RESOLVED : TRIVY_NOTHING;
    const r = mapTrivyReport(report, seed);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.notRun, ['sast'], r.reason);
    assert.equal(r.passed, true);
    assert.equal(r.reason, undefined);
  });

  test(`SCAN · ${template}: an app created BEFORE lockfiles shipped is still "deps not covered"`, () => {
    // `templateFiles` is the fallback tree for an app with no snapshot, and it stays PLAIN.
    const legacy = templateFiles(template, 'App', SLUG);
    assert.equal(legacy.some((f) => f.path === LOCK_PATH), false);
    assert.equal(legacy.some((f) => f.path.startsWith('vendor/')), false);
    const r = mapTrivyReport(TRIVY_NOTHING, legacy);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.notRun.includes('deps'));
    assert.equal(r.passed, false);
    assert.match(r.reason ?? '', /there is no lockfile/);
  });
}

test('SEED · a locked Vite Dockerfile copies the vendored tree in BEFORE the install; the plain one is unchanged', () => {
  const lines = lockedSeed('sovereign-app', templateFiles('sovereign-app', 'App', SLUG), SLUG)
    .find((f) => f.path === 'Dockerfile')!
    .content.split('\n');
  const copy = lines.indexOf('COPY vendor ./vendor');
  const install = lines.findIndex((l) => l.includes('npm ci'));
  assert.ok(copy > 0 && install > copy, 'COPY vendor must precede npm ci');
  const plain = templateFiles('sovereign-app', 'App', SLUG).find((f) => f.path === 'Dockerfile')!.content;
  assert.equal(plain.includes('COPY vendor'), false);
});

test('SEED · a template with no lock family is returned untouched', () => {
  const plain = templateFiles('nextjs-supabase', 'App', SLUG);
  assert.equal(lockedSeed('nextjs-supabase', plain, SLUG), plain);
});

// ---------------------------------------------------------------------- staleness --

test('STALE · a package.json changed without a new lockfile is NOT covered, and the remedy is named', () => {
  const seed = lockedSeed('sovereign-app', templateFiles('sovereign-app', 'App', SLUG), SLUG);
  const manifest = manifestOf(seed) as { dependencies: Record<string, string> };
  manifest.dependencies.lodash = '4.17.20';
  const pushed = seed.map((f) => (f.path === 'package.json' ? { ...f, content: JSON.stringify(manifest, null, 2) + '\n' } : f));
  // Trivy reads only the lockfile, so it reports exactly what it reported before the edit.
  const r = mapTrivyReport(TRIVY_RESOLVED, pushed);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.notRun.includes('deps'), 'a stale lockfile must not count as dependency coverage');
  assert.equal(r.passed, false);
  assert.match(r.reason ?? '', /lockfile does not match the manifest/);
  assert.match(r.reason ?? '', /lodash/);
  assert.match(r.reason ?? '', /npm install --package-lock-only/);
  assert.match(r.reason ?? '', /commit the new package-lock\.json/);
});

test('STALE · a vendored package whose manifest moved on makes the ROOT lock stale too', () => {
  const seed = lockedSeed('sovereign-app', templateFiles('sovereign-app', 'App', SLUG), SLUG);
  const pushed = seed.map((f) =>
    f.path === 'vendor/@sovereign-os/ui/package.json' ? { ...f, content: f.content.replace('"0.1.0"', '"0.2.0"') } : f,
  );
  const r = mapTrivyReport(TRIVY_RESOLVED, pushed);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.notRun.includes('deps'));
  assert.match(r.reason ?? '', /vendor\/@sovereign-os\/ui\/package\.json/);
});

test('STALE · the regenerated lockfile restores coverage', () => {
  const seed = lockedSeed('api-service', templateFiles('api-service', 'App', SLUG), SLUG);
  const manifest = { ...manifestOf(seed), dependencies: { ms: '^2.1.3' } };
  const lock = {
    name: SLUG,
    version: '0.0.0',
    lockfileVersion: 3,
    packages: { '': { name: SLUG, version: '0.0.0', dependencies: { ms: '^2.1.3' } }, 'node_modules/ms': { version: '2.1.3' } },
  };
  const pushed = seed.map((f) =>
    f.path === 'package.json'
      ? { ...f, content: JSON.stringify(manifest) }
      : f.path === LOCK_PATH
        ? { ...f, content: JSON.stringify(lock) }
        : f,
  );
  const r = mapTrivyReport(TRIVY_RESOLVED, pushed);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.notRun, ['sast']);
  // …and a lock that resolves packages the engine returned NOTHING for is not coverage either.
  const silent = mapTrivyReport(TRIVY_NOTHING, pushed);
  assert.equal(silent.ok, true);
  if (!silent.ok) return;
  assert.ok(silent.notRun.includes('deps'));
});

test('PARTIAL · one resolved lockfile does not cover a second manifest that has none', () => {
  const seed = lockedSeed('sovereign-app', templateFiles('sovereign-app', 'App', SLUG), SLUG);
  const tree = [...seed, { path: 'functions/package.json', content: JSON.stringify({ name: 'fn', dependencies: { ms: '^2.1.3' } }) }];
  const r = mapTrivyReport(TRIVY_RESOLVED, tree);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.notRun.includes('deps'));
  assert.match(r.reason ?? '', /only PARTLY covered/);
  assert.match(r.reason ?? '', /functions\/package\.json/);
});

// -------------------------------------------------------------- what else it touches --

test('the largest locked seed fits one scan payload with room for the app that grows in it', () => {
  const seed = lockedSeed('sovereign-app', templateFiles('sovereign-app', 'App', SLUG), SLUG);
  const w = writerScript(seed);
  assert.equal(w.ok, true, w.ok ? '' : w.reason);
  if (!w.ok) return;
  // No quote can appear in a path, so a path can never end the single-quoted word it sits in.
  for (const f of seed) assert.equal(f.path.includes("'"), false);
  // The lockfile and the vendored tree are not free: they spend scan payload the app's own source
  // then cannot use. Half the ceiling is the line — past it, regenerating a bigger lock deserves a
  // deliberate look at DEFAULT_MAX_PAYLOAD rather than a surprise `scan-failed` on a grown app.
  assert.ok(w.bytes < DEFAULT_MAX_PAYLOAD / 2, `seed payload is ${w.bytes} bytes of ${DEFAULT_MAX_PAYLOAD}`);
});

test('the offline baseline finds nothing blocking in a locked seed (lockfile hashes and vendored source included)', () => {
  for (const template of LOCKED_TEMPLATES) {
    const seed = lockedSeed(template, templateFiles(template, 'App', SLUG), SLUG);
    const r = securityScan(seed, 'offline-mock');
    const blocking = r.findings.filter((f) => f.category === 'secrets' || f.severity === 'high' || f.severity === 'critical');
    assert.deepEqual(blocking, [], `${template}: ${JSON.stringify(blocking)}`);
    assert.equal(r.passed, true);
  }
});

test('the agentic builder may not write a lockfile anywhere — a model cannot resolve dependencies', () => {
  for (const p of ['package-lock.json', 'src/package-lock.json', 'src/yarn.lock', 'public/pnpm-lock.yaml', 'src/api/go.sum']) {
    assert.match(pathRefusal(p) ?? '', /lockfile|outside src/, p);
    assert.notEqual(pathRefusal(p), null, p);
  }
  assert.match(pathRefusal('src/package-lock.json') ?? '', /output of a real install/);
  assert.equal(pathRefusal('src/lock.ts'), null, 'an ordinary source file is still writable');
});
