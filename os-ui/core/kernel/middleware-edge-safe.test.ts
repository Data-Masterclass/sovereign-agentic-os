/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      The middleware's import graph stays Edge-runtime safe
 * USER STORY:   As a user, every page and API call keeps working: one Node-only call in a module the
 *               middleware imports makes the Edge middleware throw, and every request returns 500.
 * ARCHITECTURE: Walks the static imports of middleware.ts (relative + @core/@tabs aliases) and fails on
 *               Node-only APIs evaluated at module load (process.cwd, node: imports, require).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bprocess\.cwd\s*\(/, 'process.cwd()'],
  [/from\s+['"]node:/, "a 'node:' import"],
  [/\brequire\s*\(/, 'require()'],
];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@core/')) base = join(OSUI, 'core', spec.slice(6));
  else if (spec.startsWith('@tabs/')) base = join(OSUI, 'tabs', spec.slice(6));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package (next/server …) — not ours to walk
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(c) && c.match(/\.tsx?$/)) return c;
  return null;
}

/** Every first-party module the middleware statically imports, transitively. */
function middlewareGraph(entry = join(OSUI, 'middleware.ts')): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    // Static imports only (`import type` is erased at build time and never evaluated).
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const r = resolveImport(f, m[1]);
      if (r) stack.push(r);
    }
  }
  return [...seen];
}

function offences(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, name]) => name);
}

test('no module the middleware imports calls a Node-only API', () => {
  const graph = middlewareGraph();
  assert.ok(graph.some((f) => f.endsWith(join('core', 'kernel', 'config.ts'))), 'config.ts is in the graph');
  const bad = graph.flatMap((f) => offences(readFileSync(f, 'utf8')).map((o) => `${f.slice(OSUI.length + 1)}: ${o}`));
  assert.deepEqual(bad, []);
});

test('negative twin: the scanner flags a module-level process.cwd() and a node: import', () => {
  assert.deepEqual(offences("export const x = `${process.cwd()}/package-lock.json`;"), ['process.cwd()']);
  assert.deepEqual(offences("import { readFileSync } from 'node:fs';"), ["a 'node:' import"]);
  assert.deepEqual(offences('// process.cwd() in a comment is fine'), []);
});
