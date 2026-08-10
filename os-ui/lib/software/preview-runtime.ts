/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readUiSource } from './app-ui-vendor.ts';
import { readSdkSource } from './app-sdk-vendor.ts';
import { declaredDeps as bundleDeclaredDeps, makeVfsPlugin } from './vfs-resolve.ts';
import type { ScaffoldFile } from './model.ts';

/**
 * Server-side producer of the SAME-ORIGIN runtime the in-browser Instant preview
 * needs. It uses esbuild-wasm (MIT) IN NODE to bundle React 19 (MIT) out of os-ui's
 * OWN node_modules into three tiny ESM facades, so the browser's esbuild bundle can
 * resolve its bare deps via an import-map with ZERO external CDN egress:
 *
 *   • react              → React's named + default API
 *   • react/jsx-runtime  → jsx / jsxs / Fragment (the automatic JSX runtime)
 *   • react-dom/client   → createRoot / hydrateRoot
 *
 * All three re-export from ONE shared "core" bundle, so the preview runs a SINGLE
 * React instance (two copies would break hooks). The esbuild wasm binary itself is
 * also served from here (`asset=wasm`) so the client never fetches it from a CDN.
 *
 * Everything is built ONCE and memoised for the process lifetime — the source is
 * fixed os-ui dependency code, so the output only changes when os-ui is rebuilt.
 */

export type RuntimeAsset = { body: Buffer | string; contentType: string };

const JS_TYPE = 'text/javascript; charset=utf-8';
const WASM_TYPE = 'application/wasm';

/** Resolve a file inside the esbuild-wasm package (its `exports` block the raw
 *  subpath, so resolve via the package.json dir). */
function esbuildWasmDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('esbuild-wasm/package.json'));
}

/**
 * One lazy esbuild-wasm init for the process (Node mode: uses the bundled wasm).
 * EXPORTED so the commit-path compile gate (compile-gate.ts) shares the SAME
 * initialised instance instead of paying a second wasm compile — esbuild-wasm
 * throws on a duplicate `initialize()`, so one memo must own it process-wide.
 */
let initPromise: Promise<typeof import('esbuild-wasm')> | null = null;
export function getEsbuild(): Promise<typeof import('esbuild-wasm')> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import('esbuild-wasm');
      await mod.initialize({ worker: false });
      return mod;
    })();
  }
  return initPromise;
}

/**
 * Build the shared React "core" as one ESM module exporting three namespaces
 * (React, JsxRuntime, ReactDOMClient) from a single bundled React instance. The
 * facades below import THIS module, so every specifier shares one React.
 */
let corePromise: Promise<string> | null = null;
function buildCore(): Promise<string> {
  if (!corePromise) {
    corePromise = (async () => {
      const esb = await getEsbuild();
      const entry = [
        "import * as React from 'react';",
        "import * as JsxRuntime from 'react/jsx-runtime';",
        "import * as ReactDOMClient from 'react-dom/client';",
        'export { React, JsxRuntime, ReactDOMClient };',
      ].join('\n');
      const res = await esb.build({
        stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
        bundle: true,
        format: 'esm',
        write: false,
        minify: true,
        // React reads NODE_ENV to drop dev-only checks; give it the prod build.
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      return res.outputFiles[0].text;
    })();
  }
  return corePromise;
}

/** A facade ESM module that re-exports the wanted names from the shared core. */
function facade(kind: 'react' | 'jsx-runtime' | 'react-dom-client'): string {
  // The core is served at the sibling URL `?asset=core`; facades import it so the
  // browser only ever loads ONE React instance regardless of how many specifiers
  // the app bundle imports.
  const core = "import { React, JsxRuntime, ReactDOMClient } from './preview-runtime?asset=core';";
  switch (kind) {
    case 'react':
      // `react` is used both as a namespace import and (rarely) a default import.
      return [core, 'export default React;', reexportNames('React')].join('\n');
    case 'jsx-runtime':
      return [core, reexportNames('JsxRuntime')].join('\n');
    case 'react-dom-client':
      return [core, reexportNames('ReactDOMClient')].join('\n');
  }
}

/**
 * Emit static named exports for the names an app bundle actually imports from a
 * specifier, read off the runtime namespace object. ESM `export` bindings are
 * static, so we can't `export *` a runtime object — we list the known names. A
 * name absent from React simply becomes `undefined` (never throws at module-eval),
 * so it surfaces honestly as a runtime error only if the app truly uses it.
 */
function reexportNames(ns: string): string {
  // The names an esbuild app bundle actually imports from each specifier.
  const NAMES: Record<string, string[]> = {
    React: [
      'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext',
      'useReducer', 'useLayoutEffect', 'useId', 'useTransition', 'useDeferredValue',
      'useSyncExternalStore', 'useImperativeHandle', 'useDebugValue',
      'createElement', 'cloneElement', 'createContext', 'forwardRef', 'memo',
      'Fragment', 'StrictMode', 'Suspense', 'Children', 'Component', 'PureComponent',
      'isValidElement', 'lazy', 'startTransition', 'version',
    ],
    JsxRuntime: ['jsx', 'jsxs', 'jsxDEV', 'Fragment'],
    ReactDOMClient: ['createRoot', 'hydrateRoot'],
  };
  const names = NAMES[ns] ?? [];
  // Guarded destructure — a missing name simply becomes undefined (never throws at
  // module-eval), which surfaces honestly as a runtime error only if the app uses it.
  const lines = names.map((n) => `export const ${n} = ${ns}.${n};`);
  return lines.join('\n');
}

/** Public: return one runtime asset by name, or null for an unknown asset. */
export async function getPreviewRuntimeAsset(asset: string): Promise<RuntimeAsset | null> {
  switch (asset) {
    case 'core':
      return { body: await buildCore(), contentType: JS_TYPE };
    case 'react':
      return { body: facade('react'), contentType: JS_TYPE };
    case 'jsx-runtime':
      return { body: facade('jsx-runtime'), contentType: JS_TYPE };
    case 'react-dom-client':
      return { body: facade('react-dom-client'), contentType: JS_TYPE };
    case 'wasm':
      return { body: await readEsbuildWasm(), contentType: WASM_TYPE };
    default:
      return null;
  }
}

/** Absolute path to the esbuild wasm binary the Node bundler + browser preview load. */
export function esbuildWasmPath(): string {
  return join(esbuildWasmDir(), 'esbuild.wasm');
}

/**
 * Is the esbuild wasm binary present on disk? The Next standalone tracer drops it
 * (it is loaded via `initialize()` at runtime, never `require()`'d), so it can be
 * absent in the deployed image even though `esbuild-wasm/lib/main.js` is traced.
 * The compile gate consults this to degrade its BUNDLE pass honestly instead of
 * failing the whole gate open when the asset is missing.
 */
export function esbuildWasmReady(): boolean {
  try {
    return existsSync(esbuildWasmPath());
  } catch {
    return false;
  }
}

/** The esbuild wasm binary, served same-origin so the browser never hits a CDN. */
let wasmPromise: Promise<Buffer> | null = null;
function readEsbuildWasm(): Promise<Buffer> {
  if (!wasmPromise) {
    wasmPromise = readFile(esbuildWasmPath());
  }
  return wasmPromise;
}

// ============================================================================
// Phase D — server-side app-tree bundler (no-image runtime serving)
// ----------------------------------------------------------------------------
// PROMOTES the Instant-Preview bundling to a real serving mode: it bundles the
// app's OWN committed tree (from the durable mirror) with the SAME in-Node
// esbuild instance (getEsbuild) the compile gate uses, over the SAME virtual
// filesystem resolution — vendored @sovereign-os/ui + app-sdk resolve to real
// source, React stays EXTERNAL (the browser resolves it via the import-map to
// this route's ?asset=* facades), CSS is bundled and returned inline. The output
// is one self-contained ESM bundle the runtime surface mounts in a sandboxed,
// same-origin iframe, so createOsClient() reaches the OS as the signed-in user
// with ZERO new auth path (the ambient soa_session cookie — see app-sdk/client).
// ============================================================================

export type AppBundle = {
  /** The bundled ESM the iframe loads as a module. React/react-dom are external. */
  js: string;
  /** All imported CSS, concatenated — injected into a <style> in the iframe shell. */
  css: string;
};

/** SPA entry candidates, in boot order (matches vite-os / sovereign-app scaffolds). */
const ENTRY_CANDIDATES = ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts'] as const;

const BUNDLE_VFS = 'runtime-vfs';

/** The vendored OS packages, read ONCE and memoised (same source the gate uses). */
let bundleVendorMemo: ScaffoldFile[] | null = null;
function bundleVendorFiles(): ScaffoldFile[] {
  if (!bundleVendorMemo) {
    bundleVendorMemo = [
      ...readUiSource('node_modules/@sovereign-os/ui'),
      ...readSdkSource('node_modules/@sovereign-os/app-sdk'),
    ];
  }
  return bundleVendorMemo;
}

/** The SPA entry path for a tree, or null if it has no recognised entry. */
export function appEntryFor(tree: ScaffoldFile[]): string | null {
  const set = new Set(tree.map((f) => f.path.replace(/^\/+/, '')));
  for (const c of ENTRY_CANDIDATES) if (set.has(c)) return c;
  return null;
}

/**
 * Bundle an app tree into one self-contained ESM bundle + its CSS. Throws on any
 * bundle error — the CALLER runs the compile gate first, so a well-formed
 * gate-green tree bundles cleanly; a throw here means a genuine gate/bundler slip.
 * React + react-dom are external (the import-map points them at ?asset=* facades),
 * exactly like the Instant Preview, so the iframe runs ONE shared React instance.
 */
export async function bundleAppTree(tree: ScaffoldFile[]): Promise<AppBundle> {
  const entry = appEntryFor(tree);
  if (!entry) throw new Error('No SPA entry (src/main.tsx) — this app cannot be runtime-served.');

  const files = new Map<string, string>();
  for (const f of bundleVendorFiles()) files.set(f.path, f.content);
  for (const f of tree) files.set(f.path, f.content);
  const deps = bundleDeclaredDeps(tree);

  const esb = await getEsbuild();
  // Shared VFS resolver (see vfs-resolve.ts). The runtime bundler keeps its TERSE
  // error text (the gate uses richer corrective text); logic is identical to both.
  const plugin = makeVfsPlugin({
    namespace: BUNDLE_VFS,
    files,
    deps,
    messages: {
      relativeMiss: (spec, importer) => `Cannot resolve '${spec}' from '${importer}'.`,
      vendorMiss: (spec, pkg) => `Cannot resolve '${spec}' — not part of vendored ${pkg}.`,
      undeclared: (spec) => `'${spec}' is not a declared dependency of this app.`,
    },
  });

  const res = await esb.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    // A .css import produces a sibling .css output; esbuild names outputs off outdir.
    outdir: 'runtime-out',
    minify: true,
    logLevel: 'silent',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [plugin],
  });

  let js = '';
  let css = '';
  for (const out of res.outputFiles ?? []) {
    if (out.path.endsWith('.css')) css += out.text;
    else js += out.text;
  }
  return { js, css };
}

/**
 * A content hash of an app tree — the CACHE KEY component that changes exactly when
 * the code changes. Path+content of every file, in a stable order, so an identical
 * tree always hashes the same and any edit invalidates the cached bundle.
 */
export function treeHash(tree: ScaffoldFile[]): string {
  const h = createHash('sha256');
  for (const f of [...tree].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path);
    h.update('\0');
    h.update(f.content);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Process-lifetime bundle cache keyed by `appId:treeHash`. A repeat load of an
 * unchanged app returns the memoised bundle WITHOUT re-bundling; a commit changes
 * the tree hash → a fresh bundle. Bounded (LRU-ish by insertion) so it can't grow
 * without limit across many apps/versions. In-memory only — a restart re-bundles.
 */
const BUNDLE_CACHE_MAX = 64;
const bundleCache = new Map<string, AppBundle>();
/** Test-only observability: how many misses actually bundled (repeat hits stay flat). */
let bundleMisses = 0;
export function __bundleMisses(): number {
  return bundleMisses;
}
export function __resetBundleCache(): void {
  bundleCache.clear();
  bundleMisses = 0;
}

/**
 * Bundle an app's tree, memoised by `appId` + the tree's content hash. The caller
 * passes the ALREADY-gated tree (compile gate green); this only bundles + caches.
 */
export async function getCachedAppBundle(appId: string, tree: ScaffoldFile[]): Promise<AppBundle> {
  const key = `${appId}:${treeHash(tree)}`;
  const hit = bundleCache.get(key);
  if (hit) {
    // Refresh recency (Map preserves insertion order → re-insert = most-recent).
    bundleCache.delete(key);
    bundleCache.set(key, hit);
    return hit;
  }
  bundleMisses += 1;
  const bundle = await bundleAppTree(tree);
  bundleCache.set(key, bundle);
  // Evict the oldest entries past the cap (first keys are least-recently-used).
  while (bundleCache.size > BUNDLE_CACHE_MAX) {
    const oldest = bundleCache.keys().next().value;
    if (oldest === undefined) break;
    bundleCache.delete(oldest);
  }
  return bundle;
}
