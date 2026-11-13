/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    Module resolver for the worker process — the tsconfig path aliases, in plain Node
 * USER STORY: As the worker process I load the SAME TypeScript modules the Next build compiles, so
 *             a run executes identical code in the worker and in a request — which means Node has
 *             to understand `@core/*`, `@tabs/*`, extensionless relative `.ts` imports and the
 *             bundler-only `server-only` guard, none of which it resolves on its own.
 * ARCHITECTURE:
 *   - An ESM `resolve` hook registered by `worker/start.mjs` (`node:module` `register`). The alias
 *     rules are READ FROM `tsconfig.json` `compilerOptions.paths` at startup (A4 review L-5) — a
 *     second hand-maintained copy would drift from the compiler's, and a worker whose aliases
 *     disagree with the build fails at import time in the cluster, not in CI. `server-only` /
 *     `client-only` resolve to an empty module (they are bundler assertions, meaningless in a
 *     plain Node process).
 *   - Deliberately a SIBLING of `scripts/test-alias-hook.mjs` rather than a shared module: the test
 *     hook also stubs `next/server` for route tests, which a production process must never do.
 *   - A bare subpath in a package with no `exports` map (`next/headers`) needs its `.js`: CommonJS
 *     resolved it, ESM does not. One retry, only for that error.
 *   - ROOT is this file's parent directory's parent — `os-ui/` in the repo, `/app/src/` in the
 *     image (the Dockerfile copies the source tree there next to the standalone `node_modules`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY = pathToFileURL(resolvePath(ROOT, 'worker/empty.mjs')).href;

/**
 * `compilerOptions.paths` → `[prefix, replacement]` pairs, longest prefix first so a specific
 * alias (`@/lib/experimental/*`) wins over the catch-all (`@/*`). Only `*`-suffixed single-target
 * mappings are supported — the shapes this repo's tsconfig uses; anything else is reported rather
 * than silently ignored, because a missed alias is an import failure at run time in the cluster.
 */
export function aliasesFromTsconfig(root = ROOT) {
  const file = resolvePath(root, 'tsconfig.json');
  const paths = JSON.parse(readFileSync(file, 'utf8')).compilerOptions?.paths ?? {};
  const out = [];
  for (const [key, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? targets[0] : targets;
    if (!key.endsWith('*') || typeof target !== 'string' || !target.endsWith('*')) {
      throw new Error(`worker/resolve-hook: tsconfig path '${key}' is not a '<prefix>/*' mapping — teach this hook about it`);
    }
    out.push([key.slice(0, -1), target.replace(/^\.\//, '').slice(0, -1)]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

export const ALIASES = aliasesFromTsconfig();

/** `@core/x` → `<root>/core/x.ts` (or `.tsx`, or `/index.ts`). */
function fromAlias(spec) {
  const alias = ALIASES.find(([a]) => spec.startsWith(a));
  if (!alias) return null;
  let p = resolvePath(ROOT, alias[1] + spec.slice(alias[0].length));
  if (existsSync(`${p}.ts`)) p = `${p}.ts`;
  else if (existsSync(`${p}.tsx`)) p = `${p}.tsx`;
  else if (existsSync(resolvePath(p, 'index.ts'))) p = resolvePath(p, 'index.ts');
  return pathToFileURL(p).href;
}

export async function resolve(spec, ctx, next) {
  if (spec === 'server-only' || spec === 'client-only') return { url: EMPTY, shortCircuit: true };
  const aliased = fromAlias(spec);
  if (aliased) return { url: aliased, shortCircuit: true };
  if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:')) {
    const abs = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec);
    if (!existsSync(abs)) {
      if (existsSync(`${abs}.ts`)) return { url: pathToFileURL(`${abs}.ts`).href, shortCircuit: true };
      if (existsSync(`${abs}.tsx`)) return { url: pathToFileURL(`${abs}.tsx`).href, shortCircuit: true };
      if (existsSync(resolvePath(abs, 'index.ts'))) return { url: pathToFileURL(resolvePath(abs, 'index.ts')).href, shortCircuit: true };
    }
  }
  try {
    return await next(spec, ctx);
  } catch (err) {
    // A package with NO `exports` map (e.g. `next`) does not get extensionless subpath resolution
    // in ESM, so `next/headers` → `next/headers.js`. CommonJS resolved it; a plain Node ESM
    // process has to ask for the file.
    const code = err?.code;
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') && !spec.startsWith('.') && !spec.endsWith('.js') && spec.includes('/')) {
      return next(`${spec}.js`, ctx);
    }
    throw err;
  }
}
