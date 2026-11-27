#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    App Builder (workstream C1) - the image-level licence gate of the BUILDER image.
 * USER STORY: As the owner I want the image that builds every app image to contain permissive code only, judged on
 *             the built bytes: any GPL, LGPL, AGPL, MPL, BSL/BUSL, SSPL, EUPL, CC-BY-SA or CC-BY-NC component fails, and so
 *             does any component whose licence is unknown, and any file the image was not meant to contain.
 * ARCHITECTURE: input = a CycloneDX SBOM of the image (syft with Go module licences resolved from the module proxy:
 *             SYFT_GOLANG_SEARCH_REMOTE_LICENSES=true syft <image> -o cyclonedx-json=<file>) and, optionally, the image's
 *             file list (`crane export <ref> - | tar -t` / `docker export`). Licences are classified by licenses/policy.json
 *             through scripts/lib/license-policy.mjs (the repo gate's own classifier); this gate is STRICTER than the repo
 *             gate: an `exceptable` licence (MPL, LGPL, GPL program) also fails, because nothing in this image is a separate
 *             program we merely ship - every binary is statically linked. ONE narrow exception (owner, 2026-11-27): MPL-2.0 is
 *             accepted for exactly the module paths in MPL_MODULES, at the exact versions of the scope-"builder" entries of
 *             licenses/exceptions.images.json, and only where the SBOM locates them inside the upstream binaries in
 *             MPL_BINARIES (buildkitd, buildctl, runc, rootlesskit) - never in our zot-users/require-userns, never in crane.
 *             Any other MPL module, another version, another binary, or any other copyleft family still fails; an entry
 *             that matches nothing (a BuildKit/runc bump) fails as stale. Reviewed resolutions for components the scanner
 *             cannot read live in images/base/builder/sbom-overrides.json; a resolution can say what a licence IS, never
 *             waive a forbidden one. The C components the scanner cannot see (runc's nsenter C, shadow's newuidmap/newgidmap,
 *             musl) are inventoried in licenses/fragments/c1.json, which the repo gate reads.
 * Usage:      node scripts/check-builder-sbom.mjs --sbom FILE [--files FILE] [--json]
 * Exit:       0 pass, 1 findings, 2 usage error.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateExpression, loadPolicy } from './lib/license-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m) => { console.error(`check-builder-sbom: ${m}`); process.exit(2); };

/** The MPL-2.0 attribution the image must carry (owner exception 2026-11-27): a NOTICE, the MPL-2.0 text, and each excepted
 * module's own upstream licence files, copied verbatim from the vendor/ tree that was compiled (images/base/builder/Dockerfile). */
export const LICENCE_FILES = [
  'licenses/NOTICE', 'licenses/MPL-2.0.txt',
  'licenses/go/github.com/cyphar/filepath-securejoin@v0.7.0/COPYING.md',
  'licenses/go/github.com/cyphar/filepath-securejoin@v0.7.0/LICENSE.BSD',
  'licenses/go/github.com/cyphar/filepath-securejoin@v0.7.0/LICENSE.MPL-2.0',
  'licenses/go/github.com/hashicorp/go-cleanhttp@v0.5.2/LICENSE',
  'licenses/go/github.com/hashicorp/go-immutable-radix/v2@v2.1.0/LICENSE',
  'licenses/go/github.com/hashicorp/go-retryablehttp@v0.7.8/LICENSE',
  'licenses/go/github.com/hashicorp/golang-lru/v2@v2.0.7/LICENSE',
  'licenses/go/github.com/hashicorp/golang-lru/v2@v2.0.7/simplelru/LICENSE_list',
];
/** Every path the builder image may contain (directories implied). Anything else fails: no shell, no package manager. */
export const EXPECTED_FILES = [
  ...LICENCE_FILES,
  'etc/group', 'etc/passwd', 'etc/subuid', 'etc/subgid',
  'usr/local/bin/buildctl', 'usr/local/bin/buildkitd', 'usr/local/bin/crane', 'usr/local/bin/newgidmap',
  'usr/local/bin/newuidmap', 'usr/local/bin/require-userns', 'usr/local/bin/rootlesskit', 'usr/local/bin/runc', 'usr/local/bin/zot-users',
];
// Families that fail in this image whatever policy.json says about exceptions.
const FORBIDDEN_RE = /(^|[^A-Z])(A?GPL|LGPL|MPL|BUSL|BSL|SSPL|EUPL|CC-BY-SA|CC-BY-NC|Elastic|Commons-Clause)/i;

/** Owner exception 2026-11-27: the ONLY modules that may carry MPL-2.0 in this image, by exact Go module path. Version-pinned
 * through licenses/exceptions.images.json (scope "builder"). Kept in code too, so widening it needs a code AND a data review. */
export const MPL_MODULES = Object.freeze([
  'github.com/hashicorp/go-immutable-radix/v2',
  'github.com/hashicorp/go-retryablehttp',
  'github.com/hashicorp/go-cleanhttp',
  'github.com/hashicorp/golang-lru/v2',
  'github.com/cyphar/filepath-securejoin',
]);
/** The unmodified upstream programs the excepted modules may be linked into. Not crane, not our zot-users/require-userns. */
export const MPL_BINARIES = Object.freeze(['/usr/local/bin/buildkitd', '/usr/local/bin/buildctl', '/usr/local/bin/runc', '/usr/local/bin/rootlesskit']);
export const MPL_SCOPE = 'builder';

/** The scope-"builder" entries of licenses/exceptions.images.json, validated. Throws on anything outside the owner's grant. */
export function loadBuilderExceptions(json) {
  const list = (json?.exceptions || []).filter((x) => x.scope === MPL_SCOPE);
  for (const x of list) {
    const id = `${x.name}@${x.version}`;
    if (x.ecosystem !== 'go') throw new Error(`${id}: a builder exception is a Go module (ecosystem "go")`);
    if (!MPL_MODULES.includes(x.name)) throw new Error(`${id}: not one of the module paths the owner excepted (${MPL_MODULES.join(', ')})`);
    if (!/^v\d+\.\d+\.\d+$/.test(x.version || '')) throw new Error(`${id}: needs an exact module version (vX.Y.Z), never "*"`);
    if (x.condition !== 'unmodified-not-linked') throw new Error(`${id}: condition must be unmodified-not-linked`);
    for (const k of ['reason', 'reviewedBy', 'date', 'review']) if (typeof x[k] !== 'string' || !x[k].trim()) throw new Error(`${id}: "${k}" is required`);
  }
  return list;
}

/** Pure: the verdict for one SBOM. `policy` from licenses/policy.json, `overrides` from sbom-overrides.json,
 * `mplExceptions` from loadBuilderExceptions (default none: then every MPL module fails, as before 2026-11-27). */
export function judge(sbom, { policy, overrides = [], files, mplExceptions = [] } = {}) {
  const findings = []; const passed = []; const used = new Set();
  const mplPolicy = { ...policy, _allow: new Map([...policy._allow, ['mpl-2.0', 'MPL-2.0']]) };
  const ov = (name, version) => overrides.find((o) => o.name === name && (o.version === '*' || o.version === version));
  for (const c of sbom.components || []) {
    if (c.type === 'file') continue; // binaries without package metadata: covered by the file list and the fragment
    const name = c.name; const version = c.version || '';
    const ids = []; const unidentified = [];
    for (const l of c.licenses || []) {
      const v = l.expression || l.license?.id || l.license?.name || '';
      if (!v) continue;
      if (/^sha256:/.test(v)) unidentified.push(v); else ids.push(v);
    }
    const o = ov(name, version);
    // The scanner lists every licence file it found; read them together (AND) - the conservative reading.
    const expr = o ? o.spdx : [...new Set(ids)].map((x) => (/\s/.test(x) ? `(${x})` : x)).join(' AND ');
    const where = (c.properties || []).filter((p) => p.name.startsWith('syft:location')).map((p) => p.value).filter((v) => v.startsWith('/'));
    const at = `${name}@${version || '?'}${where.length ? ` in ${[...new Set(where)].join(', ')}` : ''}`;
    if (!expr) { findings.push({ component: at, reason: `no licence identified${unidentified.length ? ` (${unidentified.length} unclassified licence file(s))` : ''}; add a reviewed resolution to images/base/builder/sbom-overrides.json` }); continue; }
    const bad = expr.split(/\s+(?:AND|OR)\s+|[()]/).map((s) => s.trim()).filter((s) => s && FORBIDDEN_RE.test(s));
    const ev = evaluateExpression(expr, policy);
    // The narrow MPL-2.0 exception: exact module path + exact version, MPL-2.0 the only non-permissive atom, and every
    // location an upstream binary. Anything short of all of that falls through to the normal "forbidden" finding.
    if (bad.length && !o && MPL_MODULES.includes(name) && bad.every((b) => b === 'MPL-2.0')) {
      const x = mplExceptions.find((e) => e.name === name && e.version === version);
      const pinned = mplExceptions.filter((e) => e.name === name).map((e) => e.version);
      if (x) {
        const locs = [...new Set(where)];
        const outside = locs.filter((l) => !MPL_BINARIES.includes(l));
        if (!locs.length || outside.length) {
          findings.push({ component: at, reason: `MPL-2.0 is excepted for ${name} only inside ${MPL_BINARIES.join(', ')}; found ${locs.length ? `in ${outside.join(', ')}` : 'without a location'}` });
          continue;
        }
        const mev = evaluateExpression(expr, mplPolicy);
        if (mev.verdict !== 'allow') { findings.push({ component: at, reason: `licence "${expr}" is ${mev.verdict} even with the MPL-2.0 exception (${(mev.why || []).join('; ')})` }); continue; }
        used.add(x);
        passed.push({ component: at, licence: expr, resolved: false, excepted: 'MPL-2.0, owner exception 2026-11-27 (licenses/exceptions.images.json, scope builder)' });
        continue;
      }
      if (pinned.length) { findings.push({ component: at, reason: `MPL-2.0 is excepted for ${name} only at ${pinned.join(', ')}; ${version || '?'} needs a new owner review in licenses/exceptions.images.json` }); continue; }
    }
    if (bad.length && !(o && /\bOR\b/.test(expr) && ev.verdict === 'allow')) {
      findings.push({ component: at, reason: `forbidden in the builder image: ${[...new Set(bad)].join(', ')} (licence "${expr}")` });
      continue;
    }
    if (ev.verdict !== 'allow') { findings.push({ component: at, reason: `licence "${expr}" is ${ev.verdict} under licenses/policy.json (${(ev.why || []).join('; ')})` }); continue; }
    passed.push({ component: at, licence: expr, resolved: Boolean(o) });
  }
  for (const x of mplExceptions) if (!used.has(x)) findings.push({ component: `${x.name}@${x.version}`, reason: 'STALE MPL-2.0 exception (licenses/exceptions.images.json, scope builder) matches nothing in the image - a BuildKit/runc bump needs a new owner review' });
  if (files) {
    for (const f of files) if (!EXPECTED_FILES.includes(f)) findings.push({ component: `/${f}`, reason: 'file not expected in the builder image (the image holds the pinned binaries and their licence files only: no shell, no package manager)' });
    for (const f of EXPECTED_FILES) if (!files.includes(f)) findings.push({ component: `/${f}`, reason: 'expected file missing from the image' });
  }
  return { findings, passed };
}

function main() {
  const sbomFile = val('--sbom') || die('--sbom FILE is required');
  const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
  const overrides = JSON.parse(readFileSync(join(ROOT, 'images', 'base', 'builder', 'sbom-overrides.json'), 'utf8')).overrides;
  let mplExceptions;
  try { mplExceptions = loadBuilderExceptions(JSON.parse(readFileSync(join(ROOT, 'licenses', 'exceptions.images.json'), 'utf8'))); } catch (e) { die(`licenses/exceptions.images.json: ${e.message}`); }
  const filesArg = val('--files');
  // A tar listing: drop directories, Docker's runtime placeholders and leading "./".
  const runtime = new Set(['.dockerenv', 'dev/console', 'etc/hostname', 'etc/hosts', 'etc/mtab', 'etc/resolv.conf']);
  const files = filesArg ? readFileSync(filesArg, 'utf8').split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter((l) => l && !l.endsWith('/') && !runtime.has(l)) : undefined;
  const { findings, passed } = judge(JSON.parse(readFileSync(sbomFile, 'utf8')), { policy, overrides, files, mplExceptions });
  if (argv.includes('--json')) { console.log(JSON.stringify({ findings, passed }, null, 2)); process.exit(findings.length ? 1 : 0); }
  const exc = passed.filter((p) => p.excepted);
  for (const p of exc) console.log(`  MPL-2.0 (owner exception 2026-11-27) ${p.component}: ${p.licence}`);
  console.log(`builder SBOM: ${passed.length - exc.length} component(s) permissive, ${exc.length} MPL-2.0 under the owner exception${files ? `, ${files.length} file(s) checked` : ''}, ${findings.length} finding(s)`);
  for (const f of findings) console.log(`  FAIL ${f.component}: ${f.reason}`);
  process.exit(findings.length ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
