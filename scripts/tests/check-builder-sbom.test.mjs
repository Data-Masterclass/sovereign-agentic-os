/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    App Builder - the builder image's licence gate (scripts/check-builder-sbom.mjs) and the narrow MPL-2.0
 *             owner exception of 2026-11-27.
 * USER STORY: As the owner I want MPL-2.0 accepted ONLY for the five unmodified Go modules BuildKit/runc link, at the
 *             pinned versions, inside the upstream binaries of the builder image - and every other MPL module, every
 *             other copyleft licence, and the same modules anywhere else, to keep failing.
 * ARCHITECTURE: Every positive case has a negative twin. SBOMs are minimal CycloneDX documents shaped like syft's output
 *             (licence ids + syft:location properties). The policy and exceptions under test are the REAL committed
 *             files (licenses/policy.json, licenses/exceptions.images.json), never copies.
 * Run: node --test scripts/tests/check-builder-sbom.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, loadExceptions, checkAll } from '../lib/license-policy.mjs';
import {
  judge, loadBuilderExceptions, MPL_MODULES, MPL_BINARIES, LICENCE_FILES, EXPECTED_FILES,
} from '../check-builder-sbom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
const imageExc = JSON.parse(readFileSync(join(ROOT, 'licenses', 'exceptions.images.json'), 'utf8'));
const mplExceptions = loadBuilderExceptions(imageExc);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const OWNER_GRANT = {
  'github.com/hashicorp/go-immutable-radix/v2': 'v2.1.0',
  'github.com/hashicorp/go-retryablehttp': 'v0.7.8',
  'github.com/hashicorp/go-cleanhttp': 'v0.5.2',
  'github.com/hashicorp/golang-lru/v2': 'v2.0.7',
  'github.com/cyphar/filepath-securejoin': 'v0.7.0',
};

const comp = (name, version, licences, paths = ['/usr/local/bin/buildkitd']) => ({
  type: 'library', name, version,
  licenses: licences.map((id) => ({ license: { id } })),
  properties: paths.flatMap((p, i) => [{ name: `syft:location:${i}:layerID`, value: 'sha256:abc' }, { name: `syft:location:${i}:path`, value: p }]),
});
/** The five excepted modules as syft reports them from the real image (golang-lru/securejoin carry two licence files). */
const theFive = () => [
  comp('github.com/hashicorp/go-immutable-radix/v2', 'v2.1.0', ['MPL-2.0']),
  comp('github.com/hashicorp/go-retryablehttp', 'v0.7.8', ['MPL-2.0'], ['/usr/local/bin/buildkitd', '/usr/local/bin/buildctl']),
  comp('github.com/hashicorp/go-cleanhttp', 'v0.5.2', ['MPL-2.0']),
  comp('github.com/hashicorp/golang-lru/v2', 'v2.0.7', ['MPL-2.0', 'BSD-3-Clause']),
  comp('github.com/cyphar/filepath-securejoin', 'v0.7.0', ['BSD-3-Clause', 'MPL-2.0'], ['/usr/local/bin/runc', '/usr/local/bin/buildkitd']),
];
const permissive = () => [comp('golang.org/x/sys', 'v0.40.0', ['BSD-3-Clause'], ['/usr/local/bin/runc']), comp('github.com/containerd/containerd/v2', 'v2.2.1', ['Apache-2.0'])];
const sbom = (components) => ({ bomFormat: 'CycloneDX', components });
const run = (components, opts = {}) => judge(sbom(components), { policy, mplExceptions, ...opts });

test('the committed exception is exactly the owner grant of 2026-11-27: five module paths, exact versions, builder scope', () => {
  assert.deepEqual([...MPL_MODULES].sort(), Object.keys(OWNER_GRANT).sort(), 'the hard-coded module paths');
  assert.deepEqual(Object.fromEntries(mplExceptions.map((x) => [x.name, x.version])), OWNER_GRANT);
  for (const x of mplExceptions) {
    assert.equal(x.scope, 'builder'); assert.equal(x.ecosystem, 'go'); assert.equal(x.condition, 'unmodified-not-linked');
    assert.equal(x.date, '2026-11-27'); assert.match(x.reviewedBy, /owner/i); assert.match(x.reason, /unmodified/i);
    assert.match(x.review, /2027-05-27/);
  }
  assert.deepEqual([...MPL_BINARIES].sort(), ['/usr/local/bin/buildctl', '/usr/local/bin/buildkitd', '/usr/local/bin/rootlesskit', '/usr/local/bin/runc']);
  // Never in the repo-wide exceptions: the exception must not reach the repo gate.
  const repo = loadExceptions(join(ROOT, 'licenses', 'exceptions.json')).exceptions;
  assert.ok(!repo.some((x) => MPL_MODULES.includes(x.name.replace(/\s*\(.*$/, ''))));
});

test('allowed: the five modules, at the pinned versions, inside the upstream binaries pass (with the permissive rest)', () => {
  const { findings, passed } = run([...theFive(), ...permissive()]);
  assert.deepEqual(findings, []);
  assert.equal(passed.filter((p) => p.excepted).length, 5);
  assert.equal(passed.filter((p) => !p.excepted).length, 2);
});

test('negative twin: without the exception (the pre-2026-11-27 behaviour) the same five fail as forbidden', () => {
  const { findings } = judge(sbom(theFive()), { policy });
  assert.equal(findings.length, 5);
  for (const f of findings) assert.match(f.reason, /forbidden in the builder image: MPL-2\.0/);
});

test('an unknown MPL module fails, even in buildkitd, and even next to the excepted five', () => {
  for (const name of ['github.com/hashicorp/go-multierror', 'cyphar.com/go-pathrs', 'github.com/hashicorp/golang-lru' /* v1 path, not /v2 */]) {
    const { findings } = run([...theFive(), comp(name, 'v1.1.1', ['MPL-2.0'])]);
    assert.equal(findings.length, 1, name);
    assert.match(findings[0].component, new RegExp(`^${name.replace(/[./]/g, '\\$&')}@`));
    assert.match(findings[0].reason, /forbidden in the builder image: MPL-2\.0/);
  }
});

test('MPL outside the upstream binaries fails: our zot-users/require-userns, crane, or no location', () => {
  for (const where of [['/usr/local/bin/zot-users'], ['/usr/local/bin/require-userns'], ['/usr/local/bin/crane'], ['/usr/local/bin/runc', '/usr/local/bin/zot-users'], []]) {
    const five = theFive();
    five[2] = comp('github.com/hashicorp/go-cleanhttp', 'v0.5.2', ['MPL-2.0'], where);
    const { findings } = run(five);
    assert.equal(findings.length, 2, `${where}: the misplaced module fails, and its exception is unused`);
    assert.match(findings[0].reason, /only inside \/usr\/local\/bin\/buildkitd/);
    assert.match(findings[1].reason, /STALE/);
  }
});

test('MPL outside the builder image fails: the repo-wide gate and the other images never see the exception', () => {
  const repoExc = loadExceptions(join(ROOT, 'licenses', 'exceptions.json'));
  const dep = { ecosystem: 'component', name: 'github.com/hashicorp/go-cleanhttp', version: 'v0.5.2', expression: 'MPL-2.0' };
  const r = checkAll([dep], { policy, exceptions: repoExc, noticesText: 'github.com/hashicorp/go-cleanhttp' });
  assert.equal(r[0].status, 'fail', 'repo gate (licenses/exceptions.json)');
  // license-gate-image.mjs applies only the entries of ITS scope (e.g. litellm-oss): none of the builder ones.
  for (const scope of ['litellm-oss', 'langfuse-oss']) {
    const scoped = imageExc.exceptions.filter((x) => x.scope === scope);
    assert.ok(!scoped.some((x) => MPL_MODULES.includes(x.name)), scope);
    const g = checkAll([{ ...dep, ecosystem: 'go' }], { policy, exceptions: { exceptions: [...repoExc.exceptions, ...scoped] }, noticesText: dep.name });
    assert.equal(g[0].status, 'fail', `image gate, scope ${scope}`);
  }
});

test('GPL, LGPL, AGPL and other copyleft still fail - also on an excepted module path', () => {
  for (const lic of ['GPL-2.0-only', 'LGPL-2.1-only', 'AGPL-3.0-only', 'BUSL-1.1', 'SSPL-1.0', 'MPL-1.1', 'EUPL-1.2']) {
    const { findings } = run([...theFive(), comp('example.com/other', 'v1.0.0', [lic], ['/usr/local/bin/runc'])]);
    assert.equal(findings.length, 1, lic); assert.match(findings[0].reason, /forbidden in the builder image/, lic);
  }
  // An excepted path whose licence gains a second copyleft atom is not covered (MPL-2.0 must be the ONLY one).
  const five = theFive();
  five[4] = comp('github.com/cyphar/filepath-securejoin', 'v0.7.0', ['BSD-3-Clause', 'MPL-2.0', 'GPL-2.0-only'], ['/usr/local/bin/runc']);
  const { findings } = run(five);
  assert.ok(findings.some((f) => /filepath-securejoin@v0\.7\.0/.test(f.component) && /GPL-2\.0-only/.test(f.reason)));
  // An excepted path whose other atom is unknown is not covered either.
  const six = theFive();
  six[3] = comp('github.com/hashicorp/golang-lru/v2', 'v2.0.7', ['MPL-2.0', 'Some-Custom-Licence']);
  assert.ok(run(six).findings.some((f) => /golang-lru\/v2@v2\.0\.7/.test(f.component) && /unknown/.test(f.reason)));
});

test('a version bump of an excepted module fails and leaves the old pin stale (owner re-review needed)', () => {
  const five = theFive();
  five[0] = comp('github.com/hashicorp/go-immutable-radix/v2', 'v2.2.0', ['MPL-2.0']);
  const { findings } = run(five);
  assert.equal(findings.length, 2);
  assert.match(findings[0].reason, /only at v2\.1\.0; v2\.2\.0 needs a new owner review/);
  assert.match(findings[1].component, /go-immutable-radix\/v2@v2\.1\.0/); assert.match(findings[1].reason, /STALE/);
});

test('loadBuilderExceptions refuses anything outside the grant', () => {
  const base = mplExceptions[0];
  const bad = (patch) => () => loadBuilderExceptions({ exceptions: [{ ...base, ...patch }] });
  assert.throws(bad({ name: 'github.com/hashicorp/go-multierror' }), /not one of the module paths/);
  assert.throws(bad({ version: '*' }), /exact module version/);
  assert.throws(bad({ ecosystem: 'npm' }), /Go module/);
  assert.throws(bad({ condition: 'separate-program' }), /unmodified-not-linked/);
  assert.throws(bad({ review: '' }), /"review" is required/);
  assert.deepEqual(loadBuilderExceptions({ exceptions: [{ ...base, name: 'whatever', scope: 'litellm-oss' }] }), [], 'other scopes are ignored');
});

test('the image must carry the NOTICE, the MPL-2.0 text and every module\'s licence files - and nothing else', () => {
  const ok = run(theFive(), { files: [...EXPECTED_FILES] });
  assert.deepEqual(ok.findings, []);
  const missing = run(theFive(), { files: EXPECTED_FILES.filter((f) => f !== 'licenses/MPL-2.0.txt') });
  assert.deepEqual(missing.findings.map((f) => f.component), ['/licenses/MPL-2.0.txt']);
  const extra = run(theFive(), { files: [...EXPECTED_FILES, 'licenses/go/github.com/hashicorp/go-multierror@v1.1.1/LICENSE'] });
  assert.equal(extra.findings.length, 1); assert.match(extra.findings[0].reason, /not expected/);
});

test('one list everywhere: exception file = Dockerfile pins = NOTICE (image and repo) = source offer = licence files', () => {
  const pins = Object.entries(OWNER_GRANT).map(([m, v]) => `${m}@${v}`);
  const docker = read('images/base/builder/Dockerfile');
  const arg = docker.match(/^ARG MPL_MODULES="([^"]+)"/m);
  assert.ok(arg, 'Dockerfile declares ARG MPL_MODULES');
  assert.deepEqual(arg[1].split(/\s+/).sort(), [...pins].sort());
  assert.match(docker, /COPY licenses\/NOTICE \/licenses\/NOTICE/);
  assert.match(docker, /COPY --from=src \/licenses\/ \/licenses\//);
  const notice = read('images/base/builder/licenses/NOTICE');
  for (const p of pins) assert.ok(notice.includes(p), `image NOTICE lists ${p}`);
  const repoNotice = read('licenses/notices/builder-image.md');
  const offer = read('licenses/source-offer.md');
  for (const [m, v] of Object.entries(OWNER_GRANT)) {
    assert.match(repoNotice, new RegExp(`\\| ${m.replace(/[./]/g, '\\$&')} \\| ${v.replace(/\./g, '\\.')} \\|`), `notices/builder-image.md: ${m}`);
    assert.ok(offer.includes(`https://proxy.golang.org/${m}/@v/${v}.zip`), `source-offer.md: ${m}@${v}`);
    assert.ok(LICENCE_FILES.some((f) => f.startsWith(`licenses/go/${m}@${v}/`)), `LICENCE_FILES: ${m}@${v}`);
  }
  for (const f of LICENCE_FILES) {
    const m = f.match(/^licenses\/go\/(.+)@(v[^/]+)\//);
    if (m) assert.equal(OWNER_GRANT[m[1]], m[2], `${f} belongs to an excepted module@version`);
  }
  assert.ok(existsSync(join(ROOT, 'licenses', 'MPL-2.0.txt')));
  assert.match(read('THIRD-PARTY-LICENSES.md'), /## Narrow MPL-2\.0 exception: the App Builder image/);
});

test('CLI: the committed exceptions are loaded; exit 0 on the five, 1 on an unknown MPL module', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bsbom-'));
  try {
    const good = join(tmp, 'good.json'); const bad = join(tmp, 'bad.json');
    writeFileSync(good, JSON.stringify(sbom([...theFive(), ...permissive()])));
    writeFileSync(bad, JSON.stringify(sbom([...theFive(), comp('github.com/hashicorp/go-multierror', 'v1.1.1', ['MPL-2.0'])])));
    const g = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-builder-sbom.mjs'), '--sbom', good], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stdout + g.stderr); assert.match(g.stdout, /5 MPL-2\.0 under the owner exception/);
    const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-builder-sbom.mjs'), '--sbom', bad], { encoding: 'utf8' });
    assert.equal(b.status, 1, b.stdout + b.stderr); assert.match(b.stdout, /FAIL github\.com\/hashicorp\/go-multierror@v1\.1\.1/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
