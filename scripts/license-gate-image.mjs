#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    The licence gate for a BUILT image - judges what is actually installed, not what a
 *             requirements file asks for.
 * USER STORY: As the owner I want CI to fail when our LiteLLM gateway image contains the proprietary
 *             litellm-enterprise code, or any package whose licence licenses/policy.json does not allow.
 * ARCHITECTURE: Runs scripts/lib/image-inventory.py inside the image (`docker run --entrypoint python
 *             <image> -I -`), which lists every installed Python distribution, the components compiled
 *             into a wheel (its embedded CycloneDX SBOM), the npm packages of the given node_modules
 *             trees, and every trace of `litellm_enterprise`. Then applies the SAME policy, exceptions,
 *             notices and known-violation ratchet as scripts/license-gate.mjs (scripts/lib/license-policy.mjs).
 *             Ecosystems: python (as the repo gate), embedded and npm.
 *             A trace of litellm_enterprise ALWAYS fails; it cannot be excepted or ratcheted.
 *             The ratchet is applied only to entries whose package is in this image, so the repo-wide
 *             list does not report the other images' entries as stale here.
 * Usage:   node scripts/license-gate-image.mjs --image REF [--scope NAME] [--node-modules DIR]... [--json] [--strict]
 *               [--write-notices FILE]
 *          --scope         also apply the reviewed exceptions of licenses/exceptions.images.json whose `scope` is NAME
 *                          (e.g. litellm-oss). An exception of that scope that matches nothing (a version bump) fails.
 *          --node-modules  node_modules roots inside the image (default /opt/prisma/binaries/node_modules)
 *          --write-notices write the attribution file for this image's non-MIT/Apache licences and exit
 * Exit:    0 pass, 1 findings, 2 usage/config error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyKnownViolations, applyLicenceOverrides, checkAll, loadExceptions, loadKnownViolations, loadPolicy, scanImageInventory,
} from './lib/license-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const values = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const die = (m) => { console.error(`license-gate-image: ${m}`); process.exit(2); };

const image = values('--image')[0] || die('--image REF is required');
const nodeRoots = values('--node-modules').length ? values('--node-modules') : ['/opt/prisma/binaries/node_modules'];
const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
const repoExceptions = loadExceptions(join(ROOT, 'licenses', 'exceptions.json')).exceptions;
const scope = values('--scope')[0] || '';
const imageExcFile = join(ROOT, 'licenses', 'exceptions.images.json');
const scoped = scope && existsSync(imageExcFile)
  ? loadExceptions(imageExcFile).exceptions.filter((x) => x.scope === scope)
  : [];
if (scope && scoped.some((x) => !x.review || !x.date)) die(`every exception of scope ${scope} needs a date and a review note`);
// An image exception is signed off for ONE version: '*' would let a bump through without a new review.
if (scope && scoped.some((x) => x.version === '*' || !/^[0-9A-Za-z][0-9A-Za-z.+!_-]*$/.test(x.version))) {
  die(`exceptions of scope ${scope} need an exact version, never "*" (licenses/exceptions.images.json)`);
}
const exceptions = { exceptions: [...repoExceptions, ...scoped] };

// ---- inventory, read inside the image ------------------------------------------------------------
const r = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'python', image, '-I', '-', ...nodeRoots],
  { input: readFileSync(join(ROOT, 'scripts', 'lib', 'image-inventory.py')), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) die(`could not read the inventory of ${image}: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' | ')}`);
let inv;
try { inv = JSON.parse(r.stdout); } catch (e) { die(`the inventory of ${image} is not JSON: ${e.message}`); }
const deps = scanImageInventory(inv, image);
const overridesFile = join(ROOT, 'licenses', 'image-licence-overrides.json');
const overrides = existsSync(overridesFile) ? JSON.parse(readFileSync(overridesFile, 'utf8')).overrides || [] : [];
const staleOverrides = applyLicenceOverrides(deps, overrides);

// ---- notices -----------------------------------------------------------------------------------------
const noticeDir = join(ROOT, 'licenses', 'notices');
const noticesText = policy.noticesFiles.map((f) => join(ROOT, f)).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
  + '\n' + (existsSync(noticeDir) ? readdirSync(noticeDir).map((f) => readFileSync(join(noticeDir, f), 'utf8')).join('\n') : '');

if (values('--write-notices').length) {
  const file = resolve(values('--write-notices')[0]);
  const rows = checkAll(deps, { policy, exceptions, noticesText: '' })
    .filter((x) => (x.verdict === 'allow' || x.verdict === 'exceptable') && x.chosen.some((id) => !policy.attributionExempt.includes(id)))
    .sort((a, b) => (a.ecosystem + a.name).localeCompare(b.ecosystem + b.name));
  const lines = ['<!-- SPDX-License-Identifier: Apache-2.0 -->', `# Attributions: ${image.replace(/@sha256:.*/, '')} (generated)`, '',
    'Every package in the LiteLLM gateway image (images/extensions/litellm-oss) whose chosen licence is not Apache-2.0 or MIT,',
    'read from the BUILT image by `node scripts/license-gate-image.mjs --image <ref> --write-notices <this file>`.',
    '`embedded` rows are components compiled into a wheel, listed in that wheel\'s own SBOM (`*.dist-info/sboms/`).',
    'Each package\'s licence text ships inside the image next to it (`*.dist-info/licenses/`, `node_modules/*/LICENSE`).', '',
    '| Package | Version | Ecosystem | Licence (chosen) | Declared as |', '|---|---|---|---|---|',
    ...[...new Map(rows.map((x) => [`${x.ecosystem}:${x.name}`, `| ${x.name} | ${x.version} | ${x.ecosystem} | ${x.chosen.join(' AND ')} | ${String(x.expression).replace(/\|/g, '/')} |`])).values()], ''];
  writeFileSync(file, lines.join('\n'));
  console.log(`wrote ${relative(ROOT, file)} (${rows.length} entries)`); process.exit(0);
}

// ---- judge ---------------------------------------------------------------------------------------
const results = checkAll(deps, { policy, exceptions, noticesText });
const knownFile = join(ROOT, 'licenses', 'known-violations.json');
const allKnown = flag('--strict') ? { violations: [] } : loadKnownViolations(knownFile);
// Ratchet entries apply only to packages present here AND not covered by a reviewed exception: an excepted
// package passes, so its repo-wide ratchet entry (for other images) must not read as stale in this image.
const excepted = new Set(results.filter((x) => x.note).map((x) => `${x.ecosystem}:${x.name}`));
const present = new Set(deps.map((d) => `${d.ecosystem}:${d.name}`).filter((k) => !excepted.has(k)));
// The repo-wide list applies to the packages present here; the image list (licenses/known-violations.images.json)
// applies in full, so an entry for a package this image no longer has is stale.
const imageKnownFile = join(ROOT, 'licenses', 'known-violations.images.json');
const imageKnown = flag('--strict') || !existsSync(imageKnownFile) ? { violations: [] } : loadKnownViolations(imageKnownFile);
const known = { violations: [...allKnown.violations.filter((x) => present.has(`${x.ecosystem}:${x.name}`)), ...imageKnown.violations] };
const { known: knownHits, newFailures, stale: staleKnown } = applyKnownViolations(results, known, { scanned: ['python', 'embedded', 'npm'] });
const unusedScoped = results.unusedExceptions.filter((x) => scoped.includes(x));
const stale = [...staleKnown, ...staleOverrides.map((o) => ({ ...o, override: true })), ...unusedScoped.map((x) => ({ ...x, exception: true }))];
const forbidden = [...new Set(inv.forbidden)];

if (flag('--json')) {
  console.log(JSON.stringify({ image, python: inv.pythonVersion, checked: results.length, forbidden, newFailures, known: knownHits, stale }, null, 2));
  process.exit(forbidden.length || newFailures.length || stale.length ? 1 : 0);
}
console.log(`== licence gate for a built image (policy 2026-11-22): ${image}`);
const tally = {}; for (const x of results) tally[x.ecosystem] = (tally[x.ecosystem] || 0) + 1;
console.log(`python ${inv.pythonVersion}; checked ${results.length} (${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')})`);
for (const x of results.filter((y) => y.status === 'pass' && /\bOR\b|\//.test(String(y.expression)) && y.chosen.length)) console.log(`dual  ${x.ecosystem}:${x.name}@${x.version}  ${x.expression} -> chosen ${x.chosen.join(' AND ')}`);
for (const x of results.filter((y) => y.note)) console.log(`exc   ${x.ecosystem}:${x.name}@${x.version}  ${x.note}`);
for (const x of knownHits) console.log(`KNOWN ${x.ecosystem}:${x.name}@${x.version}  [${x.expression || 'no licence'}]  ${x.reasons[0]}`);
for (const x of newFailures) console.log(`FAIL  ${x.ecosystem}:${x.name}@${x.version}  [${x.expression || 'no licence'}]  ${x.reasons.join('; ')}`);
for (const x of stale) console.log(x.exception
  ? `STALE image exception ${x.ecosystem}:${x.name}@${x.version} (scope ${x.scope}) matches nothing in the image - a version bump needs a new owner review in licenses/exceptions.images.json`
  : x.override
  ? `STALE licence override ${x.ecosystem}:${x.name}@${x.version} - the package is at another version or now declares a licence itself: review licenses/image-licence-overrides.json`
  : `STALE known violation ${x.ecosystem}:${x.name} no longer fails - remove it from licenses/known-violations.json`);
for (const x of deps.filter((d) => d.declaredBy)) console.log(`decl  ${x.ecosystem}:${x.name}@${x.version}  ${x.expression}  (declared by ${x.declaredBy.split(' (')[0]})`);
if (forbidden.length) {
  for (const f of forbidden) console.log(`ENTERPRISE  ${f}`);
  console.log('\nIMAGE LICENCE GATE: FAIL - the proprietary LiteLLM enterprise code is in the image (never allowed, never excepted).');
  process.exit(1);
}
console.log('enterprise: no litellm_enterprise distribution, module or path in the image');
if (newFailures.length || stale.length) { console.log(`\nIMAGE LICENCE GATE: FAIL - ${newFailures.length} new finding(s), ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}.`); process.exit(1); }
if (knownHits.length) { console.log(`\nIMAGE LICENCE GATE: PASS with ${knownHits.length} KNOWN violation(s) still open - owner decision pending (--strict fails on them).`); process.exit(0); }
console.log('\nIMAGE LICENCE GATE: PASS');
