/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    Licence policy of 2026-11-22 — one config file, SPDX-expression evaluation, attribution
 * USER STORY: As the owner I want the gate to enforce my decision exactly: allowed licences pass,
 *             copyleft and source-available licences fail, unknown fails unless a reviewed exception
 *             says why, and anything other than Apache-2.0/MIT needs an attribution entry.
 * ARCHITECTURE: Every positive case has a negative twin. Fixture packages are real package.json trees
 *             under scripts/tests/license-gate/fixtures/<case>/modules. The policy under test is
 *             the REAL licenses/policy.json — the file the gate reads — never a copy.
 * Run: node --test scripts/tests/license-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPolicy, loadExceptions, evaluateExpression, scanNodeModules, scanNpmLock, scanPipReport,
  scanManifest, extractPipSpecs, checkAll,
} from '../lib/license-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIX = join(HERE, 'license-gate', 'fixtures');
const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
const NO_EXC = { exceptions: [] };

function runFixture(name, { exceptions = NO_EXC } = {}) {
  const dir = join(FIX, name);
  const notices = existsSync(join(dir, 'NOTICES.md')) ? readFileSync(join(dir, 'NOTICES.md'), 'utf8') : '';
  const deps = scanNodeModules(join(dir, 'modules'));
  assert.ok(deps.length > 0, `fixture ${name} has no packages`);
  return checkAll(deps, { policy, exceptions, noticesText: notices });
}
const failed = (rs) => rs.filter((r) => r.status === 'fail');

// ---- the config file is the single source of truth ------------------------------------------
test('policy.json carries the owner decision verbatim', () => {
  for (const id of ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unlicense',
    'BlueOak-1.0.0', 'PSF-2.0', 'Python-2.0', 'CC-BY-4.0', 'CC0-1.0']) {
    assert.ok(policy.allow.includes(id), `${id} must be allowed`);
  }
  for (const id of ['GPL-3.0-only', 'LGPL-2.1-or-later', 'AGPL-3.0-only', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0',
    'EUPL-1.2', 'BUSL-1.1', 'BSL-1.1', 'SSPL-1.0', 'Elastic-2.0', 'Commons-Clause', 'CC-BY-NC-4.0', 'CC-BY-SA-4.0']) {
    assert.equal(evaluateExpression(id, policy).verdict, 'forbid', `${id} must be forbidden`);
  }
  assert.deepEqual(policy.attributionExempt.sort(), ['Apache-2.0', 'MIT']);
});

test('negative twin: the old rule (MPL/GPL allowed) is gone from the allow list', () => {
  for (const id of ['MPL-2.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'PostgreSQL']) {
    assert.ok(!policy.allow.includes(id), `${id} must not be in the allow list`);
  }
});

// ---- SPDX expressions ------------------------------------------------------------------------
test('dual MIT/GPL passes as MIT and records MIT; negative twin: GPL alone fails', () => {
  const r = evaluateExpression('(MIT OR GPL-3.0-only)', policy);
  assert.equal(r.verdict, 'allow'); assert.deepEqual(r.chosen, ['MIT']);
  assert.equal(evaluateExpression('MIT/GPL-2.0', policy).verdict, 'allow');
  assert.equal(evaluateExpression('GPL-3.0-only', policy).verdict, 'forbid');
});
test('OR picks an allowed option wherever it sits; AND needs every side allowed', () => {
  assert.deepEqual(evaluateExpression('GPL-2.0-only OR Apache-2.0', policy).chosen, ['Apache-2.0']);
  assert.deepEqual(evaluateExpression('MIT AND Zlib', policy).chosen, ['MIT', 'Zlib']);
  assert.equal(evaluateExpression('MIT AND LGPL-3.0-or-later', policy).verdict, 'forbid'); // twin
  assert.equal(evaluateExpression('MPL-2.0 OR LGPL-2.1-only', policy).verdict, 'forbid');
});
test('unknown / unparseable expressions are unknown, never silently allowed', () => {
  assert.equal(evaluateExpression('SEE LICENSE IN LICENSE.txt', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('WTFPL', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('MIT OR SEE LICENSE IN FEEL-FREE.md', policy).verdict, 'allow');
});
test('WITH exceptions do not change the base licence', () => {
  assert.equal(evaluateExpression('GPL-2.0-only WITH Classpath-exception-2.0', policy).verdict, 'forbid');
  assert.equal(evaluateExpression('Apache-2.0 WITH LLVM-exception', policy).verdict, 'allow');
});

// ---- fixture packages: required positive/negative pairs -------------------------------------
test('CC-BY-4.0 package passes WITH an attribution entry', () => {
  const rs = runFixture('cc-by-attributed');
  assert.equal(failed(rs).length, 0, JSON.stringify(failed(rs)));
  assert.deepEqual(rs[0].chosen, ['CC-BY-4.0']); assert.equal(rs[0].attributed, true);
});
test('CC-BY-4.0 package FAILS without an attribution entry', () => {
  const f = failed(runFixture('cc-by-unattributed'));
  assert.equal(f.length, 1); assert.match(f[0].reasons.join(' '), /attribution/i);
});
test('LGPL package fails', () => {
  const f = failed(runFixture('lgpl')); assert.equal(f.length, 1); assert.equal(f[0].verdict, 'forbid');
});
test('MPL package fails', () => {
  const f = failed(runFixture('mpl')); assert.equal(f.length, 1); assert.equal(f[0].verdict, 'forbid');
});
test('BUSL package fails', () => {
  const f = failed(runFixture('busl')); assert.equal(f.length, 1); assert.equal(f[0].verdict, 'forbid');
});
test('dual MIT/GPL package passes as MIT, with no attribution needed', () => {
  const rs = runFixture('dual');
  assert.equal(failed(rs).length, 0); assert.deepEqual(rs[0].chosen, ['MIT']); assert.equal(rs[0].needsAttribution, false);
});

// ---- exceptions: only for unknown, only with a reason ---------------------------------------
test('unknown licence fails; unlicensed fails', () => {
  assert.equal(failed(runFixture('unknown')).length, 1);
  assert.equal(failed(runFixture('unlicensed')).length, 1);
});
test('a reviewed exception with a reason lets an unknown package pass; negative twin: no reason is a config error', () => {
  const ok = { exceptions: [{ ecosystem: 'npm', name: 'lib-mystery', version: '*', reason: 'Vendor confirmed MIT by email 2026-11-22', reviewedBy: 'owner' }] };
  const rs = runFixture('unknown', { exceptions: ok });
  assert.equal(failed(rs).length, 0); assert.match(rs[0].note, /Vendor confirmed MIT/);
  const bad = { exceptions: [{ ecosystem: 'npm', name: 'lib-mystery', version: '*', reason: '  ', reviewedBy: 'owner' }] };
  assert.throws(() => loadExceptions(bad), /reason/);
  assert.throws(() => loadExceptions({ exceptions: [{ ecosystem: 'npm', name: 'x', version: '*', reason: 'r' }] }), /reviewedBy/);
});
test('an exception can NOT waive a forbidden licence', () => {
  const ex = { exceptions: [{ ecosystem: 'npm', name: 'lib-lgpl', version: '*', reason: 'we like it', reviewedBy: 'owner' }] };
  assert.equal(failed(runFixture('lgpl', { exceptions: ex })).length, 1);
});
test('the committed exceptions file loads and every entry has a reason', () => {
  const ex = loadExceptions(JSON.parse(readFileSync(join(ROOT, 'licenses', 'exceptions.json'), 'utf8')));
  for (const e of ex.exceptions) assert.ok(e.reason.trim().length > 10);
});

// ---- other ecosystems ------------------------------------------------------------------------
test('npm lockfile: licence strings are read, dev deps are skipped unless asked', () => {
  const lock = { lockfileVersion: 3, packages: {
    '': { name: 'root' },
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/b': { version: '2.0.0', license: 'LGPL-3.0-or-later', optional: true },
    'node_modules/c': { version: '3.0.0', license: 'GPL-3.0-only', dev: true },
    'node_modules/x/node_modules/@s/d': { version: '4.0.0' },
  } };
  const names = scanNpmLock(lock).map((d) => d.name).sort();
  assert.deepEqual(names, ['@s/d', 'a', 'b']);
  assert.deepEqual(scanNpmLock(lock, { includeDev: true }).map((d) => d.name).sort(), ['@s/d', 'a', 'b', 'c']);
  const rs = checkAll(scanNpmLock(lock), { policy, exceptions: NO_EXC, noticesText: '' });
  assert.deepEqual(failed(rs).map((r) => r.name).sort(), ['@s/d', 'b']);
});
test('python: pip install report metadata is classified (licence_expression, licence, classifiers)', () => {
  const report = { install: [
    { metadata: { name: 'good', version: '1', license_expression: 'Apache-2.0' } },
    { metadata: { name: 'oldmit', version: '1', license: 'MIT License' } },
    { metadata: { name: 'cls', version: '1', classifier: ['License :: OSI Approved :: BSD License', 'License :: OSI Approved :: ISC License (ISCL)'] } },
    { metadata: { name: 'lg', version: '1', classifier: ['License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)'] } },
    { metadata: { name: 'none', version: '1' } },
  ] };
  const rs = checkAll(scanPipReport(report), { policy, exceptions: NO_EXC, noticesText: 'cls\n' });
  const by = Object.fromEntries(rs.map((r) => [r.name, r]));
  assert.equal(by.good.status, 'pass'); assert.equal(by.oldmit.status, 'pass');
  assert.equal(by.lg.status, 'fail'); assert.equal(by.none.status, 'fail');
  assert.equal(by.cls.status, 'fail'); // "BSD License" alone is ambiguous (2- or 3-clause): unknown, not guessed
});
test('python: pip specs are extracted from Dockerfile RUN blocks and requirements files', () => {
  const dockerfile = 'FROM x\nRUN pip install --no-cache-dir \\\n  "dagster==1.13.11" \\\n  # a comment, with words\n  "SQLAlchemy>=2.0,<2.1"\n\nRUN apt-get install git\n';
  assert.deepEqual(extractPipSpecs(dockerfile, 'Dockerfile'), ['dagster==1.13.11', 'SQLAlchemy>=2.0,<2.1']);
  assert.deepEqual(extractPipSpecs('# c\ntrino>=0.330,<1\n\nmcp>=1.2,<2\n', 'requirements.txt'), ['trino>=0.330,<1', 'mcp>=1.2,<2']);
});
test('container/Go components: the manifest is classified by the same policy', () => {
  const tsv = 'name\tversion\tspdx\tbundled\tlicense_file\tnote\n' +
    'okcomp\t1\tApache-2.0\tyes\tx\t\n' + 'gplcomp\t1\tGPL-3.0-or-later\tyes\tx\t\n' +
    'devonly\t1\tAGPL-3.0\tno\tx\t\n' + 'dual\t1\tMIT OR GPL-2.0-only\toptional\tx\t\n';
  const rs = checkAll(scanManifest(tsv), { policy, exceptions: NO_EXC, noticesText: '' });
  assert.deepEqual(failed(rs).map((r) => r.name), ['gplcomp']); // bundled=no is not redistributed
});

// ---- ratchet of known violations (findings on main at policy introduction) -------------------
import { applyKnownViolations, loadKnownViolations } from '../lib/license-policy.mjs';
const bad = (name, ecosystem = 'npm') => ({ ecosystem, name, version: '1.0.0', expression: 'LGPL-3.0-only', source: 't' });
test('known violations: listed ones are reported but do not turn a NEW finding green (negative twin)', () => {
  const known = loadKnownViolations({ violations: [{ ecosystem: 'npm', name: 'old-lgpl', version: '*', reason: 'owner decision pending' }] });
  const rs = checkAll([bad('old-lgpl'), bad('new-lgpl')], { policy, exceptions: NO_EXC, noticesText: '' });
  const out = applyKnownViolations(rs, known, { scanned: ['npm'] });
  assert.deepEqual(out.known.map((r) => r.name), ['old-lgpl']);
  assert.deepEqual(out.newFailures.map((r) => r.name), ['new-lgpl']);
});
test('known violations: an entry whose package is fixed or gone is STALE and fails (the list can only shrink)', () => {
  const known = loadKnownViolations({ violations: [{ ecosystem: 'npm', name: 'fixed-now', version: '*', reason: 'was LGPL' }] });
  const rs = checkAll([{ ecosystem: 'npm', name: 'fixed-now', version: '2.0.0', expression: 'MIT', source: 't' }], { policy, exceptions: NO_EXC, noticesText: '' });
  const out = applyKnownViolations(rs, known, { scanned: ['npm'] });
  assert.equal(out.stale.length, 1);
  // an ecosystem that was not scanned this run cannot make its entries stale
  assert.equal(applyKnownViolations(rs, known, { scanned: ['python'] }).stale.length, 0);
});
test('known violations need a reason', () => {
  assert.throws(() => loadKnownViolations({ violations: [{ ecosystem: 'npm', name: 'x', version: '*', reason: '' }] }), /reason/);
});
test('pip: when classifiers are ambiguous the short licence string decides (never a guess)', () => {
  const report = { install: [
    { metadata: { name: 'amb-resolved', version: '1', license: 'BSD-3-Clause', classifier: ['License :: OSI Approved :: BSD License'] } },
    { metadata: { name: 'amb-open', version: '1', classifier: ['License :: OSI Approved :: BSD License'] } },
  ] };
  const by = Object.fromEntries(checkAll(scanPipReport(report), { policy, exceptions: NO_EXC, noticesText: 'amb-resolved' }).map((r) => [r.name, r]));
  assert.equal(by['amb-resolved'].status, 'pass'); assert.equal(by['amb-open'].status, 'fail');
});
