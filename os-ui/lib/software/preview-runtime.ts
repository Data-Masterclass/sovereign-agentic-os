/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

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

/** One lazy esbuild-wasm init for the process (Node mode: uses the bundled wasm). */
let initPromise: Promise<typeof import('esbuild-wasm')> | null = null;
function esbuild(): Promise<typeof import('esbuild-wasm')> {
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
      const esb = await esbuild();
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

/** The esbuild wasm binary, served same-origin so the browser never hits a CDN. */
let wasmPromise: Promise<Buffer> | null = null;
function readEsbuildWasm(): Promise<Buffer> {
  if (!wasmPromise) {
    wasmPromise = readFile(join(esbuildWasmDir(), 'esbuild.wasm'));
  }
  return wasmPromise;
}
