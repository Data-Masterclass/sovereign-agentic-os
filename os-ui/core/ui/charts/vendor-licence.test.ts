/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The vendored-source licence-header ratchet (D2, D3, D4, D6)
 * USER STORY: As a maintainer I want to prove, in the test suite and not only by reading, that
 *             every line of third-party source in this repo keeps its upstream licence header,
 *             names where it came from down to the commit, and is recorded in the licence manifest
 *             — and that nothing is branded with the upstream product's name.
 * ARCHITECTURE:
 *   - Runs over `os-ui/vendor/**` on disk, so a new vendored file is covered the moment it lands
 *     (the same check is the hard `VENDOR-LICENCE-HEADER` rule in `scripts/check-structure.mjs`,
 *     which is what CI fails on; this is the in-suite twin).
 *   - Asserts the THREE obligations Apache-2.0 §4 puts on a derivative work: the upstream header
 *     verbatim (§4(a)/(c)), a prominent modification notice naming the file and the sha (§4(b)),
 *     and the upstream NOTICE still reproduced (§4(d)).
 *   - Also asserts the repo's own rules: the sha is pinned in `licenses/components.tsv` and
 *     `THIRD-PARTY-LICENSES.md`, `core/kernel/licenses.ts` names both ECharts and the vendored
 *     source, and `os-ui/vendor/**` is excluded from the FEATURE/USER STORY/ARCHITECTURE ratchet
 *     (ASF policy forbids rewriting a third-party header, so it could never satisfy it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO = join(UI, '..');
const VENDOR = join(UI, 'vendor');

/** The ASF header's opening sentence — it must survive verbatim in every vendored file. */
const ASF_HEADER = 'Licensed to the Apache Software Foundation (ASF) under one';

/** `Modified from <repo> <path…> @ <sha>` — the §4(b) prominent notice. */
const MODIFIED_FROM = /Modified from apache\/superset[\s\S]{0,2000}?@ ([0-9a-f]{40})/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|py)$/.test(p)) out.push(p);
  }
  return out;
}

const files = sourceFiles(VENDOR);

test('there is vendored source to check (the ratchet is not vacuously green)', () => {
  assert.ok(files.length > 0, 'os-ui/vendor/** holds no source files — remove this ratchet or the tree');
});

test('every vendored file keeps its upstream licence header verbatim', () => {
  for (const f of files) {
    const head = readFileSync(f, 'utf8').slice(0, 4000);
    assert.ok(
      head.includes(ASF_HEADER),
      `${relative(REPO, f)}: the upstream ASF licence header is missing or was rewritten — it must be kept VERBATIM`,
    );
  }
});

test('every vendored file names its upstream path and a 40-char commit sha', () => {
  for (const f of files) {
    const head = readFileSync(f, 'utf8').slice(0, 4000);
    assert.match(
      head,
      MODIFIED_FROM,
      `${relative(REPO, f)}: missing the \`Modified from apache/superset <path> @ <sha>\` notice (Apache-2.0 §4(b))`,
    );
  }
});

test('every vendored file lists the changes made and carries an SPDX id', () => {
  for (const f of files) {
    const head = readFileSync(f, 'utf8').slice(0, 4000);
    const rel = relative(REPO, f);
    assert.ok(/Changes:/.test(head), `${rel}: the modification notice must list the changes made`);
    assert.ok(/SPDX-License-Identifier: Apache-2\.0/.test(head), `${rel}: missing the SPDX-License-Identifier line`);
  }
});

test('all vendored files pin the SAME upstream sha, and the manifests pin it too', () => {
  const shas = new Set<string>();
  for (const f of files) {
    const m = MODIFIED_FROM.exec(readFileSync(f, 'utf8').slice(0, 4000));
    if (m) shas.add(m[1]);
  }
  assert.equal(shas.size, 1, `the vendored tree pins more than one upstream sha: ${[...shas].join(', ')}`);
  const sha = [...shas][0];

  const tsv = readFileSync(join(REPO, 'licenses/components.tsv'), 'utf8');
  assert.ok(tsv.includes('Apache Superset (vendored source)'), 'licenses/components.tsv has no vendored-source row');
  assert.ok(tsv.includes(sha), `licenses/components.tsv must pin the vendored sha ${sha}, not a version`);

  const third = readFileSync(join(REPO, 'THIRD-PARTY-LICENSES.md'), 'utf8');
  assert.ok(third.includes(sha), `THIRD-PARTY-LICENSES.md must mirror the vendored sha ${sha}`);

  const notice = readFileSync(join(REPO, 'NOTICE'), 'utf8');
  assert.ok(
    notice.includes('os-ui/vendor/superset'),
    'NOTICE must say that portions of the product are derived from Apache Superset source',
  );
  // Apache-2.0 §4(d): the upstream NOTICE stays reproduced for a derivative work too.
  assert.ok(
    existsSync(join(REPO, 'licenses/notices/Apache-Superset-NOTICE.txt')),
    'licenses/notices/Apache-Superset-NOTICE.txt must stay in the tree (Apache-2.0 §4(d))',
  );
});

test('the in-product licence list names Apache ECharts and the vendored Superset source', async () => {
  const { COMPONENTS } = await import('@core/kernel/licenses');
  const names = COMPONENTS.map((c) => c.name);
  const echarts = COMPONENTS.find((c) => /ECharts/i.test(c.name));
  assert.ok(echarts, `core/kernel/licenses.ts lacks an Apache ECharts row (it ships in the UI today): ${names.join(', ')}`);
  assert.equal(echarts!.license, 'Apache-2.0');
  const vendored = COMPONENTS.find((c) => /Superset/i.test(c.name));
  assert.ok(vendored, 'core/kernel/licenses.ts lacks the vendored Apache Superset row');
  assert.equal(vendored!.license, 'Apache-2.0');
  assert.match(vendored!.note, /derived|vendored/i, 'the Superset row must say the source is derived/vendored, not bundled');
});

test('os-ui/vendor is excluded from the FEATURE/USER STORY/ARCHITECTURE ratchet and in the licence one', () => {
  const src = readFileSync(join(REPO, 'scripts/check-structure.mjs'), 'utf8');
  assert.ok(src.includes('VENDOR-LICENCE-HEADER'), 'check-structure.mjs must carry the VENDOR-LICENCE-HEADER rule');
  assert.ok(
    /VENDOR_EXCLUDED_FROM_HEADER_RULE|vendor/i.test(src),
    'check-structure.mjs must name the os-ui/vendor exclusion explicitly',
  );
  // The header rule walks core/, tabs/ and worker/ only — vendor/ is not among them.
  const headerRule = src.slice(src.indexOf("const SECTIONS = ['FEATURE:'"));
  assert.ok(
    !/walk\(join\(UI, 'vendor'\)\)/.test(headerRule.slice(0, 600)),
    'the FEATURE/USER STORY/ARCHITECTURE rule must not walk os-ui/vendor',
  );
});

test('nothing in the product is branded "Superset"', () => {
  // A route, a package name or a logo would be a trademark problem; a prose attribution is not.
  const pkg = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
  assert.ok(!/superset/i.test(pkg.name), 'the package name must not contain "superset"');
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(!/superset/i.test(dep), `${dep}: never depend on an @superset-ui/* package (React 16 peers, frozen 2024-12-10)`);
  }
  const appDir = join(UI, 'app');
  const routes = sourceFiles(appDir).map((f) => relative(UI, f));
  for (const r of routes) {
    assert.ok(!/superset/i.test(r), `${r}: a route path must never be branded "superset"`);
  }
});
