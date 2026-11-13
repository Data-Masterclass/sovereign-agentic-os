/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 review L-5 — the worker's module aliases ARE the tsconfig's
 * USER STORY: As the operator of the `os-ui-worker` pod I want a new tsconfig path alias to work in
 *             the worker without anybody remembering to copy it: the hook reads
 *             `compilerOptions.paths`, and this test fails the moment the two could disagree —
 *             in CI, not as an ERR_MODULE_NOT_FOUND crash-loop in the cluster.
 * ARCHITECTURE: Imports `worker/resolve-hook.mjs` (plain ESM, no type stripping needed for the
 *             exported helpers) and drives its `resolve` with a fake `next`, so both the alias
 *             TABLE and the alias BEHAVIOUR are pinned. The hook is an entrypoint, not tab code;
 *             the test lives here because `npm test` only walks `core/**` and `tabs/**`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../../../', import.meta.url);
const hook = await import(new URL('worker/resolve-hook.mjs', ROOT).href);

/** `{ "@core/*": ["./core/*"] }` → `[['@core/', 'core/'], …]`, as the compiler reads it. */
function expectedAliases(): [string, string][] {
  const paths = JSON.parse(readFileSync(new URL('tsconfig.json', ROOT), 'utf8')).compilerOptions.paths as Record<string, string[]>;
  return Object.entries(paths)
    .map(([k, v]) => [k.slice(0, -1), v[0].replace(/^\.\//, '').slice(0, -1)] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
}

test('L-5: the hook derives its aliases from tsconfig.json, not from a second hand-kept list', () => {
  assert.deepEqual(hook.ALIASES, expectedAliases());
  assert.ok(hook.ALIASES.length >= 3, 'at least @/, @core/ and @tabs/');
  // Longest prefix first, or `@/lib/experimental/x` would resolve through the `@/` catch-all.
  const lengths = hook.ALIASES.map(([p]: [string, string]) => p.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
  const src = readFileSync(new URL('worker/resolve-hook.mjs', ROOT), 'utf8');
  assert.match(src, /aliasesFromTsconfig/);
  assert.doesNotMatch(src, /\['@core\/', 'core\/'\]/, 'a hardcoded copy is exactly what L-5 removed');
});

test('L-5: each alias resolves to the file the tsconfig mapping points at', async () => {
  const next = async () => ({ url: 'unresolved:', shortCircuit: false });
  const ctx = { parentURL: new URL('worker/agent-runs.ts', ROOT).href, conditions: [], importAttributes: {} };
  for (const [spec, file] of [
    ['@core/kernel/config', 'core/kernel/config.ts'],
    ['@tabs/agents/lib/engine/jobs', 'tabs/agents/lib/engine/jobs.ts'],
  ] as const) {
    const out = await hook.resolve(spec, ctx, next);
    assert.equal(out.url, new URL(file, ROOT).href, spec);
    assert.equal(out.shortCircuit, true);
  }
});

test('L-5: the bundler-only markers resolve to the empty module', async () => {
  const next = async () => ({ url: 'unresolved:', shortCircuit: false });
  const ctx = { parentURL: new URL('worker/agent-runs.ts', ROOT).href, conditions: [], importAttributes: {} };
  for (const spec of ['server-only', 'client-only']) {
    const out = await hook.resolve(spec, ctx, next);
    assert.match(out.url, /worker\/empty\.mjs$/, spec);
  }
});
