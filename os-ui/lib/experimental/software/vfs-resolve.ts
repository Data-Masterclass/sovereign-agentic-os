/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { ScaffoldFile } from './model.ts';

/**
 * SHARED esbuild virtual-filesystem resolver for the software tab.
 *
 * The compile GATE (compile-gate.ts) and the runtime BUNDLER (preview-runtime.ts)
 * resolve an app's imports against the SAME virtual tree with byte-identical rules:
 *   • entry-point → the VFS namespace
 *   • absolute URLs / data: URIs   → external (browser fetches at runtime)
 *   • relative ('.' or '/')        → resolved inside the tree, else an error
 *   • react / react-dom            → external (the runtime import-map provides them)
 *   • @sovereign-os/ui|app-sdk     → resolved into the vendored virtual source
 *   • any other bare import        → external iff declared, else an error
 *
 * These two copies MUST stay in lockstep, so they are hoisted here ONCE. The only
 * per-call-site differences are cosmetic and observable, so they are parameterised
 * (not unified): the plugin `namespace` and the three human error-message strings.
 * Behaviour is otherwise identical to what each site shipped before this hoist.
 */

/** Extension probe order for a bare/relative resolution against the virtual tree. */
export const RESOLVE_TRIES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'] as const;

/** The bare package name of an import specifier ('@scope/pkg/x' → '@scope/pkg'). */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The dependencies the app's own package.json declares (deps + devDeps). */
export function declaredDeps(tree: ScaffoldFile[]): Set<string> {
  const pkg = tree.find((f) => f.path === 'package.json');
  if (!pkg) return new Set();
  try {
    const parsed = JSON.parse(pkg.content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

/** Resolve a relative specifier against its importer inside the virtual tree. */
export function resolveRelative(spec: string, importer: string, files: Map<string, string>): string | null {
  const stack: string[] = [];
  for (const part of [...importer.split('/').slice(0, -1), ...spec.split('/')]) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const joined = stack.join('/');
  for (const ext of RESOLVE_TRIES) {
    const candidate = `${joined}${ext}`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/** esbuild loader per extension (correctness only). */
export function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'json' | 'dataurl' | 'text' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'ts') return 'ts';
  if (ext === 'tsx') return 'tsx';
  if (ext === 'js') return 'js';
  if (ext === 'jsx') return 'jsx';
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  if (ext === 'svg' || ext === 'png' || ext === 'jpg' || ext === 'gif') return 'dataurl';
  return 'text';
}

/**
 * The per-call-site cosmetics: the plugin namespace and the exact human error text
 * each site surfaces. These are NOT unified — the gate feeds richer corrective text
 * to the agent loop, the runtime bundler stays terse; both are preserved verbatim.
 */
export type VfsMessages = {
  /** Relative specifier that does not exist in the tree. */
  relativeMiss: (spec: string, importer: string) => string;
  /** A `@sovereign-os/*` subpath not present in the vendored source. */
  vendorMiss: (spec: string, pkg: string) => string;
  /** A bare import that is not a declared dependency. */
  undeclared: (spec: string, pkg: string) => string;
};

export type VfsPluginOptions = {
  /** The esbuild namespace this VFS uses (e.g. 'gate-vfs' or 'runtime-vfs'). */
  namespace: string;
  /** The virtual files (vendored source + app tree), keyed by app-relative path. */
  files: Map<string, string>;
  /** The app's declared dependencies (deps + devDeps). */
  deps: Set<string>;
  /** The site-specific error message strings. */
  messages: VfsMessages;
};

/**
 * Build the esbuild plugin that resolves + loads against the virtual tree. The
 * resolution logic is identical for both call sites; only `namespace` and the error
 * message strings vary (passed in). Returns a fresh plugin bound to `files`/`deps`.
 */
export function makeVfsPlugin(opts: VfsPluginOptions): import('esbuild-wasm').Plugin {
  const { namespace, files, deps, messages } = opts;
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // The entry point itself.
        if (args.kind === 'entry-point') return { path: args.path, namespace };
        const spec = args.path;
        // Absolute URLs / data: URIs stay external — the browser fetches them at runtime.
        if (/^(https?:)?\/\//.test(spec) || spec.startsWith('data:')) return { external: true };
        // Relative — resolve inside the virtual tree; a miss is a real error.
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const hit = resolveRelative(spec.replace(/^\/+/, ''), spec.startsWith('/') ? '' : args.importer, files);
          if (hit) return { path: hit, namespace };
          return { errors: [{ text: messages.relativeMiss(spec, args.importer) }] };
        }
        // React family — provided by the runtime import-map (external), same as preview.
        const pkg = packageName(spec);
        if (pkg === 'react' || pkg === 'react-dom') return { external: true };
        // Vendored OS packages — resolve into the virtual vendor source.
        if (pkg === '@sovereign-os/ui' || pkg === '@sovereign-os/app-sdk') {
          const sub = spec.slice(pkg.length).replace(/^\/+/, '');
          const base = `node_modules/${pkg}`;
          const target = sub ? `${base}/${sub}` : `${base}/index.ts`;
          for (const ext of RESOLVE_TRIES) {
            const candidate = `${target}${ext}`;
            if (files.has(candidate)) return { path: candidate, namespace };
          }
          return { errors: [{ text: messages.vendorMiss(spec, pkg) }] };
        }
        // Any other bare import must be a DECLARED dependency (external for the build).
        if (deps.has(pkg)) return { external: true };
        return { errors: [{ text: messages.undeclared(spec, pkg) }] };
      });
      build.onLoad({ filter: /.*/, namespace }, (args) => ({
        contents: files.get(args.path) ?? '',
        loader: loaderFor(args.path),
      }));
    },
  };
}
