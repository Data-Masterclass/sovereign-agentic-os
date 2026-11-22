#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Keep sharp (and its LGPL libvips) out of a golden-path template lockfile.
 * USER STORY: As the owner I want no LGPL package in the lockfile an app ships with.
 * ARCHITECTURE: Next.js lists `sharp` as an OPTIONAL dependency, so npm always resolves it. The template sets
 *             `images.unoptimized`, so nothing uses it. This removes `sharp`, every `@img/*` package, the
 *             `sharp` entry of next's optionalDependencies and whatever only they pulled in, from a lockfile
 *             written by npm, leaving every other resolution byte-identical. Re-run it after
 *             regen-golden-path-lock.mjs. Verify with `npm ci --ignore-scripts` in an instantiated app.
 *               node os-ui/scripts/strip-lock-sharp.mjs templates/nextjs-web/package-lock.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function stripSharp(lock) {
  const pk = lock.packages;
  for (const k of Object.keys(pk)) if (/(^|\/)node_modules\/(sharp|@img\/[^/]+)$/.test(k)) delete pk[k];
  for (const v of Object.values(pk)) {
    if (v.optionalDependencies?.sharp) {
      delete v.optionalDependencies.sharp;
      if (Object.keys(v.optionalDependencies).length === 0) delete v.optionalDependencies;
    }
  }
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const cand = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (pk[cand]) return cand;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i < 0 ? '' : base.slice(0, i);
    }
  };
  const seen = new Set(['']);
  const queue = [''];
  while (queue.length) {
    const p = queue.pop();
    const e = pk[p];
    if (e.link && pk[e.resolved] && !seen.has(e.resolved)) { seen.add(e.resolved); queue.push(e.resolved); }
    for (const group of [e.dependencies, e.optionalDependencies, e.peerDependencies, p === '' ? e.devDependencies : undefined]) {
      for (const name of Object.keys(group ?? {})) {
        const r = resolve(p, name);
        if (r && !seen.has(r)) { seen.add(r); queue.push(r); }
      }
    }
  }
  const pruned = Object.keys(pk).filter((k) => !seen.has(k));
  for (const k of pruned) delete pk[k];
  return pruned;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const before = Object.keys(lock.packages).length;
  const pruned = stripSharp(lock);
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`strip-lock-sharp: ${before} -> ${Object.keys(lock.packages).length} packages; unreachable after removal: ${pruned.join(', ') || 'none'}`);
}
