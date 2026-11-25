#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * prepare-source.mjs — turns a checkout of Langfuse (MIT core + Enterprise Edition) into a source tree
 * WITHOUT any code under the Langfuse Enterprise License, ready for the upstream build.
 * Runs in the Dockerfile's `source` stage:  node prepare-source.mjs <checkout> <overlay> <fingerprints-out>
 *
 *  1. fingerprints  Collects the string literals (>= 24 chars) of the EE directories that occur nowhere in
 *                   the MIT source, into <fingerprints-out>. The built output is later searched for every
 *                   one of them (verify-build.sh). They stay in the build stages; nothing of EE reaches the
 *                   repository or the image.
 *  2. delete        The three directories Langfuse's root LICENSE puts under the EE licence: ee/, web/src/ee/,
 *                   worker/src/ee/; and the MIT test files that import from them (they test EE code).
 *  3. overlay       Copies our original stubs (web/src/features/oss-unavailable, worker/src/oss-unavailable)
 *                   and one replaced MIT file (web/src/components/nav/in-app-ai-agent-button.tsx).
 *  4. rewrite       Points every import of an EE module at the stub of the same name.
 *  5. workspace     Drops the `@langfuse/ee` workspace package: web/package.json, pnpm-workspace.yaml and
 *                   its two entries in pnpm-lock.yaml (exact edits; each must apply exactly once).
 *  6. verify        Fails if any EE directory, EE import or `@langfuse/ee` reference remains.
 * Deterministic; Node standard library only.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [root, overlay, fpOut] = process.argv.slice(2);
if (!root || !overlay || !fpOut) { console.error('usage: prepare-source.mjs <checkout> <overlay> <fingerprints-out>'); process.exit(2); }
const die = (m) => { console.error(`prepare-source: ${m}`); process.exit(1); };
const say = (m) => console.log(`prepare-source: ${m}`);

// The directories Langfuse's root LICENSE names (v3.194.1): "ee/", "web/src/ee/", "worker/src/ee/".
const EE_DIRS = ['ee', 'web/src/ee', 'worker/src/ee'];
// packages/shared/src/server/ee/ is NOT among them: the root LICENSE makes it MIT. It stays.
const SRC_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', '.git']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) { if (!SKIP_DIRS.has(n)) walk(p, out); } else out.push(p);
  }
  return out;
}
const isEe = (rel) => EE_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));

// ---- 0. the licence statement we rely on has not changed ---------------------------------------
const lic = readFileSync(join(root, 'LICENSE'), 'utf8');
if (!lic.includes('"ee/", "web/src/ee/", and/or "worker/src/ee/"')) {
  die('the root LICENSE no longer names exactly ee/, web/src/ee/, worker/src/ee/ as EE: re-review before building');
}
for (const d of EE_DIRS) if (!existsSync(join(root, d))) die(`expected EE directory ${d} is missing: re-review the upstream layout`);

// ---- 1. fingerprints ------------------------------------------------------------------------------
const literal = /"((?:[^"\\\n]|\\.){24,})"|'((?:[^'\\\n]|\\.){24,})'|>\s*([^<>{}\n]{24,}?)\s*</g;
const all = walk(root).filter((p) => SRC_EXT.test(p)).map((p) => ({ rel: relative(root, p), text: readFileSync(p, 'utf8') }));
const eeFiles = all.filter((f) => isEe(f.rel));
const mitText = all.filter((f) => !isEe(f.rel)).map((f) => f.text).join('\n');
const fps = new Set();
for (const f of eeFiles) {
  for (const m of f.text.matchAll(literal)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (s.length < 24 || s.includes("\n") || !/[a-z].*\s.*[a-z]/i.test(s) || /\\/.test(s)) continue; // words, no escapes
    if (mitText.includes(s)) continue;
    fps.add(s);
  }
}
writeFileSync(fpOut, [...fps].sort().join('\n') + '\n');
say(`${eeFiles.length} EE source files; ${fps.size} fingerprint strings -> ${fpOut}`);
if (fps.size < 50) die('implausibly few fingerprints: the EE layout changed, re-review');

// ---- 2. delete ------------------------------------------------------------------------------------
const eeImport = /(["'`])(@\/src\/ee\/|(?:\.\.\/)+ee\/|\.\/ee\/)[^"'`]*\1|@langfuse\/ee\b/;
const testFile = /(^|\/)__tests__\/|\.(test|spec|servertest|clienttest)\.(ts|tsx|mts)$/;
const deletedTests = [];
for (const f of all) {
  if (isEe(f.rel) || f.rel.startsWith('packages/shared/src/server/ee/')) continue;
  if (testFile.test(f.rel) && eeImport.test(f.text)) { rmSync(join(root, f.rel)); deletedTests.push(f.rel); }
}
for (const d of EE_DIRS) rmSync(join(root, d), { recursive: true, force: true });
say(`deleted ${EE_DIRS.join(', ')} and ${deletedTests.length} MIT test files that import EE code:`);
for (const t of deletedTests) console.log(`  - ${t}`);

// ---- 3. overlay -------------------------------------------------------------------------------------
cpSync(overlay, root, { recursive: true });
say(`copied the overlay (${walk(overlay).length} files)`);

// ---- 4. rewrite EE imports to the stubs ------------------------------------------------------------
const rewrites = [
  // @/src/ee/features/<x> -> @/src/features/oss-unavailable/<x>: every EE import of the web is under
  // ee/features/; anything else stays and fails the verification below.
  { dir: 'web', from: /(["'`])@\/src\/ee\/features\//g, to: '$1@/src/features/oss-unavailable/' },
  { dir: 'worker/src', from: /(["'`])((?:\.\.\/)+)ee\//g, to: '$1$2oss-unavailable/' },
  { dir: 'worker/src', from: /(["'`])\.\/ee\//g, to: '$1./oss-unavailable/' },
];
let changed = 0;
for (const { dir, from, to } of rewrites) {
  for (const p of walk(join(root, dir)).filter((x) => SRC_EXT.test(x))) {
    const t = readFileSync(p, 'utf8');
    const n = t.replace(from, to);
    if (n !== t) { writeFileSync(p, n); changed++; }
  }
}
say(`rewrote EE imports in ${changed} file(s)`);
if (changed < 40) die(`only ${changed} files rewritten (expected ~50): the import layout changed, re-review`);

// ---- 5. drop the @langfuse/ee workspace package ------------------------------------------------------
function editOnce(rel, from, to) {
  const p = join(root, rel);
  const t = readFileSync(p, 'utf8');
  const hits = t.split(from).length - 1;
  if (hits !== 1) die(`${rel}: expected exactly one match for ${JSON.stringify(from).slice(0, 80)}, found ${hits}`);
  writeFileSync(p, t.replace(from, to));
}
editOnce('web/package.json', '    "@langfuse/ee": "workspace:*",\n', '');
editOnce('pnpm-workspace.yaml', '  - "ee"\n', '');
editOnce('pnpm-lock.yaml', "      '@langfuse/ee':\n        specifier: workspace:*\n        version: link:../ee\n", '');
{ // the `ee:` importer block, up to the next importer
  const p = join(root, 'pnpm-lock.yaml');
  const lines = readFileSync(p, 'utf8').split('\n');
  const start = lines.indexOf('  ee:');
  if (start < 0 || lines.indexOf('  ee:', start + 1) >= 0) die('pnpm-lock.yaml: expected exactly one `  ee:` importer');
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^ {4}/.test(lines[end]))) end++;
  if (!/^ {2}\S/.test(lines[end] || '')) die('pnpm-lock.yaml: the `ee:` importer is not followed by another importer');
  lines.splice(start, end - start);
  writeFileSync(p, lines.join('\n'));
}
say('removed the @langfuse/ee workspace package (web/package.json, pnpm-workspace.yaml, pnpm-lock.yaml)');

// ---- 5b. no sharp / libvips --------------------------------------------------------------------------
// Next.js's optional image optimiser loads `sharp`, whose prebuilt libvips binaries (@img/sharp-libvips-*)
// are LGPL-3.0-or-later. The images ship without them (Dockerfile), so Next serves images unoptimised.
editOnce('web/next.config.mjs', '  output: "standalone",\n',
  '  output: "standalone",\n  // langfuse-oss: no sharp/libvips in the image (LGPL-3.0); images are served as they are.\n  images: { unoptimized: true },\n');
say('web/next.config.mjs: images.unoptimized (no sharp)');

// ---- 6. verify ----------------------------------------------------------------------------------------
const left = [];
for (const d of EE_DIRS) if (existsSync(join(root, d))) left.push(`directory ${d}`);
for (const p of walk(root)) {
  const rel = relative(root, p);
  if (rel.startsWith('packages/shared/src/server/ee/')) continue; // MIT (see above)
  if (/(^|\/)ee(\/|$)/.test(rel) && !rel.startsWith('packages/shared/src/server/ee')) left.push(`path ${rel}`);
  if (!SRC_EXT.test(rel) && !/\.(json|yaml|yml)$/.test(rel)) continue;
  const t = readFileSync(p, 'utf8');
  if (/@\/src\/ee\/|@langfuse\/ee\b/.test(t)) left.push(`reference in ${rel}`);
  if ((rel.startsWith('web/') || rel.startsWith('worker/')) && /(["'`])(?:\.\.\/)+ee\/|(["'`])\.\/ee\//.test(t)) left.push(`relative EE import in ${rel}`);
}
// every rewritten import resolves to a stub file
const resolves = (base) => ['.ts', '.tsx', '/index.ts', '/index.tsx'].some((x) => existsSync(base + x));
for (const p of walk(join(root, 'web')).filter((x) => SRC_EXT.test(x))) {
  for (const m of readFileSync(p, 'utf8').matchAll(/["'`]@\/src\/features\/oss-unavailable\/([^"'`]+)["'`]/g)) {
    if (!resolves(join(root, 'web/src/features/oss-unavailable', m[1]))) left.push(`unresolved stub import ${m[1]} in ${relative(root, p)}`);
  }
}
for (const p of walk(join(root, 'worker/src')).filter((x) => SRC_EXT.test(x))) {
  for (const m of readFileSync(p, 'utf8').matchAll(/["'`]((?:\.\.?\/)+)oss-unavailable\/([^"'`]+)["'`]/g)) {
    if (!resolves(join(p, '..', m[1], 'oss-unavailable', m[2]))) left.push(`unresolved stub import ${m[1]}oss-unavailable/${m[2]} in ${relative(root, p)}`);
  }
}
if (left.length) { for (const l of left) console.error(`  EE LEFT: ${l}`); die(`${left.length} EE trace(s) or unresolved stub(s) remain`); }
say('verified: no EE directory, no EE import, no @langfuse/ee reference');
