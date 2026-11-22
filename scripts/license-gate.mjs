#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    The licence gate - enforces licenses/policy.json over npm, Python and container components
 * USER STORY: As the owner I want CI to fail on AGPL / source-available dependencies, on copyleft without a reviewed
 *             exception (reason + condition), on unknown licences without a reviewed reason, and on missing attribution - and to say which option of a
 *             dual licence was chosen.
 * ARCHITECTURE: Thin CLI over scripts/lib/license-policy.mjs. Sources, all read from the repo:
 *               npm      os-ui/package-lock.json and the app-scaffold lockfiles
 *                        (os-ui/tabs/software/lib/scaffolds/locks/*.package-lock.json)
 *               python   every image's pip specs (images/**\/Dockerfile RUN pip install, requirements*.txt),
 *                        resolved by `pip install --dry-run --report` (--python-resolve; needs network + pip >= 22.2)
 *               component licenses/components.tsv (container images, charts, Go binaries; bundled=no rows are skipped)
 * Usage:   node scripts/license-gate.mjs [--ecosystem npm|python|component]... [--npm-lock FILE]...
 *               [--node-modules DIR]... [--manifest FILE] [--python-resolve] [--include-dev] [--json]
 *               [--policy FILE] [--exceptions FILE] [--known FILE] [--strict] [--write-attributions] [--write-known]
 *          --strict ignores licenses/known-violations.json (the ratchet of findings that existed when the policy
 *          started) and fails on every finding. Without it, listed findings are printed but only NEW ones, or
 *          STALE list entries (fixed upstream, still listed), fail.
 * Exit:    0 pass, 1 findings, 2 usage/config error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyKnownViolations, checkAll, extractPipSpecs, loadExceptions, loadKnownViolations, loadPolicy, scanManifest, scanNodeModules, scanNpmLock, scanPipReport,
} from './lib/license-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const values = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const one = (n, d) => values(n)[0] ?? d;
const die = (m) => { console.error(`license-gate: ${m}`); process.exit(2); };

let policy, exceptions;
try {
  policy = loadPolicy(resolve(one('--policy', join(ROOT, 'licenses', 'policy.json'))));
  exceptions = loadExceptions(resolve(one('--exceptions', join(ROOT, 'licenses', 'exceptions.json'))));
} catch (e) { die(`config error: ${e.message}`); }

const only = values('--ecosystem');
const want = (e) => only.length === 0 || only.includes(e);
const explicit = values('--npm-lock').length || values('--node-modules').length || values('--manifest').length;
const includeDev = flag('--include-dev');
const rel = (p) => relative(ROOT, p) || p;
let deps = [];

// npm ---------------------------------------------------------------------------------------------
if (want('npm')) {
  let locks = values('--npm-lock').map((p) => resolve(p));
  if (!explicit) {
    locks = [join(ROOT, 'os-ui', 'package-lock.json')];
    const d = join(ROOT, 'os-ui', 'tabs', 'software', 'lib', 'scaffolds', 'locks');
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('package-lock.json')) locks.push(join(d, f));
  }
  for (const f of locks) {
    if (!existsSync(f)) die(`missing lockfile ${f}`);
    deps.push(...scanNpmLock(JSON.parse(readFileSync(f, 'utf8')), { includeDev, source: rel(f) }));
  }
  for (const d of values('--node-modules')) deps.push(...scanNodeModules(resolve(d), rel(resolve(d))));
}

// python ------------------------------------------------------------------------------------------
function findFiles(dir, re, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) findFiles(p, re, out); else if (re.test(e.name)) out.push(p);
  }
  return out;
}
if (want('python') && flag('--python-resolve')) {
  const imgDir = join(ROOT, 'images');
  const files = findFiles(imgDir, /^(Dockerfile|requirements.*\.txt)$/);
  const byDir = new Map();
  for (const f of files) {
    const specs = extractPipSpecs(readFileSync(f, 'utf8'), f.split('/').pop());
    if (!specs.length) continue;
    byDir.set(dirname(f), { specs: [...(byDir.get(dirname(f))?.specs ?? []), ...specs], files: [...(byDir.get(dirname(f))?.files ?? []), f] });
  }
  for (const [dir, { specs, files: fs }] of byDir) {
    const dockerfile = fs.find((f) => f.endsWith('Dockerfile')) ?? join(dir, 'Dockerfile');
    const pyver = (existsSync(dockerfile) ? readFileSync(dockerfile, 'utf8') : '').match(/^FROM\s+python:(\d+\.\d+)/m)?.[1] ?? '3.12';
    const tmp = mkdtempSync(join(tmpdir(), 'licgate-')); const report = join(tmp, 'report.json');
    // Resolve NATIVELY with the interpreter that runs the gate (CI: python 3.12 on linux, the images' own).
    // `--python-version/--platform` would force --only-binary, and some pins ship only an sdist
    // (dbt-core-experimental-parser): a wheels-only resolve cannot see them.
    const py = process.env.PYTHON || 'python3';
    const have = spawnSync(py, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).stdout.trim();
    if (have !== pyver) console.log(`warn  ${rel(dir)} is built on python ${pyver} but the gate resolves with python ${have}; versions may differ from the image (CI uses ${pyver})`);
    const r = spawnSync(py, ['-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--quiet', '--no-input', '--report', report,
      '--target', join(tmp, 't'), ...specs], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(report)) { rmSync(tmp, { recursive: true, force: true }); die(`pip could not resolve ${rel(dir)} (python ${have}): ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`); }
    deps.push(...scanPipReport(JSON.parse(readFileSync(report, 'utf8')), `${rel(dir)} (pip, python ${have})`));
    rmSync(tmp, { recursive: true, force: true });
  }
}

// container / Go / chart components ---------------------------------------------------------------
if (want('component')) {
  const mf = values('--manifest')[0] ?? (explicit ? null : join(ROOT, 'licenses', 'components.tsv'));
  if (mf) { if (!existsSync(mf)) die(`missing manifest ${mf}`); deps.push(...scanManifest(readFileSync(mf, 'utf8'), rel(resolve(mf)))); }
}

// notices -----------------------------------------------------------------------------------------
const noticesText = policy.noticesFiles.map((f) => join(ROOT, f)).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
  + '\n' + (existsSync(join(ROOT, 'licenses', 'notices')) ? readdirSync(join(ROOT, 'licenses', 'notices')).map((f) => readFileSync(join(ROOT, 'licenses', 'notices', f), 'utf8')).join('\n') : '');

if (flag('--write-attributions')) {
  // Regenerates the machine-listed attribution section: every dependency whose chosen licence is not Apache-2.0/MIT.
  const rows = checkAll(deps, { policy, exceptions, noticesText: '' }).filter((r) => r.status !== 'fail' || r.reasons.some((x) => /attribution/.test(x))).filter((r) => (r.verdict === 'allow' || r.verdict === 'exceptable') && r.needsAttribution && r.ecosystem !== 'component')
    .sort((a, b) => (a.ecosystem + a.name).localeCompare(b.ecosystem + b.name));
  // Keep rows an earlier run produced: a Python pin resolves differently per interpreter (3.12 pulls greenlet,
  // 3.13 does not), and an attribution for a dependency we may ship must not vanish because a laptop runs 3.13.
  const file = join(ROOT, 'licenses', 'ATTRIBUTIONS.md');
  const keep = new Map();
  for (const l of existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []) { const m = l.match(/^\| ([^|]+) \| ([^|]+) \| (npm|python) \|/); if (m) keep.set(`${m[3]}:${m[1].trim()}`, l); }
  for (const r of rows) keep.set(`${r.ecosystem}:${r.name}`, `| ${r.name} | ${r.version} | ${r.ecosystem} | ${r.chosen.join(' AND ')} | ${String(r.expression).replace(/\|/g, '/')} |`);
  const table = [...keep.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, l]) => l);
  const lines = ['<!-- SPDX-License-Identifier: Apache-2.0 -->', '# Attributions (generated)', '',
    'Every dependency of the OS, its images and its app scaffolds whose chosen licence is not Apache-2.0 or MIT.',
    'Regenerate with `node scripts/license-gate.mjs --write-attributions` after a dependency change; the gate',
    '(`scripts/license-gate.mjs`) fails when a listed-by-policy dependency has no entry here or in',
    '`THIRD-PARTY-LICENSES.md`. Full licence texts: `licenses/<SPDX-ID>.txt` and the package\'s own tarball.', '',
    '| Package | Version | Ecosystem | Licence (chosen) | Declared as |', '|---|---|---|---|---|',
    ...table, ''];
  writeFileSync(join(ROOT, 'licenses', 'ATTRIBUTIONS.md'), lines.join('\n'));
  console.log(`wrote licenses/ATTRIBUTIONS.md (${table.length} entries)`); process.exit(0);
}

const results = checkAll(deps, { policy, exceptions, noticesText });
const scanned = [...new Set([...deps.map((d) => d.ecosystem), ...(want('python') && flag('--python-resolve') ? ['python'] : [])])];
const knownFile = resolve(one('--known', join(ROOT, 'licenses', 'known-violations.json')));
const known = flag('--strict') || !existsSync(knownFile) ? { violations: [] } : (() => { try { return loadKnownViolations(knownFile); } catch (e) { return die(`config error: ${e.message}`); } })();
const fails = results.filter((r) => r.status === 'fail');

if (flag('--write-known')) {
  const seen = new Set(); const violations = [];
  for (const r of fails) {
    if (r.verdict === 'forbid') continue; // never-allowed licences can never be listed: they must be fixed
    const py = r.ecosystem === 'python';
    const k = py ? `${r.ecosystem}:${r.name}:${r.expression}` : `${r.ecosystem}:${r.name}@${r.version}`; if (seen.has(k)) continue; seen.add(k);
    violations.push({ ecosystem: r.ecosystem, name: r.name, ...(py ? {} : { version: r.version }), licence: String(r.expression || 'none'), reason: 'Found by the first run of the 2026-11-22 policy on main; owner decision pending (replace, remove or add a reviewed exception). ' + r.reasons[0] });
  }
  const prev = existsSync(knownFile) ? loadKnownViolations(knownFile).violations.filter((x) => !scanned.includes(x.ecosystem)) : [];
  writeFileSync(knownFile, JSON.stringify({ _comment: ['Ratchet of licence-gate findings that existed on main when the 2026-11-22 policy was introduced.',
    'NOT a waiver: every run prints each entry, `node scripts/license-gate.mjs --strict` fails on them, and an entry whose package is',
    'fixed or gone is STALE and fails the gate, so this list can only shrink. New findings always fail. An entry names an EXACT version (python: package + licence, the version floats with the index);',
    'AGPL, EUPL and source-available licences can never be listed. Python entries are only checked when the gate runs with --python-resolve.'], violations: [...prev, ...violations] }, null, 2) + '\n');
  console.log(`wrote ${rel(knownFile)} (${violations.length} entries for ${scanned.join(', ')})`); process.exit(0);
}
const { known: knownHits, newFailures, stale, unchecked } = applyKnownViolations(results, known, { scanned });
if (flag('--json')) { console.log(JSON.stringify({ checked: results.length, newFailures, known: knownHits, stale, unchecked, unusedExceptions: results.unusedExceptions }, null, 2)); process.exit(newFailures.length || stale.length ? 1 : 0); }

console.log('== Sovereign Agentic OS - licence gate (policy 2026-11-22) ==');
console.log(`policy: ${rel(resolve(one('--policy', join(ROOT, 'licenses', 'policy.json'))))}  exceptions: ${exceptions.exceptions.length}  known violations: ${known.violations.length}  dev deps: ${includeDev ? 'included' : 'excluded'}`);
const tally = {}; for (const r of results) { tally[r.ecosystem] = (tally[r.ecosystem] || 0) + 1; }
console.log(`checked ${results.length} (${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'})`);
for (const r of results.filter((x) => x.status === 'pass' && /\bOR\b|\//.test(String(x.expression)) && x.chosen.length)) console.log(`dual  ${r.ecosystem}:${r.name}@${r.version}  ${r.expression} -> chosen ${r.chosen.join(' AND ')}`);
for (const r of results.filter((x) => x.note)) console.log(`exc   ${r.ecosystem}:${r.name}@${r.version}  ${r.note}`);
for (const r of knownHits) console.log(`KNOWN ${r.ecosystem}:${r.name}@${r.version}  [${r.expression || 'no licence'}]  ${r.reasons[0]}  (${r.source})`);
for (const r of newFailures) console.log(`FAIL  ${r.ecosystem}:${r.name}@${r.version}  [${r.expression || 'no licence'}]  ${r.reasons.join('; ')}  (${r.source})`);
for (const x of stale) console.log(`STALE known violation ${x.ecosystem}:${x.name}${x.version ? `@${x.version}` : ` [${x.licence}]`} no longer fails - remove it from licenses/known-violations.json`);
if (unchecked.length) console.log(`note  ${unchecked.length} known-violation entr${unchecked.length === 1 ? 'y' : 'ies'} for ${[...new Set(unchecked.map((x) => x.ecosystem))].join(', ')} NOT checked this run (ecosystem not scanned; python needs --python-resolve)`);
for (const x of results.unusedExceptions) console.log(`warn  unused exception ${x.ecosystem}:${x.name}@${x.version} - remove it from licenses/exceptions.json`);
if (newFailures.length || stale.length) { console.log(`\nLICENCE GATE: FAIL - ${newFailures.length} new finding(s), ${stale.length} stale known-violation entr${stale.length === 1 ? 'y' : 'ies'}.`); process.exit(1); }
if (knownHits.length) { console.log(`\nLICENCE GATE: PASS with ${knownHits.length} KNOWN violation(s) still open - owner decision pending (node scripts/license-gate.mjs --strict fails on them).`); process.exit(0); }
console.log('\nLICENCE GATE: PASS');
