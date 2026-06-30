/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { dirname, resolve as rp } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Test-only module resolver: maps the '@/' tsconfig path alias to files and
// neutralises 'server-only' (a bundler guard that throws in plain Node) so the
// governed lib modules load under `node --test`. Additive: non-'@/' specifiers
// pass straight through, so existing relative-import tests are unaffected.
const ROOT = rp(dirname(fileURLToPath(import.meta.url)), '..');
const STUB = pathToFileURL(rp(ROOT, 'scripts/test-empty.mjs')).href;

export async function resolve(spec, ctx, next) {
  if (spec === 'server-only' || spec === 'client-only') return { url: STUB, shortCircuit: true };
  if (spec.startsWith('@/')) {
    let p = rp(ROOT, spec.slice(2));
    if (existsSync(p + '.ts')) p += '.ts';
    else if (existsSync(p + '.tsx')) p += '.tsx';
    else if (existsSync(rp(p, 'index.ts'))) p = rp(p, 'index.ts');
    return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
