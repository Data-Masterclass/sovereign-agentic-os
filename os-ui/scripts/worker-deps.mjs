#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    Copy the npm packages the run worker needs into the Next standalone output.
 * USER STORY: As the operator I want one image that serves os-ui AND runs `os-ui-worker`; the
 *             worker must boot from it without a hand-kept dependency list.
 * ARCHITECTURE: Runs in the Dockerfile's builder stage after `next build`. (1) Loads the worker's
 *             whole import graph under --experimental-strip-types with `worker/resolve-hook.mjs`
 *             plus `worker/trace-deps.mjs`, which records every bare specifier and where it resolved.
 *             (2) Maps each resolved file to its package root (nearest ancestor with a package.json
 *             whose name matches the specifier's package). (3) Closes over each package's declared
 *             `dependencies`, resolving them the way Node does (own node_modules, then each ancestor's)
 *             so lazily-imported deps (langsmith inside @langchain/core) are included even though the
 *             static trace never saw them. (4) Copies every package directory into `<out>` at the SAME
 *             path relative to the project root, overwriting nft's pruned partial copies, so resolution
 *             in the image mirrors the builder exactly. Usage: `node scripts/worker-deps.mjs --out
 *             .next/standalone [--entry worker/agent-runs.ts]`. Exit 1 on any failure — a worker that
 *             cannot load is a build failure, not a boot surprise.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const ROOT = process.cwd();
const OUT = resolvePath(ROOT, opt('--out', '.next/standalone'));
const ENTRY = opt('--entry', 'worker/agent-runs.ts');
const OPTIONAL = new Set((opt('--optional', '') || '').split(',').filter(Boolean));

function pkgNameOf(specifier) {
  const m = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/);
  return m ? m[1] : specifier;
}

// --- 1. trace -----------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'worker-deps-'));
const traceFile = join(tmp, 'trace.tsv');
const entryUrl = pathToFileURL(resolvePath(ROOT, ENTRY)).href;
const base = pathToFileURL(ROOT + sep).href;
const program = [
  "import { register } from 'node:module';",
  `register('./worker/trace-deps.mjs', ${JSON.stringify(base)});`,
  `register('./worker/resolve-hook.mjs', ${JSON.stringify(base)});`,
  `const m = await import(${JSON.stringify(entryUrl)});`,
  "if (typeof m.main !== 'function') { console.error('entry exports no main()'); process.exit(2); }",
].join('\n');
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program], {
  cwd: ROOT,
  env: { ...process.env, WORKER_TRACE_OUT: traceFile, NODE_ENV: process.env.NODE_ENV ?? 'production' },
  encoding: 'utf8',
});
if (run.status !== 0) {
  console.error(run.stdout);
  console.error(run.stderr);
  console.error(`worker-deps: the worker graph does not load (exit ${run.status})`);
  process.exit(1);
}
const traced = existsSync(traceFile)
  ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
  : [];

// --- 2. package roots ------------------------------------------------------------------------
function packageRootFor(filePath, name) {
  let dir = dirname(filePath);
  while (dir.startsWith(ROOT)) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === name) return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const roots = new Map(); // package dir -> name
for (const [spec, url] of traced) {
  const name = pkgNameOf(spec);
  const root = packageRootFor(fileURLToPath(url), name);
  if (!root) {
    console.error(`worker-deps: cannot find the package root of '${spec}' (${url})`);
    process.exit(1);
  }
  roots.set(root, name);
}

// --- 3. closure over declared dependencies ----------------------------------------------------
function findDep(fromDir, name) {
  let dir = fromDir;
  while (dir.startsWith(ROOT)) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const queue = [...roots.keys()];
const missing = [];
while (queue.length) {
  const dir = queue.pop();
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pj.dependencies ?? {})) {
    const found = findDep(dir, dep);
    if (!found) {
      if (OPTIONAL.has(dep) || pj.peerDependenciesMeta?.[dep]?.optional) continue;
      missing.push(`${pj.name} → ${dep}`);
      continue;
    }
    if (!roots.has(found)) { roots.set(found, dep); queue.push(found); }
  }
}
if (missing.length) {
  console.error('worker-deps: declared dependencies that are not installed:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// --- 4. copy -------------------------------------------------------------------------------
let copied = 0;
for (const dir of [...roots.keys()].sort()) {
  const rel = relative(ROOT, dir);
  if (!rel.startsWith('node_modules')) continue; // the trace never points outside, but be strict
  const dest = join(OUT, rel);
  rmSync(dest, { recursive: true, force: true }); // replace nft's partial copy with the whole package
  cpSync(dir, dest, { recursive: true, dereference: true });
  copied += 1;
}
rmSync(tmp, { recursive: true, force: true });
const bytes = [...roots.keys()].reduce((n, d) => n + dirSize(d), 0);
console.log(`worker-deps: ${traced.length} bare imports → ${roots.size} packages (${copied} copied, ${(bytes / 1048576).toFixed(1)} MB) into ${relative(ROOT, OUT) || '.'}`);

function dirSize(d) {
  let n = 0;
  const stack = [d];
  while (stack.length) {
    const p = stack.pop();
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) stack.push(join(p, e));
    else n += st.size;
  }
  return n;
}
