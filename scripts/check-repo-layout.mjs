#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    REPO-LAYOUT rule — repository paths come from `os-ui/core/infra/repo-layout.ts` only
 * USER STORY: As a maintainer I want CI to refuse new code that spells a repository path by hand
 *             (`'agents/…'`, `'data/dbt/…'`, `'os/….yml'`, `` `${domain}.git` ``), so a layout change
 *             stays one edit in one module (component design 12, rule 4).
 * ARCHITECTURE:
 *   - A WP-01-style ratchet, kept in its own script (scripts/check-glue.mjs is another WP's):
 *     the number of hand-built repo paths per file may only go DOWN. The baseline
 *     (`scripts/repo-layout-baseline.json`) records today's backlog; `--baseline` rewrites it.
 *   - Regex over string and template literals in os-ui source (tests, fixtures and repo-layout.ts
 *     itself excluded). A literal counts when it STARTS with a repository folder of the layout.
 *     Dagster tags such as `'os/dataset'` are not paths and do not match (only `os/…` literals that
 *     end in a file name or `/` do).
 *   - `--root <dir>` runs it on another tree (the negative-twin test).
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const repo = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const write = args.includes('--baseline');
const BASELINE = join(repo, 'scripts', 'repo-layout-baseline.json');
const EXEMPT = new Set(['os-ui/core/infra/repo-layout.ts']);

const RULES = [
  // a top-level folder of the layout, then a path segment
  /(['"`])(?:data\/dbt|data\/dagster|agents|dashboards|apps|knowledge|connections)\/(?:[A-Za-z0-9_.${}<>-]+)/g,
  // an OS-layer FILE or folder (tags like 'os/dataset' have no extension and no trailing slash)
  /(['"`])os\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+\.(?:ya?ml|json)\1/g,
  /(['"`])os\/[A-Za-z0-9_-]+\/(?:\1|[A-Za-z0-9_$<{-])/g,
  // the legacy personal lanes
  /(['"`])models\/personal\//g,
  // a repository directory spelled by hand
  /`[^`\n]*\$\{[^}]+\}\.git[`/]/g,
];

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e.startsWith('.') || e === 'fixtures' || e === 'vendor') continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const counts = {};
for (const sub of ['core', 'tabs', 'app', 'lib', 'worker']) {
  for (const f of walk(join(repo, 'os-ui', sub))) {
    const rel = relative(repo, f);
    if (!/\.(ts|tsx|mjs)$/.test(f) || /\.test\.|\.d\.ts$/.test(f) || EXEMPT.has(rel)) continue;
    const src = stripComments(readFileSync(f, 'utf8'));
    let n = 0;
    for (const re of RULES) n += (src.match(re) ?? []).length;
    if (n) counts[rel] = n;
  }
}

if (write) {
  writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2)}\n`);
  console.log(`check-repo-layout: baseline written (${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} paths)`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const worse = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0));
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const was = Object.values(baseline).reduce((a, b) => a + b, 0);
if (worse.length) {
  for (const [f, n] of worse) {
    console.log(`REPO-LAYOUT  ${f} — ${n} hand-built repository path(s), baseline ${baseline[f] ?? 0}: import the path from @core/infra/repo-layout instead`);
  }
  process.exit(1);
}
console.log(`check-repo-layout: ok — ${total} hand-built path(s) left in the backlog${total < was ? ` (${was - total} fewer than the baseline; run --baseline to lock it in)` : ''}`);
