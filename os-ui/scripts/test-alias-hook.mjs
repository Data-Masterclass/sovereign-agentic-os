/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { dirname, resolve as rp } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Test-only module resolver: maps the '@/' tsconfig path alias to files,
// resolves extensionless relative '.ts' imports (so lib modules that use bare
// './foo' specifiers load under `node --test` without needing '.ts' suffixes),
// and neutralises 'server-only' / 'client-only' (bundler guards). Additive:
// specifiers that already carry an extension pass straight through.
const ROOT = rp(dirname(fileURLToPath(import.meta.url)), '..');
const STUB = pathToFileURL(rp(ROOT, 'scripts/test-empty.mjs')).href;

export async function resolve(spec, ctx, next) {
  if (spec === 'server-only' || spec === 'client-only') return { url: STUB, shortCircuit: true };
  if (spec === 'next/server') return { url: pathToFileURL(rp(ROOT, 'scripts/test-next-server.mjs')).href, shortCircuit: true };
  if (spec.startsWith('@/')) {
    let p = rp(ROOT, spec.slice(2));
    if (existsSync(p + '.ts')) p += '.ts';
    else if (existsSync(p + '.tsx')) p += '.tsx';
    else if (existsSync(rp(p, 'index.ts'))) p = rp(p, 'index.ts');
    return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  // Resolve extensionless relative imports (e.g. './engine' → './engine.ts')
  // so lib modules that omit the extension work under node --test.
  if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL) {
    const parentDir = dirname(fileURLToPath(ctx.parentURL));
    const abs = rp(parentDir, spec);
    if (!existsSync(abs)) {
      if (existsSync(abs + '.ts')) return { url: pathToFileURL(abs + '.ts').href, shortCircuit: true };
      if (existsSync(abs + '.tsx')) return { url: pathToFileURL(abs + '.tsx').href, shortCircuit: true };
      if (existsSync(rp(abs, 'index.ts'))) return { url: pathToFileURL(rp(abs, 'index.ts')).href, shortCircuit: true };
    }
  }
  return next(spec, ctx);
}
