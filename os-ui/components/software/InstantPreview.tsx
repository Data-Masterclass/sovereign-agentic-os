/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as esbuild from 'esbuild-wasm';

/**
 * "Instant preview" — the sub-second, no-deploy inner-loop preview for a governed
 * frontend app, restored on a strictly-permissive toolchain (esbuild-wasm, MIT).
 *
 * HOW IT WORKS (all in-browser, no external CDN egress):
 *   1. Fetch `/api/software/{id}/preview-files` → the app's own `src/*` PLUS the
 *      vendored `@sovereign-os/app-sdk` + `@sovereign-os/ui` under `node_modules/`.
 *   2. Bundle it with esbuild-wasm through a virtual-FS resolve/load plugin. The
 *      bare runtime deps (`react`, `react-dom/client`, `react/jsx-runtime`) are
 *      marked EXTERNAL and resolved at runtime via an import-map that points at the
 *      SAME-ORIGIN `/api/software/preview-runtime` route (React 19 out of os-ui's
 *      own node_modules) — so the preview stays sovereign / air-gappable.
 *   3. Render the compiled JS + CSS in a SANDBOXED SAME-ORIGIN iframe. Same-origin
 *      means the SDK's `fetch(credentials:'include')` carries the `soa_session`
 *      cookie to the governed OS routes → REAL granted data, or a REAL typed error.
 *      Nothing is mocked: compile errors and runtime/SDK 401/403 are shown as-is.
 *
 * The deployed-build iframe is kept as the secondary "exactly what ships" view.
 * This component is client-only (esbuild-wasm needs the DOM) and is already loaded
 * behind `next/dynamic({ ssr:false })` by SoftwareBuilder, so SSR/prerender is safe.
 */

const RUNTIME = '/api/software/preview-runtime';
/** Bare deps resolved at runtime via the iframe import-map (not bundled in). */
const RUNTIME_EXTERNALS = ['react', 'react-dom/client', 'react/jsx-runtime'] as const;

type PreviewFile = { path: string; content: string };
type PreviewFilesResponse = {
  files: PreviewFile[];
  sdk?: PreviewFile[];
  ui?: PreviewFile[];
  error?: string;
};

/** One lazy esbuild-wasm init for the whole page (re-init throws otherwise). */
let esbuildReady: Promise<void> | null = null;
function initEsbuild(): Promise<void> {
  if (!esbuildReady) {
    esbuildReady = esbuild
      .initialize({ wasmURL: `${RUNTIME}?asset=wasm` })
      .catch((e) => {
        esbuildReady = null; // allow a retry on the next mount
        throw e;
      });
  }
  return esbuildReady;
}

/** Normalise a relative import against its importer into an absolute VFS path. */
function resolveRelative(spec: string, importer: string): string {
  const baseDir = importer.replace(/^vfs:/, '').replace(/\/[^/]*$/, '');
  return new URL(spec, `file://${baseDir || '/'}/`).pathname;
}

/** esbuild plugin serving every module from the in-memory virtual FS. */
function vfsPlugin(fs: Map<string, string>): esbuild.Plugin {
  return {
    name: 'sovereign-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if ((RUNTIME_EXTERNALS as readonly string[]).includes(args.path)) {
          return { path: args.path, external: true };
        }
        // Leave protocol/absolute URLs (e.g. theme.css's @import of a font stylesheet,
        // data: URIs) as-is — the iframe fetches them at runtime, exactly as the
        // deployed build does. The BUNDLE itself makes no external request.
        if (/^(https?:|data:|\/\/)/.test(args.path)) {
          return { path: args.path, external: true };
        }
        let p = args.path;
        if (p.startsWith('.')) {
          p = resolveRelative(p, args.importer);
        } else if (p.startsWith('@sovereign-os/')) {
          p = `/node_modules/${p}`;
        } else if (!p.startsWith('/')) {
          // Any other bare dep is not available in the sovereign runtime — fail
          // honestly rather than silently dropping it.
          return { errors: [{ text: `Module "${args.path}" is not available in the instant preview (only React + the OS SDK/UI are provided).` }] };
        }
        // Try the path itself, then TS/TSX/CSS + index resolutions.
        const cands = [p, `${p}.tsx`, `${p}.ts`, `${p}.css`, `${p}/index.tsx`, `${p}/index.ts`];
        for (const c of cands) if (fs.has(c)) return { path: c, namespace: 'vfs' };
        return { errors: [{ text: `Cannot resolve "${args.path}" from ${args.importer}` }] };
      });
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
        const contents = fs.get(args.path) ?? '';
        const loader: esbuild.Loader = args.path.endsWith('.css')
          ? 'css'
          : args.path.endsWith('.tsx')
            ? 'tsx'
            : args.path.endsWith('.json')
              ? 'json'
              : 'ts';
        return { contents, loader, resolveDir: '/' };
      });
    },
  };
}

/** Pick the SPA entry point the app boots from (matches the vite-os scaffold). */
function pickEntry(fs: Map<string, string>): string | null {
  for (const c of ['/src/main.tsx', '/src/main.ts', '/src/index.tsx', '/src/index.ts']) {
    if (fs.has(c)) return c;
  }
  return null;
}

/** Build the sandbox HTML: import-map → same-origin runtime, CSS, then the JS. */
function buildSrcDoc(js: string, css: string): string {
  const map = {
    imports: {
      react: `${RUNTIME}?asset=react`,
      'react-dom/client': `${RUNTIME}?asset=react-dom-client`,
      'react/jsx-runtime': `${RUNTIME}?asset=jsx-runtime`,
    },
  };
  // Guard against a literal `</script>` inside the bundled JS / inline sourcemap
  // prematurely closing the module script tag.
  const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8" />',
    // A minimal reset so the app boots on a clean slate; theme.css (bundled into
    // `css`) then paints the OS look via its .sb-* classes.
    '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;height:100%}</style>',
    `<style>${css}</style>`,
    `<script type="importmap">${JSON.stringify(map)}</script>`,
    '</head><body><div id="root"></div>',
    `<script type="module">${safeJs}</script>`,
    '</body></html>',
  ].join('\n');
}

type Phase = 'idle' | 'building' | 'ready' | 'error';

export default function InstantPreview({
  appId,
  previewUrl,
}: {
  appId: string;
  previewUrl: string | null;
}) {
  const [tab, setTab] = useState<'instant' | 'deployed'>('instant');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const build = useCallback(async () => {
    setPhase('building');
    setError(null);
    try {
      const res = await fetch(`/api/software/${encodeURIComponent(appId)}/preview-files`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = (await res.json()) as PreviewFilesResponse;
      if (!res.ok) throw new Error(data?.error || `Could not load preview files (${res.status}).`);

      // Assemble the virtual FS: the app's files first, then the injected packages.
      const fs = new Map<string, string>();
      const add = (list?: PreviewFile[]) => {
        for (const f of list ?? []) fs.set(`/${f.path.replace(/^\/+/, '')}`, f.content);
      };
      add(data.files);
      add(data.sdk);
      add(data.ui);

      const entry = pickEntry(fs);
      if (!entry) throw new Error('No SPA entry point found (expected src/main.tsx).');

      await initEsbuild();
      const out = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        outdir: '/out',
        jsx: 'automatic',
        sourcemap: 'inline',
        // Vite exposes env via import.meta.env; keep the SDK same-origin (empty base),
        // and give any other import.meta.env.* access an empty object to read from.
        define: {
          'import.meta.env.VITE_OS_API': '""',
          'import.meta.env': '{}',
          'process.env.NODE_ENV': '"production"',
        },
        plugins: [vfsPlugin(fs)],
        external: [...RUNTIME_EXTERNALS],
      });

      const js = out.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
      const css = out.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
      setSrcDoc(buildSrcDoc(js, css));
      setNonce((n) => n + 1);
      setPhase('ready');
    } catch (e) {
      // Honest: surface the real compile / load error, never a fake preview.
      const msg =
        e && typeof e === 'object' && 'errors' in e && Array.isArray((e as { errors: { text: string }[] }).errors)
          ? (e as { errors: { text: string }[] }).errors.map((x) => x.text).join('\n')
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      setPhase('error');
    }
  }, [appId]);

  // (Re)build the instant preview whenever the app changes or the tab is opened.
  useEffect(() => {
    if (tab === 'instant') void build();
  }, [tab, build]);

  // Reload the deployed iframe when the app changes (e.g. after a Build + redeploy).
  const deployNonceRef = useRef(0);
  useEffect(() => {
    deployNonceRef.current += 1;
  }, [appId, previewUrl]);

  return (
    <div>
      {/* Two honest views: the instant in-browser bundle vs the exact deployed image. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <TabButton active={tab === 'instant'} onClick={() => setTab('instant')}>
          Instant · live data
        </TabButton>
        <TabButton active={tab === 'deployed'} onClick={() => setTab('deployed')}>
          Deployed build
        </TabButton>
      </div>

      {tab === 'instant' ? (
        <InstantView phase={phase} error={error} srcDoc={srcDoc} nonce={nonce} onRetry={build} />
      ) : (
        <DeployedView previewUrl={previewUrl} nonce={deployNonceRef.current} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn"
      style={{
        padding: '4px 10px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--border, #e5e7eb)',
        background: active ? 'var(--accent-soft, #eef2ff)' : 'transparent',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function InstantView({
  phase,
  error,
  srcDoc,
  nonce,
  onRetry,
}: {
  phase: Phase;
  error: string | null;
  srcDoc: string | null;
  nonce: number;
  onRetry: () => void;
}) {
  return (
    <div>
      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        Instant preview — your <code>src/*</code> bundled in the browser (esbuild-wasm), calling the
        governed OS API as you. Real granted data, or the app’s own honest error. No deploy needed.
      </div>

      {phase === 'building' && (
        <p className="hint" style={{ marginTop: 0 }}>
          Bundling in your browser…
        </p>
      )}

      {phase === 'error' && (
        <div
          style={{
            border: '1px solid var(--border-err, #fca5a5)',
            background: 'var(--bg-err, #fef2f2)',
            borderRadius: 8,
            padding: 12,
          }}
        >
          <strong style={{ display: 'block', marginBottom: 6 }}>Preview didn’t compile</strong>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
              color: 'var(--text-err, #991b1b)',
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {error}
          </pre>
          <button type="button" className="btn" onClick={onRetry} style={{ marginTop: 8 }}>
            Retry
          </button>
        </div>
      )}

      {phase === 'ready' && srcDoc && (
        <iframe
          key={nonce}
          srcDoc={srcDoc}
          title="Instant app preview"
          style={{
            width: '100%',
            height: 520,
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: 8,
            background: '#fff',
          }}
          // Same-origin so the SDK's credentialed fetch reaches the governed OS API.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      )}
    </div>
  );
}

function DeployedView({ previewUrl, nonce }: { previewUrl: string | null; nonce: number }) {
  if (!previewUrl) {
    return (
      <p className="hint" style={{ marginTop: 0 }}>
        The deployed build appears once the app runner is provisioned. Use “Provision preview” below
        to build &amp; deploy it — it then renders here against the governed OS API, as you.
      </p>
    );
  }
  return (
    <div>
      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        Deployed build — exactly what ships: the real image served by the runner, calling the governed
        OS API as you. It shows your real granted data, or the app’s own honest error.
      </div>
      <iframe
        key={nonce}
        src={previewUrl}
        title="Deployed app preview"
        style={{
          width: '100%',
          height: 520,
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 8,
          background: '#fff',
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
