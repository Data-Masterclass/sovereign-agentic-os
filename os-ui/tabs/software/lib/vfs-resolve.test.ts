/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The shared esbuild VFS resolver (vfs-resolve.ts) — hoisted from the compile gate
 * (compile-gate.ts) and the runtime bundler (preview-runtime.ts), which MUST stay in
 * lockstep. These pin the resolution rules both call sites depend on, and that each
 * site's cosmetic differences (namespace + error text) are parameterised, not unified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packageName,
  declaredDeps,
  resolveRelative,
  loaderFor,
  RESOLVE_TRIES,
  makeVfsPlugin,
} from './vfs-resolve.ts';
import type { ScaffoldFile } from './model.ts';

test('packageName extracts the bare package (scoped and unscoped)', () => {
  assert.equal(packageName('react'), 'react');
  assert.equal(packageName('react-dom/client'), 'react-dom');
  assert.equal(packageName('@sovereign-os/ui'), '@sovereign-os/ui');
  assert.equal(packageName('@sovereign-os/ui/Badge'), '@sovereign-os/ui');
});

test('declaredDeps unions deps + devDeps, empty on missing/bad package.json', () => {
  const tree: ScaffoldFile[] = [
    { path: 'package.json', content: JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '2' } }) },
  ];
  assert.deepEqual([...declaredDeps(tree)].sort(), ['a', 'b']);
  assert.equal(declaredDeps([]).size, 0);
  assert.equal(declaredDeps([{ path: 'package.json', content: 'not json' }]).size, 0);
});

test('resolveRelative walks the tree with the extension probe order', () => {
  const files = new Map<string, string>([
    ['src/App.tsx', 'x'],
    ['src/lib/index.ts', 'y'],
  ]);
  assert.equal(resolveRelative('./App', 'src/main.tsx', files), 'src/App.tsx');
  assert.equal(resolveRelative('./lib', 'src/main.tsx', files), 'src/lib/index.ts');
  assert.equal(resolveRelative('./missing', 'src/main.tsx', files), null);
  // RESOLVE_TRIES probes bare-first then .ts/.tsx/... then /index variants.
  assert.equal(RESOLVE_TRIES[0], '');
  assert.ok(RESOLVE_TRIES.includes('/index.tsx'));
});

test('loaderFor maps extensions (assets → dataurl, unknown → text)', () => {
  assert.equal(loaderFor('a.tsx'), 'tsx');
  assert.equal(loaderFor('a.css'), 'css');
  assert.equal(loaderFor('a.png'), 'dataurl');
  assert.equal(loaderFor('a.svg'), 'dataurl');
  assert.equal(loaderFor('a.weird'), 'text');
});

/** Drive the plugin's onResolve by faking esbuild's build.onResolve registration. */
function runResolve(
  namespace: string,
  files: Map<string, string>,
  deps: Set<string>,
  messages: Parameters<typeof makeVfsPlugin>[0]['messages'],
  args: { path: string; importer: string; kind: string },
) {
  let handler: ((a: unknown) => unknown) | null = null;
  const build = {
    onResolve: (_opts: unknown, h: (a: unknown) => unknown) => {
      handler = h;
    },
    onLoad: () => {},
  };
  makeVfsPlugin({ namespace, files, deps, messages }).setup(build as never);
  return handler!(args) as { path?: string; namespace?: string; external?: boolean; errors?: { text: string }[] };
}

const files = new Map<string, string>([
  ['src/App.tsx', 'x'],
  ['node_modules/@sovereign-os/ui/index.ts', 'ui'],
]);
const deps = new Set(['echarts']);
const MSG = {
  relativeMiss: (s: string, i: string) => `rel:${s}:${i}`,
  vendorMiss: (s: string, p: string) => `ven:${s}:${p}`,
  undeclared: (s: string) => `dep:${s}`,
};

test('makeVfsPlugin resolves each import class identically for any namespace', () => {
  for (const ns of ['gate-vfs', 'runtime-vfs']) {
    // entry-point → the VFS namespace
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'src/main.tsx', importer: '', kind: 'entry-point' }), {
      path: 'src/main.tsx',
      namespace: ns,
    });
    // absolute URL / data: → external
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'https://x/y.css', importer: 'a', kind: 'import-statement' }), { external: true });
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'data:x', importer: 'a', kind: 'import-statement' }), { external: true });
    // relative hit / miss
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: './App', importer: 'src/main.tsx', kind: 'import-statement' }), { path: 'src/App.tsx', namespace: ns });
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: './nope', importer: 'src/main.tsx', kind: 'import-statement' }), { errors: [{ text: 'rel:./nope:src/main.tsx' }] });
    // react family → external
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'react', importer: 'a', kind: 'import-statement' }), { external: true });
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'react-dom/client', importer: 'a', kind: 'import-statement' }), { external: true });
    // vendored OS package hit / miss
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: '@sovereign-os/ui', importer: 'a', kind: 'import-statement' }), { path: 'node_modules/@sovereign-os/ui/index.ts', namespace: ns });
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: '@sovereign-os/ui/Nope', importer: 'a', kind: 'import-statement' }), { errors: [{ text: 'ven:@sovereign-os/ui/Nope:@sovereign-os/ui' }] });
    // declared bare dep → external; undeclared → error
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'echarts', importer: 'a', kind: 'import-statement' }), { external: true });
    assert.deepEqual(runResolve(ns, files, deps, MSG, { path: 'left-pad', importer: 'a', kind: 'import-statement' }), { errors: [{ text: 'dep:left-pad' }] });
  }
});

test('makeVfsPlugin preserves each site\'s distinct error text (not unified)', () => {
  const gateMsg = {
    relativeMiss: (s: string, i: string) => `Cannot resolve '${s}' from '${i}' — the file does not exist in the app tree.`,
    vendorMiss: (s: string, p: string) => `Cannot resolve '${s}' — not part of the vendored ${p} package.`,
    undeclared: (s: string) => `'${s}' is not a declared dependency of this app — add it to package.json or remove the import.`,
  };
  const runtimeMsg = {
    relativeMiss: (s: string, i: string) => `Cannot resolve '${s}' from '${i}'.`,
    vendorMiss: (s: string, p: string) => `Cannot resolve '${s}' — not part of vendored ${p}.`,
    undeclared: (s: string) => `'${s}' is not a declared dependency of this app.`,
  };
  const gate = runResolve('gate-vfs', files, deps, gateMsg, { path: 'left-pad', importer: 'a', kind: 'import-statement' });
  const runtime = runResolve('runtime-vfs', files, deps, runtimeMsg, { path: 'left-pad', importer: 'a', kind: 'import-statement' });
  assert.match(gate.errors![0].text, /add it to package\.json/);
  assert.equal(runtime.errors![0].text, "'left-pad' is not a declared dependency of this app.");
  assert.notEqual(gate.errors![0].text, runtime.errors![0].text);
});
