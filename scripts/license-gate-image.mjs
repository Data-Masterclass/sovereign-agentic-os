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
 *             A trace of litellm_enterprise or of the Langfuse Enterprise Edition ALWAYS fails; it cannot be
 *             excepted or ratcheted.
 *             --rootfs: for an image WITHOUT Python (langfuse-oss is node:alpine) the image's filesystem is
 *             exported (`docker create` + `docker export`, nothing runs) and the inventory script reads it
 *             from the host's python3 (IMAGE_INVENTORY_ROOTFS); the paths it reports are the image's.
 *             The ratchet is applied only to entries whose package is in this image, so the repo-wide
 *             list does not report the other images' entries as stale here.
 * Usage:   node scripts/license-gate-image.mjs --image REF [--scope NAME] [--node-modules DIR]... [--json] [--strict]
 *               [--write-notices FILE] [--rootfs | --rootfs-dir DIR] [--licence-texts DIR]
 *          --scope         also apply the reviewed exceptions of licenses/exceptions.images.json whose `scope` is NAME
 *                          (e.g. litellm-oss). An exception of that scope that matches nothing (a version bump) fails.
 *          --node-modules  node_modules roots inside the image (default /opt/prisma/binaries/node_modules)
 *          --write-notices write the attribution file for this image's non-MIT/Apache licences and exit
 *          --rootfs        read an exported filesystem instead of running python in the image (see above)
 *          --rootfs-dir DIR  as --rootfs, from a filesystem already exported to DIR (e.g. `crane export <ref> - | tar -x`);
 *                          nothing is created, run or deleted
 *          --licence-texts DIR  (rootfs) every npm package copy must ship its licence text: a LICENSE*, LICENCE*,
 *                          COPYING* or NOTICE* file in its directory; or else it must be listed in
 *                          DIR/../packages-without-licence-file.txt (the build's record of packages that have
 *                          none upstream) AND DIR must hold <id>.txt for every licence chosen for it.
 *          --ee-fingerprints FILE  (with --rootfs) also flag built output containing any of these strings: the
 *                          Langfuse EE fingerprints (`docker build --target ee-fingerprints --output …` of
 *                          images/extensions/langfuse-oss); needed to catch EE code in Next.js chunks
 * Exit:    0 pass, 1 findings, 2 usage/config error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyKnownViolations, applyLicenceOverrides, checkAll, checkLicenceTexts, loadExceptions, loadKnownViolations, loadPolicy, scanImageInventory,
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
const fingerprints = values('--ee-fingerprints')[0] ? resolve(values('--ee-fingerprints')[0]) : '';
if (fingerprints && !existsSync(fingerprints)) die(`--ee-fingerprints ${fingerprints} does not exist`);
const rootfsDir = values('--rootfs-dir')[0] ? resolve(values('--rootfs-dir')[0]) : '';
if (rootfsDir && !existsSync(rootfsDir)) die(`--rootfs-dir ${rootfsDir} does not exist`);
const rootfs = flag('--rootfs') || !!rootfsDir;
const textsDir = values('--licence-texts')[0] || '';
if (fingerprints && !rootfs) die('--ee-fingerprints needs --rootfs');
if (textsDir && !rootfs) die('--licence-texts needs --rootfs');
const inventoryEnv = (dir) => ({ ...process.env, IMAGE_INVENTORY_ROOTFS: dir, IMAGE_INVENTORY_LANGFUSE_FINGERPRINTS: fingerprints, IMAGE_INVENTORY_LICENCE_TEXTS: textsDir });
const runInventory = (dir) => spawnSync(process.env.PYTHON || 'python3', ['-I', join(ROOT, 'scripts', 'lib', 'image-inventory.py'), ...nodeRoots],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: inventoryEnv(dir) });
function inventoryFromRootfs() {
  const dir = mkdtempSync(join(tmpdir(), 'image-rootfs-'));
  const created = spawnSync('docker', ['create', image, 'inventory'], { encoding: 'utf8' });
  if (created.status !== 0) { rmSync(dir, { recursive: true, force: true }); die(`docker create ${image}: ${created.stderr.trim()}`); }
  const id = created.stdout.trim();
  try {
    // docker export | tar -x, without a shell: export to a file first, then unpack it.
    const tarFile = join(dir, '..', `${dir.split('/').pop()}.tar`);
    const ex = spawnSync('docker', ['export', '--output', tarFile, id], { encoding: 'utf8' });
    if (ex.status !== 0) die(`docker export: ${ex.stderr.trim()}`);
    const un = spawnSync('tar', ['-x', '-f', tarFile, '-C', dir], { encoding: 'utf8' });
    rmSync(tarFile, { force: true });
    if (un.status !== 0) die(`tar -x: ${un.stderr.trim().split('\n').slice(-3).join(' | ')}`);
    return runInventory(dir);
  } finally {
    spawnSync('docker', ['rm', id], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
  }
}
const r = rootfsDir ? runInventory(rootfsDir) : flag('--rootfs') ? inventoryFromRootfs()
  : spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'python', image, '-I', '-', ...nodeRoots],
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
    // One row per name AND version, in a fixed order: the file is compared with the committed one in CI, so it
    // must not depend on the order the image's filesystem is walked in.
    .sort((a, b) => (a.ecosystem + a.name).localeCompare(b.ecosystem + b.name, 'en') || String(a.version).localeCompare(String(b.version), 'en', { numeric: true }));
  const lines = ['<!-- SPDX-License-Identifier: Apache-2.0 -->', `# Attributions: ${image.replace(/@sha256:.*/, '')} (generated)`, '',
    `Every package in the ${scope === 'langfuse-oss' ? 'Langfuse image (images/extensions/langfuse-oss)' : 'LiteLLM gateway image (images/extensions/litellm-oss)'} whose chosen licence is not Apache-2.0 or MIT,`,
    'read from the BUILT image by `node scripts/license-gate-image.mjs --image <ref> --write-notices <this file>`.',
    '`embedded` rows are components compiled into a wheel, listed in that wheel\'s own SBOM (`*.dist-info/sboms/`).',
    scope === 'langfuse-oss'
      ? 'Each package\'s own licence file ships next to it (`node_modules/*/LICENSE`, copied from the installed package for the Next.js standalone tree); a package that has none upstream is covered by `/usr/share/licenses/langfuse-oss/texts/<id>.txt` (`--licence-texts`).'
      : 'Each package\'s licence text ships inside the image next to it (`*.dist-info/licenses/`, `node_modules/*/LICENSE`).', '',
    '| Package | Version | Ecosystem | Licence (chosen) | Declared as |', '|---|---|---|---|---|',
    ...[...new Map(rows.map((x) => [`${x.ecosystem}:${x.name}@${x.version}`, `| ${x.name} | ${x.version} | ${x.ecosystem} | ${x.chosen.join(' AND ')} | ${String(x.expression).replace(/\|/g, '/')} |`])).values()], ''];
  writeFileSync(file, lines.join('\n'));
  console.log(`wrote ${relative(ROOT, file)} (${rows.length} entries)`); process.exit(0);
}

// ---- judge ---------------------------------------------------------------------------------------
const results = checkAll(deps, { policy, exceptions, noticesText });
// The licence TEXT of every npm package copy (--licence-texts): a finding like any other, never ratcheted.
const textFindings = textsDir ? checkLicenceTexts(results.filter((x) => x.status === 'pass'), inv.licenceTexts, inv.licenceManifest) : [];
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
newFailures.push(...textFindings);

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
if (textsDir) console.log(`texts: ${results.filter((x) => x.missingTextAt?.length).length} package(s) without their own licence file, covered by ${textsDir} (${(inv.licenceTexts || []).length} texts) and the manifest (${inv.licenceManifest ? inv.licenceManifest.length + ' entries' : 'MISSING'}) unless listed as FAIL`);
for (const x of deps.filter((d) => d.declaredBy)) console.log(`decl  ${x.ecosystem}:${x.name}@${x.version}  ${x.expression}  (declared by ${x.declaredBy.split(' (')[0]})`);
if (forbidden.length) {
  for (const f of forbidden) console.log(`ENTERPRISE  ${f}`);
  console.log('\nIMAGE LICENCE GATE: FAIL - enterprise code (LiteLLM enterprise or the Langfuse Enterprise Edition) is in the image (never allowed, never excepted).');
  process.exit(1);
}
console.log('enterprise: no litellm_enterprise distribution, module or path, and no Langfuse EE package, directory or module path in the image');
if (newFailures.length || stale.length) { console.log(`\nIMAGE LICENCE GATE: FAIL - ${newFailures.length} new finding(s), ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}.`); process.exit(1); }
if (knownHits.length) { console.log(`\nIMAGE LICENCE GATE: PASS with ${knownHits.length} KNOWN violation(s) still open - owner decision pending (--strict fails on them).`); process.exit(0); }
console.log('\nIMAGE LICENCE GATE: PASS');
