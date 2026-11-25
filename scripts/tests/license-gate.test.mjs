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
import { readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPolicy, loadExceptions, evaluateExpression, scanNodeModules, scanNpmLock, scanPipReport,
  scanManifest, extractPipSpecs, checkAll, scanImageInventory, applyLicenceOverrides,
} from '../lib/license-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIX = join(HERE, 'license-gate', 'fixtures');
const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
const NO_EXC = { exceptions: [] };

function runFixture(name, { exceptions = NO_EXC, extraNotices = '' } = {}) {
  const dir = join(FIX, name);
  const notices = (existsSync(join(dir, 'NOTICES.md')) ? readFileSync(join(dir, 'NOTICES.md'), 'utf8') : '') + '\n' + extraNotices;
  const deps = scanNodeModules(join(dir, 'modules'));
  assert.ok(deps.length > 0, `fixture ${name} has no packages`);
  return checkAll(deps, { policy, exceptions, noticesText: notices });
}
const failed = (rs) => rs.filter((r) => r.status === 'fail');

// ---- the config file is the single source of truth ------------------------------------------
test('policy.json carries the owner decision verbatim (refined 2026-11-22)', () => {
  for (const id of ['Apache-2.0', 'MIT', 'MIT-0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib', 'Unlicense',
    'BlueOak-1.0.0', 'PSF-2.0', 'Python-2.0', 'CC-BY-4.0', 'CC0-1.0', 'PostgreSQL']) {
    assert.ok(policy.allow.includes(id), `${id} must be allowed`);
  }
  // never, under any circumstances: AGPL, strong copyleft we would link, source-available
  for (const id of ['AGPL-3.0-only', 'AGPL-3.0-or-later', 'EUPL-1.2', 'BUSL-1.1', 'BSL-1.1', 'SSPL-1.0', 'Elastic-2.0',
    'Commons-Clause', 'CC-BY-NC-4.0', 'CC-BY-SA-4.0']) {
    assert.equal(evaluateExpression(id, policy).verdict, 'forbid', `${id} must be forbidden`);
  }
  // only through a reviewed exception: unmodified weak copyleft, separate GPL programs
  for (const id of ['MPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'EPL-2.0', 'CDDL-1.0', 'GPL-2.0-only', 'GPL-3.0-or-later']) {
    assert.equal(evaluateExpression(id, policy).verdict, 'exceptable', `${id} must need an exception`);
  }
  assert.deepEqual(policy.attributionExempt.sort(), ['Apache-2.0', 'MIT']);
});

test('negative twin: the old rule (MPL/GPL allowed outright) is gone from the allow list', () => {
  for (const id of ['MPL-2.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-2.0-only', 'LGPL-3.0-only']) {
    assert.ok(!policy.allow.includes(id), `${id} must not be in the allow list`);
  }
});

// ---- SPDX expressions ------------------------------------------------------------------------
test('dual MIT/GPL passes as MIT and records MIT; negative twin: GPL alone fails', () => {
  const r = evaluateExpression('(MIT OR GPL-3.0-only)', policy);
  assert.equal(r.verdict, 'allow'); assert.deepEqual(r.chosen, ['MIT']);
  assert.equal(evaluateExpression('MIT/GPL-2.0', policy).verdict, 'allow');
  assert.equal(evaluateExpression('GPL-3.0-only', policy).verdict, 'exceptable');
});
test('OR picks an allowed option wherever it sits; AND needs every side allowed', () => {
  assert.deepEqual(evaluateExpression('GPL-2.0-only OR Apache-2.0', policy).chosen, ['Apache-2.0']);
  assert.deepEqual(evaluateExpression('MIT AND Zlib', policy).chosen, ['MIT', 'Zlib']);
  assert.equal(evaluateExpression('MIT AND LGPL-3.0-or-later', policy).verdict, 'exceptable'); // twin: AND is not allowed
  assert.equal(evaluateExpression('MPL-2.0 OR LGPL-2.1-only', policy).verdict, 'exceptable');
  assert.equal(evaluateExpression('MIT AND AGPL-3.0-only', policy).verdict, 'forbid');
  assert.equal(evaluateExpression('AGPL-3.0-only OR MPL-2.0', policy).verdict, 'exceptable'); // the weak option could be excepted
});
test('unknown / unparseable expressions are unknown, never silently allowed', () => {
  assert.equal(evaluateExpression('SEE LICENSE IN LICENSE.txt', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('WTFPL', policy).verdict, 'unknown');
  assert.equal(evaluateExpression('MIT OR SEE LICENSE IN FEEL-FREE.md', policy).verdict, 'allow');
});
test('WITH exceptions do not change the base licence', () => {
  assert.equal(evaluateExpression('GPL-2.0-only WITH Classpath-exception-2.0', policy).verdict, 'exceptable');
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
const EXC = (name, condition, extra = {}) => ({ exceptions: [{ ecosystem: 'npm', name, version: '*', condition, reason: `${name} is used unmodified as a dependency`, reviewedBy: 'owner', date: '2026-11-22', ...extra }] });
const ATTR = (name) => `- ${name} 1.0.0 - attribution\n`;
test('LGPL package FAILS without an exception entry', () => {
  const f = failed(runFixture('lgpl', { extraNotices: ATTR('lib-lgpl') }));
  assert.equal(f.length, 1); assert.equal(f[0].verdict, 'exceptable'); assert.match(f[0].reasons.join(' '), /exception/i);
});
test('LGPL package PASSES with a reviewed exception (unmodified, not linked) and an attribution entry', () => {
  const rs = runFixture('lgpl', { exceptions: EXC('lib-lgpl', 'unmodified-not-linked'), extraNotices: ATTR('lib-lgpl') });
  assert.equal(failed(rs).length, 0, JSON.stringify(failed(rs))); assert.match(rs[0].note, /excepted/);
  // negative twin: the exception alone is not enough - the licence still needs its attribution entry
  assert.equal(failed(runFixture('lgpl', { exceptions: EXC('lib-lgpl', 'unmodified-not-linked') })).length, 1);
});
test('MPL package: fails without an exception, passes with one; an exception with no condition does not count', () => {
  assert.equal(failed(runFixture('mpl', { extraNotices: ATTR('lib-mpl') })).length, 1);
  assert.equal(failed(runFixture('mpl', { exceptions: EXC('lib-mpl', 'unmodified-not-linked'), extraNotices: ATTR('lib-mpl') })).length, 0);
  const noCond = failed(runFixture('mpl', { exceptions: EXC('lib-mpl', undefined), extraNotices: ATTR('lib-mpl') }));
  assert.equal(noCond.length, 1); assert.match(noCond[0].reasons.join(' '), /condition/i);
});
test('GPL needs the condition "separate-program"; "unmodified-not-linked" is not enough (negative twin)', () => {
  const dir = join(FIX, 'gpl');
  const deps = scanNodeModules(join(dir, 'modules'));
  const run = (exceptions) => checkAll(deps, { policy, exceptions, noticesText: ATTR('prog-gpl') });
  assert.equal(failed(run(NO_EXC)).length, 1);
  assert.equal(failed(run(EXC('prog-gpl', 'unmodified-not-linked'))).length, 1);
  assert.equal(failed(run(EXC('prog-gpl', 'separate-program'))).length, 0);
});
test('BUSL package fails, with or without an exception', () => {
  assert.equal(failed(runFixture('busl', { extraNotices: ATTR('lib-busl') })).length, 1);
  const f = failed(runFixture('busl', { exceptions: EXC('lib-busl', 'separate-program'), extraNotices: ATTR('lib-busl') }));
  assert.equal(f.length, 1); assert.equal(f[0].verdict, 'forbid');
});
test('AGPL package ALWAYS fails, even with an exception entry and an attribution', () => {
  assert.equal(failed(runFixture('agpl', { extraNotices: ATTR('lib-agpl') })).length, 1);
  for (const c of ['unmodified-not-linked', 'separate-program']) {
    const f = failed(runFixture('agpl', { exceptions: EXC('lib-agpl', c), extraNotices: ATTR('lib-agpl') }));
    assert.equal(f.length, 1, c); assert.equal(f[0].verdict, 'forbid');
  }
});
test('dual MIT/GPL package passes as MIT, with no attribution needed', () => {
  const rs = runFixture('dual');
  assert.equal(failed(rs).length, 0); assert.deepEqual(rs[0].chosen, ['MIT']); assert.equal(rs[0].needsAttribution, false);
});

// ---- unknown can never be waived: resolve it to an SPDX id through a reviewed alias first -------
test('unknown licence fails; unlicensed fails', () => {
  assert.equal(failed(runFixture('unknown')).length, 1);
  assert.equal(failed(runFixture('unlicensed')).length, 1);
});
test('an exception can NEVER waive an unknown licence (the verifier found free text slipping through)', () => {
  for (const [name, fixture] of [['lib-mystery', 'unknown'], ['lib-nolicense', 'unlicensed']]) {
    for (const condition of ['unmodified-not-linked', 'separate-program']) {
      const f = failed(runFixture(fixture, { exceptions: EXC(name, condition) }));
      assert.equal(f.length, 1, `${name}/${condition}`); assert.match(f[0].reasons.join(' '), /alias/i);
    }
  }
});
test('an unknown becomes decidable only through an explicit alias (reviewed mapping); then the normal rules apply', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'licenses', 'policy.json'), 'utf8'));
  const withAlias = (text, spdx) => loadPolicy({ ...raw, aliases: { ...raw.aliases, [text]: spdx } });
  assert.equal(evaluateExpression('Acme Public License', policy).verdict, 'unknown'); // twin: no alias, no luck
  assert.equal(evaluateExpression('Acme Public License', withAlias('Acme Public License', 'MIT')).verdict, 'allow');
  assert.equal(evaluateExpression('Acme Public License', withAlias('Acme Public License', 'SSPL-1.0')).verdict, 'forbid');
  assert.equal(evaluateExpression('Acme Public License', withAlias('Acme Public License', 'LGPL-3.0-only')).verdict, 'exceptable');
});
test('free-text spellings of never-allowed licences are FORBIDDEN, not unknown', () => {
  for (const t of ['Elastic License 2.0', 'Elastic License v2', 'ELv2', 'Server Side Public License', 'Server Side Public License, v 1',
    'SSPL', 'Business Source License 1.1', 'Business Source License', 'BSL 1.1', 'Commons Clause', 'Commons Clause License Condition v1.0',
    'GNU Affero General Public License v3', 'GNU AGPL v3', 'European Union Public Licence 1.2']) {
    assert.equal(evaluateExpression(t, policy).verdict, 'forbid', t);
  }
  // twin: the same spellings cannot be waived by an exception, in any ecosystem
  const deps = ['Elastic License 2.0', 'Server Side Public License', 'Business Source License 1.1', 'Commons Clause']
    .map((expression, i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0', expression, source: 't' }));
  const ex = { exceptions: deps.map((d) => ({ ecosystem: 'npm', name: d.name, version: '*', condition: 'separate-program', reason: 'trying to waive', reviewedBy: 'x' })) };
  assert.equal(failed(checkAll(deps, { policy, exceptions: ex, noticesText: deps.map((d) => d.name).join('\n') })).length, 4);
});
test('free-text spellings of copyleft are EXCEPTABLE (need an exception and a condition), not unknown', () => {
  for (const t of ['GNU GPL v3', 'GNU General Public License', 'GNU General Public License v2 or later', 'GNU GPL v2',
    'GNU Lesser General Public License v3', 'GNU LGPL v2.1', 'Mozilla Public License 2.0', 'Eclipse Public License 2.0']) {
    assert.equal(evaluateExpression(t, policy).verdict, 'exceptable', t);
  }
  assert.ok(evaluateExpression('GNU GPL v3', policy).families.includes('gpl'));
  assert.ok(evaluateExpression('GNU Lesser General Public License v3', policy).families.includes('weak'));
  const dep = [{ ecosystem: 'python', name: 'prog', version: '1', expression: 'GNU General Public License', source: 't' }];
  const exc = (condition) => ({ exceptions: [{ ecosystem: 'python', name: 'prog', version: '*', condition, reason: 'separate process', reviewedBy: 'owner' }] });
  assert.equal(failed(checkAll(dep, { policy, exceptions: NO_EXC, noticesText: 'prog' })).length, 1);
  assert.equal(failed(checkAll(dep, { policy, exceptions: exc('unmodified-not-linked'), noticesText: 'prog' })).length, 1); // a GPL needs separate-program
  assert.equal(failed(checkAll(dep, { policy, exceptions: exc('separate-program'), noticesText: 'prog' })).length, 0);
});
test('exceptions need a reason and a reviewer and a condition', () => {
  assert.throws(() => loadExceptions({ exceptions: [{ ecosystem: 'npm', name: 'x', version: '*', condition: 'separate-program', reason: '  ', reviewedBy: 'o' }] }), /reason/);
  assert.throws(() => loadExceptions({ exceptions: [{ ecosystem: 'npm', name: 'x', version: '*', condition: 'separate-program', reason: 'r' }] }), /reviewedBy/);
  assert.throws(() => loadExceptions({ exceptions: [{ ecosystem: 'npm', name: 'x', version: '*', reason: 'r', reviewedBy: 'o' }] }), /condition/);
});
test('an exception with an unknown condition is a config error', () => {
  assert.throws(() => loadExceptions(EXC('x', 'we-like-it')), /condition/);
  assert.doesNotThrow(() => loadExceptions(EXC('x', 'separate-program')));
});
test('the committed exceptions file loads and every entry has a reason', () => {
  const ex = loadExceptions(JSON.parse(readFileSync(join(ROOT, 'licenses', 'exceptions.json'), 'utf8')));
  for (const e of ex.exceptions) {
    assert.ok(e.reason.trim().length > 10);
    assert.ok(['unmodified-not-linked', 'separate-program'].includes(e.condition), `${e.name}: condition`);
  }
  // git is the owner's named example of an unmodified separate GPL program
  assert.ok(ex.exceptions.some((e) => e.name.startsWith('git') && e.condition === 'separate-program'));
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
  assert.equal(by.cls.status, 'pass'); // the bare "BSD License" classifier resolves to BSD (owner decision 2026-11-22)
  assert.equal(by.cls.chosen.includes('BSD-3-Clause'), true);
});
test('python: pip specs are extracted from Dockerfile RUN blocks and requirements files', () => {
  const dockerfile = 'FROM x\nRUN pip install --no-cache-dir \\\n  "dagster==1.13.11" \\\n  # a comment, with words\n  "SQLAlchemy>=2.0,<2.1"\n\nRUN apt-get install git\n';
  assert.deepEqual(extractPipSpecs(dockerfile, 'Dockerfile'), ['dagster==1.13.11', 'SQLAlchemy>=2.0,<2.1']);
  assert.deepEqual(extractPipSpecs('# c\ntrino>=0.330,<1\n\nmcp>=1.2,<2\n', 'requirements.txt'), ['trino>=0.330,<1', 'mcp>=1.2,<2']);
});
test('container/Go components: the manifest is classified by the same policy', () => {
  const tsv = 'name\tversion\tspdx\tbundled\tlicense_file\tnote\n' +
    'okcomp\t1\tApache-2.0\tyes\tx\t\n' + 'gplcomp\t1\tGPL-3.0-or-later\tyes\tx\t\n' + 'agplcomp\t1\tAGPL-3.0\tyes\tx\t\n' +
    'devonly\t1\tAGPL-3.0\tno\tx\t\n' + 'dual\t1\tMIT OR GPL-2.0-only\toptional\tx\t\n' + 'pg\t17\tPostgreSQL\tyes\tx\t\n';
  const deps = scanManifest(tsv);
  const rs = checkAll(deps, { policy, exceptions: NO_EXC, noticesText: 'pg\n' });
  assert.deepEqual(failed(rs).map((r) => r.name).sort(), ['agplcomp', 'gplcomp']); // bundled=no is not redistributed
  const ex = { exceptions: [{ ecosystem: 'component', name: 'gplcomp', version: '*', condition: 'separate-program', reason: 'runs as its own pod, unmodified', reviewedBy: 'owner' },
    { ecosystem: 'component', name: 'agplcomp', version: '*', condition: 'separate-program', reason: 'trying to waive AGPL', reviewedBy: 'owner' }] };
  assert.deepEqual(failed(checkAll(deps, { policy, exceptions: ex, noticesText: 'pg\ngplcomp\n' })).map((r) => r.name), ['agplcomp']);
});

// ---- ratchet of known violations (findings on main at policy introduction) -------------------
import { applyKnownViolations, loadKnownViolations } from '../lib/license-policy.mjs';
const bad = (name, ecosystem = 'npm') => ({ ecosystem, name, version: '1.0.0', expression: 'LGPL-3.0-only', source: 't' });
const KV = (name, extra = {}) => ({ ecosystem: 'npm', name, version: '1.0.0', reason: 'owner decision pending', ...extra });
test('known violations: listed ones are reported but do not turn a NEW finding green (negative twin)', () => {
  const known = loadKnownViolations({ violations: [KV('old-lgpl')] });
  const rs = checkAll([bad('old-lgpl'), bad('new-lgpl')], { policy, exceptions: NO_EXC, noticesText: '' });
  const out = applyKnownViolations(rs, known, { scanned: ['npm'] });
  assert.deepEqual(out.known.map((r) => r.name), ['old-lgpl']);
  assert.deepEqual(out.newFailures.map((r) => r.name), ['new-lgpl']);
});
test('known violations: the entry names an EXACT version - another version of the package is a new finding', () => {
  const known = loadKnownViolations({ violations: [KV('old-lgpl')] });
  const rs = checkAll([{ ...bad('old-lgpl'), version: '2.0.0' }], { policy, exceptions: NO_EXC, noticesText: '' });
  const out = applyKnownViolations(rs, known, { scanned: ['npm'] });
  assert.equal(out.newFailures.length, 1); assert.equal(out.stale.length, 1);
});
test('known violations: version "*" or a missing version is refused', () => {
  assert.throws(() => loadKnownViolations({ violations: [KV('x', { version: '*' })] }), /exact version/);
  assert.throws(() => loadKnownViolations({ violations: [KV('x', { version: '' })] }), /version/);
  assert.throws(() => loadKnownViolations({ violations: [KV('x', { version: undefined })] }), /version/);
});
test('known violations can NEVER hide a never-allowed licence (AGPL, EUPL, source-available), listed or not', () => {
  for (const expression of ['AGPL-3.0-only', 'EUPL-1.2', 'BUSL-1.1', 'SSPL-1.0', 'Elastic-2.0', 'Commons-Clause', 'CC-BY-NC-4.0', 'Elastic License 2.0']) {
    const known = loadKnownViolations({ violations: [KV('hidden')] });
    const rs = checkAll([{ ecosystem: 'npm', name: 'hidden', version: '1.0.0', expression, source: 't' }], { policy, exceptions: NO_EXC, noticesText: '' });
    const out = applyKnownViolations(rs, known, { scanned: ['npm'] });
    assert.equal(out.newFailures.length, 1, expression); assert.equal(out.known.length, 0, expression);
  }
});
test('known violations: an entry whose package is fixed or gone is STALE and fails (the list can only shrink)', () => {
  const known = loadKnownViolations({ violations: [KV('fixed-now')] });
  const rs = checkAll([{ ecosystem: 'npm', name: 'fixed-now', version: '1.0.0', expression: 'MIT', source: 't' }], { policy, exceptions: NO_EXC, noticesText: '' });
  assert.equal(applyKnownViolations(rs, known, { scanned: ['npm'] }).stale.length, 1);
});
test('known violations: python entries are stale-checked whenever python is scanned, and reported UNCHECKED when it is not', () => {
  const known = loadKnownViolations({ violations: [{ ecosystem: 'python', name: 'gone', licence: 'MPL-2.0', reason: 'owner decision pending' }, KV('kept')] });
  const rs = checkAll([bad('kept')], { policy, exceptions: NO_EXC, noticesText: '' });
  const withPy = applyKnownViolations(rs, known, { scanned: ['npm', 'python'] });
  assert.deepEqual(withPy.stale.map((x) => x.name), ['gone']); assert.deepEqual(withPy.unchecked, []);
  const noPy = applyKnownViolations(rs, known, { scanned: ['npm'] });
  assert.deepEqual(noPy.stale, []); assert.deepEqual(noPy.unchecked.map((x) => x.ecosystem), ['python']); // said out loud, never silent
});
// Python resolves against a live index (certifi ships a new version every few weeks): its ratchet is keyed on package + licence.
const PY = (name, licence, extra = {}) => ({ ecosystem: 'python', name, licence, reason: 'owner decision pending', ...extra });
const pyDep = (name, version, expression) => ({ ecosystem: 'python', name, version, expression, source: 't' });
test('python known violations: a version bump with the SAME licence stays KNOWN (a new certifi release must not turn main red)', () => {
  const known = loadKnownViolations({ violations: [PY('certifi', 'Mozilla Public License 2.0')] }); // no version at all
  for (const version of ['2026.11.20', '2026.12.3', '2027.1.1']) {
    const rs = checkAll([pyDep('certifi', version, 'Mozilla Public License 2.0')], { policy, exceptions: NO_EXC, noticesText: '' });
    const out = applyKnownViolations(rs, known, { scanned: ['python'] });
    assert.equal(out.known.length, 1, version); assert.equal(out.newFailures.length, 0, version); assert.equal(out.stale.length, 0, version);
  }
  // two versions of the same package in two images are covered by the one entry
  const two = checkAll([pyDep('pathspec', '0.12.1', 'MPL-2.0'), pyDep('pathspec', '1.0.4', 'MPL-2.0')], { policy, exceptions: NO_EXC, noticesText: '' });
  assert.equal(applyKnownViolations(two, loadKnownViolations({ violations: [PY('pathspec', 'MPL-2.0')] }), { scanned: ['python'] }).known.length, 2);
});
test('python known violations: a LICENCE change fails (negative twin), and so does a different package', () => {
  const known = loadKnownViolations({ violations: [PY('certifi', 'MPL-2.0')] });
  const changed = checkAll([pyDep('certifi', '2026.12.3', 'MPL-2.0 AND GPL-3.0-only')], { policy, exceptions: NO_EXC, noticesText: '' });
  const out = applyKnownViolations(changed, known, { scanned: ['python'] });
  assert.equal(out.newFailures.length, 1); assert.equal(out.stale.length, 1);
  const other = checkAll([pyDep('certifi', '1', 'MPL-2.0'), pyDep('newcomer', '1', 'MPL-2.0')], { policy, exceptions: NO_EXC, noticesText: '' });
  assert.deepEqual(applyKnownViolations(other, known, { scanned: ['python'] }).newFailures.map((r) => r.name), ['newcomer']);
});
test('python known violations: never-allowed licences still cannot hide, and the licence is required', () => {
  const known = loadKnownViolations({ violations: [PY('x', 'SSPL-1.0')] });
  const rs = checkAll([pyDep('x', '1', 'SSPL-1.0')], { policy, exceptions: NO_EXC, noticesText: '' });
  assert.equal(applyKnownViolations(rs, known, { scanned: ['python'] }).newFailures.length, 1);
  assert.throws(() => loadKnownViolations({ violations: [PY('x', undefined)] }), /licence/);
});
test('npm and component entries still need an exact version (only python floats)', () => {
  assert.throws(() => loadKnownViolations({ violations: [{ ecosystem: 'npm', name: 'x', licence: 'MIT', reason: 'r' }] }), /version/);
  assert.throws(() => loadKnownViolations({ violations: [{ ecosystem: 'component', name: 'x', version: '*', reason: 'r' }] }), /exact version/);
});
test('known violations need a reason', () => {
  assert.throws(() => loadKnownViolations({ violations: [KV('x', { reason: '' })] }), /reason/);
});
test('the committed known-violations file: exact versions, nothing never-allowed', () => {
  const k = loadKnownViolations(JSON.parse(readFileSync(join(ROOT, 'licenses', 'known-violations.json'), 'utf8')));
  for (const v of k.violations) {
    if (v.ecosystem === 'python') { assert.ok(v.licence, `${v.name}: python entries are keyed on package + licence`); assert.equal(v.version, undefined, `${v.name}: no version for python`); }
    else assert.ok(v.version && v.version !== '*', v.name);
    assert.notEqual(evaluateExpression(v.licence ?? '', policy).verdict, 'forbid', `${v.name} (${v.licence}) is never allowed and cannot be listed`);
  }
  assert.ok(!k.violations.some((v) => /forgejo/i.test(v.name)), 'Forgejo is not deployed');
});
test('Forgejo is not deployed, so no licence document lists it as a component', () => {
  for (const f of ['licenses/components.tsv', 'THIRD-PARTY-LICENSES.md', 'licenses/source-offer.md', 'deploy/stackit']) {
    assert.ok(!/forgejo/i.test(readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => !/Conftest|\.forgejo\//.test(l)).join('\n')), `${f} still mentions Forgejo`);
  }
});
test('pip: an unlisted classifier stays unknown (never a guess); an exact short licence string can decide', () => {
  const report = { install: [
    { metadata: { name: 'amb-resolved', version: '1', license: 'BSD-2-Clause', classifier: ['License :: OSI Approved :: Artistic License'] } },
    { metadata: { name: 'amb-open', version: '1', classifier: ['License :: OSI Approved :: Artistic License'] } },
    { metadata: { name: 'mit0', version: '1', license_expression: 'MIT-0' } },
  ] };
  const by = Object.fromEntries(checkAll(scanPipReport(report), { policy, exceptions: NO_EXC, noticesText: 'amb-resolved\nmit0\n' }).map((r) => [r.name, r]));
  assert.equal(by['amb-resolved'].status, 'pass'); assert.equal(by['amb-open'].status, 'fail'); assert.equal(by.mit0.status, 'pass');
});

// ---- built images (scripts/license-gate-image.mjs, 2026-11-24) ---------------------------------
const INV = {
  python: [
    { name: 'litellm', version: '1.109.1', license_expression: 'MIT', classifier: [], license: '' },
    { name: 'tiktoken', version: '0.14.0', license_expression: '', classifier: [], license: 'MIT License\n\nCopyright (c) 2022 OpenAI' },
    { name: 'litellm-enterprise', version: '0.1.82', license_expression: 'LicenseRef-Proprietary', classifier: [], license: '' },
  ],
  embedded: [
    { name: 'litellm/xxhash-rust', version: '0.8.18', expression: 'BSL-1.0' },
    { name: 'litellm/xxhash-rust', version: '0.8.18', expression: 'BSL-1.0' },
    { name: 'litellm/business', version: '1', expression: 'BUSL-1.1' },
  ],
  npm: [{ name: 'prisma', version: '5.4.2', expression: 'Apache-2.0', path: '/opt/prisma/binaries/node_modules/prisma' }],
};
test('image inventory: site-packages judged like pip, embedded SBOM components and npm packages counted once each', () => {
  const deps = scanImageInventory(INV, 'img');
  assert.deepEqual(deps.map((d) => `${d.ecosystem}:${d.name}`).sort(),
    ['embedded:litellm/business', 'embedded:litellm/xxhash-rust', 'npm:prisma', 'python:litellm', 'python:litellm-enterprise', 'python:tiktoken']);
  const by = Object.fromEntries(checkAll(deps, { policy, exceptions: NO_EXC, noticesText: 'litellm/xxhash-rust\n' }).map((r) => [r.name, r]));
  assert.equal(by['litellm-enterprise'].status, 'fail', 'a proprietary licence is never allowed');
  assert.equal(by['litellm/xxhash-rust'].status, 'pass', 'BSL-1.0 is the Boost licence: allowed, attributed');
  assert.equal(by['litellm/business'].verdict, 'forbid', 'BUSL-1.1 (Business Source) stays forbidden');
  assert.equal(by.tiktoken.status, 'fail', 'a long licence text is not a licence id: unknown until declared');
});
test('image licence overrides: only the exact version, only where nothing is declared, else stale', () => {
  const deps = scanImageInventory(INV, 'img');
  const ov = [
    { ecosystem: 'python', name: 'tiktoken', version: '0.14.0', licence: 'MIT', evidence: 'METADATA License text' },
    { ecosystem: 'python', name: 'litellm', version: '1.109.1', licence: 'Apache-2.0', evidence: 'would mask a declared licence' },
    { ecosystem: 'python', name: 'tiktoken', version: '0.13.0', licence: 'MIT', evidence: 'old version' },
    { ecosystem: 'python', name: 'not-in-this-image', version: '1', licence: 'MIT', evidence: 'another image' },
  ];
  const stale = applyLicenceOverrides(deps, ov);
  assert.equal(deps.find((d) => d.name === 'tiktoken').expression, 'MIT');
  assert.equal(deps.find((d) => d.name === 'litellm').expression, 'MIT', 'a declared licence is never overridden');
  assert.deepEqual(stale.map((o) => `${o.name}@${o.version}`), ['litellm@1.109.1', 'tiktoken@0.13.0']);
});
test('image licence overrides: npm "SEE LICENSE IN <file>" counts as no declaration; a real id still wins (negative twin)', () => {
  const deps = [
    { ecosystem: 'npm', name: 'a', version: '1', expression: 'SEE LICENSE IN LICENSE' },
    { ecosystem: 'npm', name: 'b', version: '1', expression: 'MIT' },
  ];
  const stale = applyLicenceOverrides(deps, [
    { ecosystem: 'npm', name: 'a', version: '1', licence: 'Apache-2.0', evidence: 'its LICENSE file' },
    { ecosystem: 'npm', name: 'b', version: '1', licence: 'Apache-2.0', evidence: 'would mask MIT' },
  ]);
  assert.equal(deps[0].expression, 'Apache-2.0');
  assert.equal(deps[1].expression, 'MIT', 'a declared licence id is never overridden');
  assert.deepEqual(stale.map((o) => o.name), ['b']);
});
test('the committed image overrides and image ratchet are well-formed', () => {
  const o = JSON.parse(readFileSync(join(ROOT, 'licenses', 'image-licence-overrides.json'), 'utf8')).overrides;
  for (const x of o) {
    for (const k of ['ecosystem', 'name', 'version', 'licence', 'evidence', 'reviewedBy', 'date']) assert.ok(x[k], `${x.name}: ${k}`);
    assert.notEqual(x.version, '*', `${x.name}: exact version`);
    assert.equal(evaluateExpression(x.licence, policy).verdict, 'allow', `${x.name}: an override declares an allowed licence`);
  }
  const k = JSON.parse(readFileSync(join(ROOT, 'licenses', 'known-violations.images.json'), 'utf8')).violations;
  for (const v of k) assert.notEqual(evaluateExpression(v.licence, policy).verdict, 'forbid', `${v.name}: never-allowed licences cannot be listed`);
});
test('image exceptions (owner sign-off 2026-11-24): scoped, exact, reasoned, reviewed; only weak copyleft', () => {
  const e = loadExceptions(join(ROOT, 'licenses', 'exceptions.images.json')).exceptions;
  assert.deepEqual(e.map((x) => x.name).sort(), ['certifi', 'orjson', 'psycopg', 'tqdm'], 'exactly the four packages the owner signed off');
  for (const x of e) {
    assert.equal(x.scope, 'litellm-oss', `${x.name}: scoped to the litellm-oss image`);
    assert.notEqual(x.version, '*', `${x.name}: an exact version, so a bump needs a new review`);
    assert.equal(x.condition, 'unmodified-not-linked', x.name);
    assert.equal(x.date, '2026-11-24', x.name);
    assert.match(x.review, /2027-05-24/, `${x.name}: carries the latest re-review date`);
    assert.match(x.reason, /unmodified/i, `${x.name}: the reason says it ships unmodified`);
    assert.ok(/owner/i.test(x.reviewedBy), `${x.name}: owner sign-off`);
  }
  // Not in the repo-wide file: the exception must not reach other images or the repo gate.
  const repo = loadExceptions(join(ROOT, 'licenses', 'exceptions.json')).exceptions;
  assert.ok(!repo.some((x) => ['psycopg', 'certifi', 'orjson', 'tqdm'].includes(x.name)));
  // The image gate runs with --strict (no ratchet), so a bumped certifi is a NEW finding and its signed-off
  // exception becomes unused (which the gate reports as stale): the repo-wide floating ratchet cannot hide it.
  const bumped = checkAll([{ ecosystem: 'python', name: 'certifi', version: '2027.1.1', expression: 'MPL-2.0' }], { policy, exceptions: { exceptions: e }, noticesText: 'certifi' });
  assert.equal(bumped[0].status, 'fail', 'a bumped certifi fails');
  assert.ok(bumped.unusedExceptions.some((x) => x.name === 'certifi'), 'the 2026.10.19 sign-off no longer matches');
  // A scoped exception can never cover a GPL, forbidden or unknown licence (policy check applies as usual).
  const r = checkAll([{ ecosystem: 'python', name: 'psycopg', version: '3.3.6', expression: 'AGPL-3.0-only' }], { policy, exceptions: { exceptions: e }, noticesText: 'psycopg' });
  assert.equal(r[0].status, 'fail');
});
test('image inventory flags a plain enterprise/ directory inside litellm or site-packages (negative twins pass)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'inv-'));
  try {
    const sp = join(tmp, 'venv', 'site-packages');
    for (const d of ['litellm/enterprise', 'litellm/proxy/enterprise', 'enterprise', 'litellm/proxy/enterprise_billing', 'otherpkg/enterprise']) mkdirSync(join(sp, d), { recursive: true });
    const r = spawnSync('python3', ['-I', join(ROOT, 'scripts', 'lib', 'image-inventory.py')], { encoding: 'utf8', env: { ...process.env, IMAGE_INVENTORY_SCAN_ROOTS: tmp } });
    assert.equal(r.status, 0, r.stderr);
    const flagged = JSON.parse(r.stdout).forbidden.filter((f) => f.startsWith('enterprise directory')).map((f) => f.slice(f.indexOf('site-packages')));
    assert.deepEqual(flagged.sort(), ['site-packages/enterprise', 'site-packages/litellm/enterprise', 'site-packages/litellm/proxy/enterprise']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
// langfuse-oss (2026-11-24): the Langfuse images are node:alpine without Python, so the gate reads an
// exported root filesystem (--rootfs) and the inventory flags every trace of the Langfuse Enterprise Edition.
function inventoryOfRootfs(build) {
  const tmp = mkdtempSync(join(tmpdir(), 'rootfs-'));
  try {
    build(tmp);
    const r = spawnSync('python3', ['-I', join(ROOT, 'scripts', 'lib', 'image-inventory.py'), '/app/node_modules'],
      { encoding: 'utf8', env: { ...process.env, IMAGE_INVENTORY_ROOTFS: tmp } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const put = (root, rel, text = '') => { mkdirSync(join(root, dirname(rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
test('image inventory flags every Langfuse EE trace in an exported rootfs (the upstream layout)', () => {
  const inv = inventoryOfRootfs((t) => {
    put(t, 'app/node_modules/.pnpm/node_modules/@langfuse/ee/package.json', '{"name":"@langfuse/ee","version":"1.0.0"}');
    put(t, 'app/worker/dist/ee/dataRetention/handleDataRetentionSchedule.js', 'x');
    put(t, 'app/web/src/ee/features/billing/x.ts', 'x');
    put(t, 'app/web/.next/server/chunks/ssr/abc.js', 'module "[project]/web/src/ee/features/billing/server/x.ts" {}');
  });
  const f = inv.forbidden.join('\n');
  assert.match(f, /langfuse ee package .*@langfuse\/ee/);
  assert.match(f, /langfuse ee directory \/app\/worker\/dist\/ee/);
  assert.match(f, /langfuse ee directory \/app\/web\/src\/ee/);
  assert.match(f, /langfuse ee code \/app\/web\/\.next\/server\/chunks\/ssr\/abc\.js/);
  assert.ok(!f.includes(inv.rootfs || '\0'), 'paths are reported inside the image, without the export directory');
  assert.deepEqual(inv.python, [], 'rootfs mode does not list the host interpreter\'s distributions');
  assert.ok(inv.npm.some((n) => n.name === '@langfuse/ee' && n.path.startsWith('/app/node_modules/')), 'npm roots are read inside the rootfs');
});
test('image inventory: the MIT parts of Langfuse named "ee" and clean build output are not flagged (negative twins)', () => {
  const inv = inventoryOfRootfs((t) => {
    put(t, 'app/packages/shared/dist/src/server/ee/licenseCheck/index.js', 'isEnterpriseLicenseAvailable');
    put(t, 'app/node_modules/.pnpm/node_modules/@langfuse/shared/package.json', '{"name":"@langfuse/shared","version":"1.0.0","license":"MIT"}');
    put(t, 'app/web/.next/server/chunks/ssr/def.js', 'module "[project]/web/src/features/oss-unavailable/unavailable.ts" {}');
    put(t, 'app/worker/dist/oss-unavailable/unavailable.js', 'x');
  });
  assert.deepEqual(inv.forbidden, []);
});
test('image inventory: an EE fingerprint string inside Next.js output is flagged; without it, not (negative twin)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fp-'));
  const fp = join(tmp, 'fp.txt');
  writeFileSync(fp, 'a distinctive sentence only the removed module had\n');
  try {
    for (const [text, flagged] of [['x="a distinctive sentence only the removed module had";', true], ['x="an ordinary MIT sentence of the same length here";', false]]) {
      const root = mkdtempSync(join(tmpdir(), 'rootfs-'));
      put(root, 'app/web/.next/static/chunks/c.js', text);
      const r = spawnSync('python3', ['-I', join(ROOT, 'scripts', 'lib', 'image-inventory.py')],
        { encoding: 'utf8', env: { ...process.env, IMAGE_INVENTORY_ROOTFS: root, IMAGE_INVENTORY_LANGFUSE_FINGERPRINTS: fp } });
      rmSync(root, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr);
      const f = JSON.parse(r.stdout).forbidden;
      assert.equal(f.some((x) => x === 'langfuse ee code /app/web/.next/static/chunks/c.js (fingerprint)'), flagged, text);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('the image gate refuses --rootfs without an image and documents the Langfuse scope', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'license-gate-image.mjs'), 'utf8');
  assert.match(src, /--rootfs/);
  assert.match(src, /docker', \['export'/);
});
test('the litellm-oss image ships the full GPL-3.0 (for LGPL-3.0) and MPL-2.0 texts, identical to licenses/', () => {
  for (const f of ['GPL-3.0.txt', 'MPL-2.0.txt']) {
    assert.equal(readFileSync(join(ROOT, 'images', 'extensions', 'litellm-oss', 'licenses', f), 'utf8'), readFileSync(join(ROOT, 'licenses', f), 'utf8'), f);
  }
});

// ---- every accepted licence: its text and its obligations (owner, 2026-11-24) -----------------
const TPL = readFileSync(join(ROOT, 'THIRD-PARTY-LICENSES.md'), 'utf8');
const OBLIGATIONS = TPL.slice(TPL.indexOf('## Licence obligations by type'), TPL.indexOf('\n## ', TPL.indexOf('## Licence obligations by type') + 5));
const textFile = (id) => join(ROOT, 'licenses', `${id.replace(/-(only|or-later)$/, '')}.txt`);
test('every allowed licence id has its full text in licenses/ and a row in "Licence obligations by type"', () => {
  assert.ok(OBLIGATIONS.length > 1000, 'the obligations section exists');
  assert.match(OBLIGATIONS, /not legal advice/i);
  for (const id of policy.allow) {
    assert.ok(existsSync(textFile(id)), `licenses/${id}.txt is missing`);
    assert.ok(readFileSync(textFile(id), 'utf8').trim().length > 50, `licenses/${id}.txt is empty`);
    assert.ok(OBLIGATIONS.includes(`| \`${id}\``), `no obligations row for ${id}`);
  }
});
test('every licence of a reviewed exception has its text and an obligations row too', () => {
  const ids = new Set(['LGPL-3.0-only', 'MPL-2.0', 'GPL-2.0-only']);
  for (const id of ids) {
    assert.ok(existsSync(textFile(id)), `licenses/${textFile(id).split('/').pop()} is missing`);
    assert.ok(OBLIGATIONS.includes(`| \`${id}\``), `no obligations row for ${id}`);
  }
});
test('the litellm-oss image carries the text of every licence its packages are under, identical to licenses/', () => {
  const dir = join(ROOT, 'images', 'extensions', 'litellm-oss', 'licenses');
  const notices = readFileSync(join(ROOT, 'licenses', 'notices', 'litellm-oss-image.md'), 'utf8');
  const chosen = new Set(['MIT', 'Apache-2.0', 'GPL-3.0-only']); // MIT/Apache are not listed (exempt from attribution); GPL-3.0 is incorporated by LGPL-3.0
  for (const l of notices.split('\n')) { const c = l.split('|')[4]; if (l.startsWith('| ') && c && !/Licence|---/.test(c)) for (const id of c.split(' AND ')) chosen.add(id.trim()); }
  for (const id of chosen) {
    const f = join(dir, textFile(id).split('/').pop());
    assert.ok(existsSync(f), `images/extensions/litellm-oss/licenses/${textFile(id).split('/').pop()} is missing (used by a package in the image)`);
  }
  for (const f of readdirSync(dir)) assert.equal(readFileSync(join(dir, f), 'utf8'), readFileSync(join(ROOT, 'licenses', f), 'utf8'), `${f} differs from licenses/${f}`);
});
test('the five ids and two overrides added for litellm-oss carry the owner approval, not a pending marker', () => {
  const p = readFileSync(join(ROOT, 'licenses', 'policy.json'), 'utf8');
  assert.ok(!/pending owner review/i.test(p)); assert.match(p, /owner approval 2026-11-24/);
  for (const id of ['Unicode-3.0', 'Unicode-DFS-2016', 'BSL-1.0', 'CDLA-Permissive-2.0', 'CNRI-Python']) assert.ok(policy.allow.includes(id), id);
  for (const o of JSON.parse(readFileSync(join(ROOT, 'licenses', 'image-licence-overrides.json'), 'utf8')).overrides) assert.match(o.reviewedBy, /^owner approval \d{4}-\d{2}-\d{2}/, `${o.name}: an image licence override needs the owner's approval (reviewedBy: "owner approval <date> ...")`);
});
