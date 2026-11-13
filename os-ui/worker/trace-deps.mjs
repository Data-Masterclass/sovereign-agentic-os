/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    Module-resolution tracer for the run worker — records which npm packages the
 *             worker's import graph really reaches, so the image can ship exactly those.
 * USER STORY: As the operator I want `os-ui-worker` to boot from the production image without
 *             anyone hand-maintaining a list of packages; the build derives it from the code.
 * ARCHITECTURE: A Node `module.register` resolve hook. It is chained AFTER `resolve-hook.mjs`
 *             (registered later = runs first), so `@core/*`/`@tabs/*` have already become file URLs
 *             and only genuine bare specifiers arrive here. For each one it appends
 *             `<specifier>\t<resolved file URL>` to the file named by WORKER_TRACE_OUT, synchronously
 *             (the hook thread has no reliable exit event). `scripts/worker-deps.mjs` turns that
 *             list into the set of package directories to copy into the standalone tree.
 *             Why this exists: `next build --output standalone` keeps only the files the SERVER
 *             bundle touches; pure-JS deps that webpack inlined (js-yaml, langsmith, …) are not in
 *             the standalone node_modules at all, but the worker runs the unbundled TypeScript source
 *             and needs them as real packages (A4 review, deploy 0.8.0 smoke).
 */
import { appendFileSync } from 'node:fs';

const BARE = /^(?!\.|\/|node:|file:|data:)/;
const seen = new Set();

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (BARE.test(specifier) && result?.url?.startsWith('file:') && !seen.has(specifier)) {
    seen.add(specifier);
    const out = process.env.WORKER_TRACE_OUT;
    if (out) appendFileSync(out, `${specifier}\t${result.url}\n`);
  }
  return result;
}
