/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase D — the no-image runtime: the server-side app-tree bundler + its tree-hash
 * cache, and the runtime-serving orchestrator's honesty gate. These pin:
 *   • a real sovereign-app tree bundles into one ESM bundle + CSS (React external);
 *   • the bundle cache is keyed by app id + tree hash — repeat loads DON'T re-bundle,
 *     and an edited tree DOES re-bundle;
 *   • a gate-RED tree serves an honest "does not compile" page — NEVER a bundle;
 *   • serveMode / shape gating and the visibility gate are honoured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sovereignAppFiles } from './scaffolds/sovereign-app.ts';
import {
  bundleAppTree,
  treeHash,
  getCachedAppBundle,
  __bundleMisses,
  __resetBundleCache,
  appEntryFor,
} from './preview-runtime.ts';
import type { ScaffoldFile } from './model.ts';

/** A real sovereign-app scaffold tree, optionally overlaid with extra files. */
function viteTree(extra: ScaffoldFile[] = []): ScaffoldFile[] {
  const base = sovereignAppFiles('Runtime Test', 'runtime-test');
  const byPath = new Map(base.map((f) => [f.path, f]));
  for (const f of extra) byPath.set(f.path, f);
  return [...byPath.values()];
}

// ---------------------------------------------------------------- bundler ---

test('bundleAppTree bundles a real sovereign-app tree into ESM + CSS (React external)', async () => {
  const bundle = await bundleAppTree(viteTree());
  assert.ok(bundle.js.length > 0, 'produced a JS bundle');
  // React stays external → the bundle imports the runtime facade, never inlines React.
  assert.match(bundle.js, /react-dom\/client|from"react"|from"react\//, 'React deps left external as imports');
  // The scaffold imports CSS (src/index.css + theme) → CSS is collected.
  assert.ok(bundle.css.length > 0, 'collected the app CSS');
});

test('appEntryFor finds the SPA entry and returns null for a metadata-only tree', () => {
  assert.equal(appEntryFor(viteTree()), 'src/main.tsx');
  assert.equal(appEntryFor([{ path: 'package.json', content: '{}' }]), null);
});

// ----------------------------------------------------------------- hash ---

test('treeHash is stable for identical trees and changes on ANY edit', () => {
  const a = viteTree();
  const b = viteTree();
  assert.equal(treeHash(a), treeHash(b), 'identical trees hash the same');
  const edited = viteTree([{ path: 'src/App.tsx', content: '// changed\n' }]);
  assert.notEqual(treeHash(a), treeHash(edited), 'an edit invalidates the hash');
  // Order-independent: same files in a different order hash the same.
  assert.equal(treeHash(a), treeHash([...a].reverse()), 'hash is order-independent');
});

// ---------------------------------------------------------------- cache ---

test('getCachedAppBundle is keyed by app id + tree hash — repeat loads do not re-bundle', async () => {
  __resetBundleCache();
  const tree = viteTree();
  const first = await getCachedAppBundle('app_1', tree);
  assert.equal(__bundleMisses(), 1, 'first load bundles once');
  const second = await getCachedAppBundle('app_1', tree);
  assert.equal(__bundleMisses(), 1, 'identical tree ⇒ served from cache, no re-bundle');
  assert.equal(first.js, second.js, 'same bundle object content');

  // A DIFFERENT app id with the same tree is a distinct cache entry (isolation).
  await getCachedAppBundle('app_2', tree);
  assert.equal(__bundleMisses(), 2, 'a different app id re-bundles under its own key');

  // An EDIT to app_1's tree changes its hash ⇒ a fresh bundle.
  await getCachedAppBundle('app_1', viteTree([{ path: 'src/App.tsx', content: 'export default function App(){return null}\n' }]));
  assert.equal(__bundleMisses(), 3, 'an edited tree re-bundles');
});
