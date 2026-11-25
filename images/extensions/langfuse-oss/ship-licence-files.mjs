#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * ship-licence-files.mjs <installed node_modules> <shipped node_modules> <path in image> <manifest out>
 *
 * WHY. Next.js's standalone output (web/.next/standalone) copies only the files its tracer saw the server
 * load, so almost every package in it arrives WITHOUT its LICENSE / COPYING / NOTICE file. Redistributing
 * MIT, ISC, BSD or Apache-2.0 code requires those notices. This copies them back.
 *
 * For every directory under <shipped> that holds a package.json (installed packages, and packages vendored
 * in a dist/compiled/ tree), the licence files (LICENSE*, LICENCE*, COPYING*, NOTICE*, any case) of the
 * directory at the SAME relative path under <installed> are copied next to it, unless already present.
 * Symlinks are not followed. (For the worker, <installed> and <shipped> are the same tree: nothing is
 * copied, only the manifest is written.)
 *
 * The MANIFEST lists, as paths inside the image (<path in image>/<relative path>), every shipped package
 * directory that still has no licence file because its INSTALLED twin has none either (nothing upstream to
 * ship). The image licence gate (`--licence-texts`) accepts a package without a licence file only when it is
 * on this list and the image's texts directory has the text of its licence; a package whose file was
 * dropped by the build is not on the list, so it fails. A shipped package with no installed twin is
 * reported and left off the list (the gate then fails on it).
 */
import { copyFileSync, existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const [installed, shipped, inImage, manifest] = process.argv.slice(2);
if (!installed || !shipped || !inImage || !manifest || !existsSync(installed) || !existsSync(shipped)) {
  console.error('usage: ship-licence-files.mjs <installed node_modules> <shipped node_modules> <path in image> <manifest out>'); process.exit(2);
}
const LICENCE = /^(licen[cs]e|copying|notice)/i;
let packages = 0, copied = 0, packagesFixed = 0;
const orphans = [], noneUpstream = [];

function walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  if (names.includes('package.json')) {
    packages++;
    const rel = relative(shipped, dir);
    const src = join(installed, rel);
    if (!existsSync(src)) { if (!names.some((n) => LICENCE.test(n))) orphans.push(rel); }
    else if (!names.some((n) => LICENCE.test(n))) {
      const files = readdirSync(src).filter((n) => LICENCE.test(n) && lstatSync(join(src, n)).isFile());
      for (const f of files) { copyFileSync(join(src, f), join(dir, f)); copied++; }
      if (files.length) packagesFixed++; else noneUpstream.push(`${inImage.replace(/\/$/, '')}/${rel}`);
    }
  }
  for (const n of names.sort()) {
    const p = join(dir, n);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
  }
}
walk(shipped);
writeFileSync(manifest, noneUpstream.join('\n') + (noneUpstream.length ? '\n' : ''));
console.log(`ship-licence-files: ${packages} package directories; ${copied} licence files copied into ${packagesFixed}; ${noneUpstream.length} have none upstream (listed in ${manifest})`);
if (orphans.length) {
  console.warn(`ship-licence-files: WARNING ${orphans.length} shipped package(s) without a licence file have no installed twin, e.g.:\n  ${orphans.slice(0, 10).join('\n  ')}`);
}
