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
 *             program we merely ship - every binary is statically linked. Reviewed resolutions for components the scanner
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

/** Every path the builder image may contain (directories implied). Anything else fails: no shell, no package manager. */
export const EXPECTED_FILES = [
  'etc/group', 'etc/passwd', 'etc/subuid', 'etc/subgid',
  'usr/local/bin/buildctl', 'usr/local/bin/buildkitd', 'usr/local/bin/crane', 'usr/local/bin/newgidmap',
  'usr/local/bin/newuidmap', 'usr/local/bin/rootlesskit', 'usr/local/bin/runc', 'usr/local/bin/zot-users',
];
// Families that fail in this image whatever policy.json says about exceptions.
const FORBIDDEN_RE = /(^|[^A-Z])(A?GPL|LGPL|MPL|BUSL|BSL|SSPL|EUPL|CC-BY-SA|CC-BY-NC|Elastic|Commons-Clause)/i;

/** Pure: the verdict for one SBOM. `policy` from licenses/policy.json, `overrides` from sbom-overrides.json. */
export function judge(sbom, { policy, overrides = [], files } = {}) {
  const findings = []; const passed = [];
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
    if (bad.length && !(o && /\bOR\b/.test(expr) && ev.verdict === 'allow')) {
      findings.push({ component: at, reason: `forbidden in the builder image: ${[...new Set(bad)].join(', ')} (licence "${expr}")` });
      continue;
    }
    if (ev.verdict !== 'allow') { findings.push({ component: at, reason: `licence "${expr}" is ${ev.verdict} under licenses/policy.json (${(ev.why || []).join('; ')})` }); continue; }
    passed.push({ component: at, licence: expr, resolved: Boolean(o) });
  }
  if (files) {
    for (const f of files) if (!EXPECTED_FILES.includes(f)) findings.push({ component: `/${f}`, reason: 'file not expected in the builder image (the image holds the pinned binaries only: no shell, no package manager)' });
    for (const f of EXPECTED_FILES) if (!files.includes(f)) findings.push({ component: `/${f}`, reason: 'expected file missing from the image' });
  }
  return { findings, passed };
}

function main() {
  const sbomFile = val('--sbom') || die('--sbom FILE is required');
  const policy = loadPolicy(join(ROOT, 'licenses', 'policy.json'));
  const overrides = JSON.parse(readFileSync(join(ROOT, 'images', 'base', 'builder', 'sbom-overrides.json'), 'utf8')).overrides;
  const filesArg = val('--files');
  // A tar listing: drop directories, Docker's runtime placeholders and leading "./".
  const runtime = new Set(['.dockerenv', 'dev/console', 'etc/hostname', 'etc/hosts', 'etc/mtab', 'etc/resolv.conf']);
  const files = filesArg ? readFileSync(filesArg, 'utf8').split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter((l) => l && !l.endsWith('/') && !runtime.has(l)) : undefined;
  const { findings, passed } = judge(JSON.parse(readFileSync(sbomFile, 'utf8')), { policy, overrides, files });
  if (argv.includes('--json')) { console.log(JSON.stringify({ findings, passed }, null, 2)); process.exit(findings.length ? 1 : 0); }
  console.log(`builder SBOM: ${passed.length} component(s) permissive${files ? `, ${files.length} file(s) checked` : ''}, ${findings.length} finding(s)`);
  for (const f of findings) console.log(`  FAIL ${f.component}: ${f.reason}`);
  process.exit(findings.length ? 1 : 0);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
