/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import ts from 'typescript';
import { readUiSource } from './app-ui-vendor.ts';
import { readSdkSource } from './app-sdk-vendor.ts';
import { detectPreviewShape } from './preview-shape.ts';
import { getEsbuild, esbuildWasmReady } from './preview-runtime.ts';
import { packageName, declaredDeps, makeVfsPlugin } from './vfs-resolve.ts';
import type { ScaffoldFile } from './model.ts';

/**
 * COMPILE GATE — verify-before-commit (software-deploy-redesign.md, Week 1, Alt A).
 *
 * Checks an app's MERGED tree (its prior tree + the incoming commit) IN-PROCESS
 * against the vendored `@sovereign-os/ui` + `@sovereign-os/app-sdk` BEFORE
 * `commitToApp` writes anything. This closes the one build step that had no feedback
 * loop: the compiler was minutes away in Forgejo Actions and its errors never reached
 * the agent. Now a commit that would not compile is REJECTED with the exact diagnostics,
 * fed back into the same build turn so the agent iterates against real compiler output.
 *
 * TWO passes, per the redesign decision (§7.1 "both"):
 *   1. `tsc --noEmit` via the compiler API (in-process, no child process), with
 *      `moduleResolution: bundler` — the AUTHORITATIVE gate. Catches:
 *        • wrong import depth / bad path        → TS2307 (cannot find module)
 *        • hallucinated UI primitive / member   → TS2305 (no exported member 'Modal')
 *        • unimported identifier                → TS2304 (cannot find name 'Card')
 *        • Badge `variant`-vs-`tone` (type)     → TS2322 (not assignable)
 *        • syntax                               → TS1xxx / TS7xxx
 *   2. An esbuild-wasm BUNDLE of the SPA entry (the same in-Node esbuild instance the
 *      Instant Preview runtime uses — shared via `getEsbuild`), run only when tsc is
 *      clean. It covers exactly what the tsc ambient shims cannot see: a missing
 *      CSS/asset file, and a bare import that is not a declared dependency.
 *
 * Scope: only the Vite-shaped `sovereign-app`/`vite-os` scaffolds, where the vendored
 * types exist. Other/legacy shapes (Next.js, api-service, unknown) pass through UNGATED
 * and honestly say so (`gated: false`) — the gate never blocks a shape it cannot check.
 *
 * Performance: the vendored `@sovereign-os/*` source is read ONCE and memoised for the
 * process (same for the esbuild wasm init); a typical tree gates in well under a second.
 */

// -------------------------------------------------------------------- Result shape ---

export type CompileDiagnostic = {
  /** App-relative file path, e.g. `src/epics/e/s/Page.tsx`. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The TS diagnostic code (e.g. 2322); 0 = an esbuild bundle error (no TS code). */
  code: number;
  /** The flattened human message. */
  message: string;
};

export type CompileGateResult =
  /** The shape is checkable and compiled cleanly. `bundleSkipped` is set (with an
   *  honest reason) when tsc gated but the esbuild BUNDLE pass could not run because
   *  its wasm asset is missing — tsc is authoritative, so the commit still passes. */
  | { gated: true; ok: true; bundleSkipped?: string }
  /** The shape is checkable and FAILED — diagnostics name file+line (capped). */
  | { gated: true; ok: false; diagnostics: CompileDiagnostic[]; total: number }
  /** The shape is not checkable (legacy/other) — passed through, honestly noted. */
  | { gated: false; reason: string };

/** Cap diagnostics so the tool result fits a model turn (redesign: "capped so it fits"). */
export const MAX_DIAGNOSTICS = 20;

// ----------------------------------------------------------- Memoised compiler bits ---

/** The vendored OS package source, placed under a virtual node_modules so bare
 *  `@sovereign-os/ui` / `@sovereign-os/app-sdk` imports resolve to real types. */
let vendorFilesMemo: ScaffoldFile[] | null = null;
function vendorFiles(): ScaffoldFile[] {
  if (!vendorFilesMemo) {
    vendorFilesMemo = [
      ...readUiSource('node_modules/@sovereign-os/ui'),
      ...readSdkSource('node_modules/@sovereign-os/app-sdk'),
    ];
  }
  return vendorFilesMemo;
}

/**
 * An ambient shim for the Vite-provided globals the scaffold relies on
 * (`import.meta.env`, CSS/asset module declarations). The app's real build resolves
 * these via `vite/client` (a devDependency of the APP, not of os-ui), so without this
 * shim `import.meta.env.VITE_*` would be a FALSE positive in-gate. It declares exactly
 * what the scaffold uses — faithful to what the real Vite build sees, without vendoring
 * Vite. The wildcard module declarations are why the esbuild bundle pass exists: they
 * make ANY `*.css` import typecheck, so a missing stylesheet is the bundler's to catch.
 */
const VITE_ENV_SHIM = [
  'interface ImportMetaEnv {',
  '  readonly [key: string]: string | boolean | undefined;',
  '  readonly VITE_OS_API?: string;',
  '  readonly VITE_APP_DOMAIN?: string;',
  '}',
  'interface ImportMeta { readonly env: ImportMetaEnv; }',
  "declare module '*.css' {}",
  "declare module '*.svg' { const src: string; export default src; }",
  "declare module '*.png' { const src: string; export default src; }",
].join('\n');

const SHIM_PATH = '__gate__/vite-env-shim.d.ts';

/** The compiler options mirror the scaffold's own tsconfig (vite-os.ts tsConfig()). */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  isolatedModules: true,
  moduleDetection: ts.ModuleDetectionKind.Force,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: 'react',
  strict: true,
  noEmit: true,
  // The vendored OS libs are known-good os-ui source — check the APP's files, not the
  // library's internals (matches the scaffold tsconfig; keeps diagnostics app-scoped).
  skipLibCheck: true,
  esModuleInterop: true,
};

/**
 * Cheap observability counters so tests can assert the cache strategy: the vendored
 * source is read from disk at most once per process; a CompilerHost is built once per
 * gate call (the per-call program is what varies — the expensive shared inputs are not
 * re-read). Honest hooks, not behaviour switches.
 */
let hostBuilds = 0;
/** Test-only: 1 when the vendored source has been read (stays 1 across further calls). */
export function __vendorReads(): number {
  return vendorFilesMemo ? 1 : 0;
}
/** Test-only: how many CompilerHosts were built (one per gate call — the tsc program). */
export function __hostBuilds(): number {
  return hostBuilds;
}

// ------------------------------------------------------------------- Shared helpers ---

/** os-ui's own working dir — it carries real `react` + `@types/react` in node_modules,
 *  which the tsc host falls through to for React types + `lib.*.d.ts`. */
function rootDir(): string {
  return process.cwd();
}

/** Packages the gate itself provides types/source for (never treated as unknowable). */
const GATE_PROVIDED = new Set(['@sovereign-os/ui', '@sovereign-os/app-sdk', 'react', 'react-dom']);

// ----------------------------------------------------------------------- tsc pass ---

/**
 * Build a TS CompilerHost that serves the merged app tree + vendored OS packages + the
 * vite-env shim from memory, falling through to disk (`ts.sys`) for real packages
 * (`react`, `@types/react`) and the default `lib.*.d.ts`. Rooted at os-ui's cwd so the
 * disk fall-through finds os-ui's node_modules.
 */
function buildHost(virtual: Map<string, string>): ts.CompilerHost {
  hostBuilds += 1;
  const root = rootDir();
  const abs = (fileName: string): string => (fileName.startsWith('/') ? fileName : `${root}/${fileName}`);
  return {
    getSourceFile(fileName, languageVersion) {
      const a = abs(fileName);
      let text = virtual.get(a);
      if (text === undefined) text = ts.sys.readFile(a);
      return text !== undefined ? ts.createSourceFile(fileName, text, languageVersion, true) : undefined;
    },
    writeFile() {
      /* noEmit — never write */
    },
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists(fileName) {
      const a = abs(fileName);
      return virtual.has(a) || ts.sys.fileExists(a);
    },
    readFile(fileName) {
      const a = abs(fileName);
      return virtual.has(a) ? virtual.get(a) : ts.sys.readFile(a);
    },
    directoryExists: (d) => ts.sys.directoryExists(abs(d)) || [...virtual.keys()].some((k) => k.startsWith(`${abs(d)}/`)),
    getDirectories: (d) => {
      try {
        return ts.sys.getDirectories(abs(d));
      } catch {
        return [];
      }
    },
    realpath: (p) => p,
  };
}

/** The app source files a Vite build compiles: `src/**` TS/TSX (the tsconfig `include`). */
function appSourceRoots(tree: ScaffoldFile[]): string[] {
  return tree.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f.path)).map((f) => f.path);
}

/**
 * Is this diagnostic a "cannot find module" for a DECLARED third-party dependency the
 * gate has no types for (e.g. an imported repo using lodash)? We cannot type-check what
 * we do not have — such imports are the real npm build's to resolve, so blocking on
 * them would be a FALSE rejection. Vendored/react packages are never skipped this way.
 */
function isUnknowableDepDiag(d: ts.Diagnostic, deps: Set<string>): boolean {
  if (d.code !== 2307 && d.code !== 7016) return false;
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  const m = /module '([^']+)'/.exec(msg);
  if (!m) return false;
  const spec = m[1];
  if (spec.startsWith('.') || spec.startsWith('/')) return false; // relative — always ours to check
  const pkg = packageName(spec);
  return deps.has(pkg) && !GATE_PROVIDED.has(pkg);
}

/** Run the tsc pass. Returns app-scoped diagnostics (empty = clean). */
function tscDiagnostics(tree: ScaffoldFile[], deps: Set<string>): ts.Diagnostic[] {
  const root = rootDir();
  const virtual = new Map<string, string>();
  for (const f of vendorFiles()) virtual.set(`${root}/${f.path}`, f.content);
  for (const f of tree) virtual.set(`${root}/${f.path}`, f.content);
  virtual.set(`${root}/${SHIM_PATH}`, VITE_ENV_SHIM);

  const appRoots = appSourceRoots(tree).map((p) => `${root}/${p}`);
  if (appRoots.length === 0) return []; // metadata-only tree — nothing to type-check
  const host = buildHost(virtual);
  const program = ts.createProgram([...appRoots, `${root}/${SHIM_PATH}`], COMPILER_OPTIONS, host);

  // Only the app's OWN files count — vendored-lib noise is suppressed by skipLibCheck,
  // and we additionally scope to the app roots so a diagnostic always names app code.
  const appRootSet = new Set(appRoots);
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter(
    (d) => d.file && appRootSet.has(d.file.fileName) && !isUnknowableDepDiag(d, deps),
  );
}

function toDiagnostic(d: ts.Diagnostic): CompileDiagnostic {
  const { line, character } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
  return {
    file: d.file!.fileName.replace(`${rootDir()}/`, ''),
    line: line + 1,
    column: character + 1,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  };
}

// -------------------------------------------------------------------- bundle pass ---

const VFS = 'gate-vfs';

/**
 * Bundle the SPA entry with esbuild-wasm over the virtual tree (app + vendored OS
 * packages). React stays external (the runtime provides it — same as the preview);
 * any OTHER bare import must be a declared dependency (external) or it is an error.
 * Returns bundle diagnostics (empty = clean). Runs only after tsc is clean, so every
 * error here is one tsc could not see (missing css/asset, undeclared bare import).
 */
async function bundleDiagnostics(tree: ScaffoldFile[], entry: string, deps: Set<string>): Promise<CompileDiagnostic[]> {
  const files = new Map<string, string>();
  for (const f of vendorFiles()) files.set(f.path, f.content);
  for (const f of tree) files.set(f.path, f.content);

  const esb = await getEsbuild();
  // Shared VFS resolver (see vfs-resolve.ts). The gate keeps its RICHER corrective
  // error text (fed back to the agent loop); logic is identical to the runtime bundler.
  const plugin = makeVfsPlugin({
    namespace: VFS,
    files,
    deps,
    messages: {
      relativeMiss: (spec, importer) =>
        `Cannot resolve '${spec}' from '${importer}' — the file does not exist in the app tree.`,
      vendorMiss: (spec, pkg) => `Cannot resolve '${spec}' — not part of the vendored ${pkg} package.`,
      undeclared: (spec) =>
        `'${spec}' is not a declared dependency of this app — add it to package.json or remove the import.`,
    },
  });

  try {
    const res = await esb.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      outdir: 'gate-out',
      logLevel: 'silent',
      jsx: 'automatic',
      jsxImportSource: 'react',
      plugins: [plugin],
    });
    return (res.errors ?? []).map(bundleMessageToDiagnostic);
  } catch (e) {
    const errors = (e as { errors?: import('esbuild-wasm').Message[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) return errors.map(bundleMessageToDiagnostic);
    // esbuild itself failed without structured errors — the GATE slipped, not the code.
    throw e;
  }
}

function bundleMessageToDiagnostic(m: import('esbuild-wasm').Message): CompileDiagnostic {
  const file = (m.location?.file ?? '').replace(new RegExp(`^${VFS}:`), '');
  return {
    file: file || '(bundle)',
    line: m.location?.line ?? 1,
    column: (m.location?.column ?? 0) + 1,
    code: 0, // esbuild errors carry no TS code
    message: m.text,
  };
}

// --------------------------------------------------------------------------- The gate ---

/**
 * Verify the MERGED tree compiles. Returns:
 *   • `{ gated: false }` — the tree is not a Vite-shaped OS app we can check
 *     (Next.js/api-service/unknown); the caller commits ungated + records it.
 *   • `{ gated: true, ok: true }` — compiles clean (tsc AND bundle).
 *   • `{ gated: true, ok: false, diagnostics }` — REJECT with the exact errors (capped).
 *
 * Never throws on a well-formed tree — a slip in the GATE's own machinery surfaces as
 * `gated: false` (fail-open on our error, never a false rejection of the user's code;
 * the downstream CI still confirms).
 */
/**
 * ENVIRONMENT SELF-CHECK — the gate judges app code against the default TS libs and
 * the real React types ON DISK. In the deployed Next standalone image those .d.ts
 * assets are NOT traced (they are never require()'d), so without this check every
 * tree looked like hundreds of false errors and the gate rejected GOOD commits
 * (seen live: "342 compile errors" on a one-page change). If the environment is
 * incomplete the only honest answer is gated:false — never fabricated diagnostics.
 * The Dockerfile now ships these assets; this guard keeps any future packaging
 * regression from turning the gate into a wall again.
 */
export function gateEnvironmentReady(): { ok: true } | { ok: false; missing: string } {
  const libPath = ts.getDefaultLibFilePath({});
  if (!ts.sys.fileExists(libPath)) return { ok: false, missing: `default TS libs (${libPath})` };
  const reactTypes = `${rootDir()}/node_modules/@types/react/index.d.ts`;
  if (!ts.sys.fileExists(reactTypes)) return { ok: false, missing: '@types/react' };
  return { ok: true };
}

/**
 * Is the BUNDLE pass's environment ready? The esbuild-wasm binary is loaded at
 * runtime (never `require()`'d), so the Next standalone tracer can drop it from the
 * image — same packaging class as the tsc type-libs above. When it is missing the
 * gate must NOT fail open on the whole tree: tsc (which catches import-depth /
 * hallucinated members like `os.datasets.update`) still gates; only the bundle net
 * is skipped, honestly. The Dockerfile ships the wasm; this keeps a future regression
 * from silently disabling the bundle net without anyone knowing.
 */
export function gateBundleAssetReady(): { ok: true } | { ok: false; missing: string } {
  return esbuildWasmReady() ? { ok: true } : { ok: false, missing: 'esbuild-wasm binary (esbuild.wasm)' };
}

/**
 * Test seam: force the bundle-asset readiness so the degradation path is exercisable
 * without deleting the real wasm from disk. Production callers omit it and the real
 * `gateBundleAssetReady()` on-disk check is used.
 */
export type CompileGateOpts = { bundleAsset?: { ok: true } | { ok: false; missing: string } };

export async function compileGate(tree: ScaffoldFile[], opts: CompileGateOpts = {}): Promise<CompileGateResult> {
  const env = gateEnvironmentReady();
  if (!env.ok) {
    return {
      gated: false,
      reason: `compile-gate environment incomplete (missing ${env.missing}) — compile check skipped, CI will verify`,
    };
  }
  // tsc is ready. The BUNDLE pass has its OWN asset (the esbuild wasm). If that is
  // missing we still run the authoritative tsc pass and only SKIP the bundle net —
  // degrading one pass honestly instead of failing the whole gate open.
  const bundleAsset = opts.bundleAsset ?? gateBundleAssetReady();
  const shape = detectPreviewShape(tree.map((f) => f.path));
  if (shape.kind !== 'vite') {
    return {
      gated: false,
      reason:
        shape.kind === 'nextjs'
          ? 'legacy Next.js scaffold — not checkable against the vendored OS types (compile gate skipped)'
          : 'not a Vite-shaped sovereign-app — no vendored types to check against (compile gate skipped)',
    };
  }

  try {
    const deps = declaredDeps(tree);
    // 1. tsc — authoritative. Red stops here (best messages; bundle would repeat them).
    const tsDiags = tscDiagnostics(tree, deps);
    if (tsDiags.length > 0) {
      return {
        gated: true,
        ok: false,
        diagnostics: tsDiags.slice(0, MAX_DIAGNOSTICS).map(toDiagnostic),
        total: tsDiags.length,
      };
    }
    // 2. esbuild bundle — the net for what the tsc shims cannot see. Skipped
    //    HONESTLY when its wasm asset is missing (tsc already gated above).
    if (!bundleAsset.ok) {
      return {
        gated: true,
        ok: true,
        bundleSkipped: `bundle check skipped — ${bundleAsset.missing} missing; tsc gated, CI will bundle-verify`,
      };
    }
    const bundleDiags = await bundleDiagnostics(tree, shape.entry.replace(/^\/+/, ''), deps);
    if (bundleDiags.length > 0) {
      return { gated: true, ok: false, diagnostics: bundleDiags.slice(0, MAX_DIAGNOSTICS), total: bundleDiags.length };
    }
    return { gated: true, ok: true };
  } catch {
    // The GATE itself slipped (never the user's code). Fail OPEN — never fabricate a
    // rejection we cannot stand behind; the downstream CI still confirms.
    return { gated: false, reason: 'compile gate could not check this tree (gate error — skipped, fail-open)' };
  }
}

// ------------------------------------------------------------------- Presentation ---

/**
 * Best-effort index of the vendored @sovereign-os/* surface, memoised for the process:
 *   • `members`: for each exported Props type (`BadgeProps`, `SectionProps`, …), the CUSTOM
 *     member names the component adds beyond the native HTML props (e.g. Badge → [tone]).
 *   • `exports`: the named value exports of the package barrels (for TS2305 "no exported member").
 * Parsed by regex from the same source `vendorFiles()` already loads — cheap, deterministic,
 * and fail-soft: any slip yields an empty index so the formatter still renders plain diagnostics.
 */
let vendorApiMemo: { members: Map<string, string[]>; exports: string[] } | null = null;
function vendorApi(): { members: Map<string, string[]>; exports: string[] } {
  if (vendorApiMemo) return vendorApiMemo;
  const members = new Map<string, string[]>();
  const exportsSet = new Set<string>();
  try {
    for (const f of vendorFiles()) {
      if (!/\.tsx?$/.test(f.path)) continue;
      // `export type XProps = <native> & { a?: T; b: U };` → the custom members [a, b].
      for (const m of f.content.matchAll(/export\s+type\s+(\w+)\s*=\s*[^{;]*\{([^}]*)\}/g)) {
        const name = m[1];
        const names = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((x) => x[1]);
        if (names.length) members.set(name, names);
      }
      // Named value exports from the barrels: `export { A, B, type C } from '…'`.
      for (const m of f.content.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const raw of m[1].split(',')) {
          const t = raw.trim();
          if (!t || t.startsWith('type ')) continue; // skip type-only re-exports
          exportsSet.add(t.replace(/\s+as\s+\w+$/, ''));
        }
      }
    }
  } catch {
    /* fail-soft — an empty index just means no member hint */
  }
  vendorApiMemo = { members, exports: [...exportsSet].sort() };
  return vendorApiMemo;
}

/**
 * A best-effort, one-line HINT appended under a diagnostic that targets a `@sovereign-os/*`
 * symbol — turns a blind retry into a first-try fix by listing what the type ACTUALLY offers.
 * Handles TS2339 (`Property 'variant' does not exist on type '… & BadgeProps'`), TS2305
 * (`Module '"@sovereign-os/ui"' has no exported member 'Modal'`) and TS2322 (a bad prop value,
 * e.g. Badge `variant`). Returns '' when it cannot name a concrete member set — never throws.
 */
function memberHint(d: CompileDiagnostic): string {
  try {
    const msg = d.message;
    const { members, exports } = vendorApi();
    // TS2305: no exported member — list the real named exports of the package.
    if (d.code === 2305 && /@sovereign-os\//.test(msg) && exports.length) {
      const bad = /member '([^']+)'/.exec(msg)?.[1];
      return `    → @sovereign-os/ui exports: ${exports.join(', ')}${bad ? ` (no '${bad}')` : ''}`;
    }
    // TS2339 / TS2322: a bad prop on a vendored component. The message references a Props
    // type either by NAME (`BadgeProps`) or by its EXPANDED literal (`… & { tone?: … }`).
    if (d.code === 2339 || d.code === 2322) {
      const bad = /(?:Property|property) '([^']+)'/.exec(msg)?.[1];
      // (a) named Props type → the vendored member index.
      const propsType = /\b(\w+Props)\b/.exec(msg)?.[1];
      const named = propsType ? members.get(propsType) : undefined;
      if (propsType && named) {
        return `    → ${propsType.replace(/Props$/, '')} accepts: ${named.join(', ')}${bad ? ` (you used '${bad}')` : ''}`;
      }
      // (b) expanded literal in the message: pull the custom members from the LAST `{ … }`
      //     object-type block (tsc expands `& { tone?: BadgeTone }` inline for a UI primitive).
      const blocks = [...msg.matchAll(/\{([^{}]*)\}/g)];
      const last = blocks.length ? blocks[blocks.length - 1][1] : '';
      const custom = [...last.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((x) => x[1]);
      if (custom.length) {
        return `    → accepts: ${custom.join(', ')}${bad ? ` (you used '${bad}')` : ''}`;
      }
    }
  } catch {
    /* never throw from the formatter */
  }
  return '';
}

/**
 * Render gate diagnostics into the CORRECTIVE, machine-actionable error text the agent
 * loop feeds back (consistent with the 0.6.54 corrective-error contract): it names each
 * file+line+code, states nothing was written, and instructs a fix-and-recommit. Kept
 * terse + deterministic so it rides in a tool result without bloating the turn. For a
 * @sovereign-os/* symbol error (TS2339/TS2305/TS2322) it appends the type's REAL members
 * so the fix lands on the first retry, not the fifth (best-effort; never throws).
 */
export function formatGateError(result: Extract<CompileGateResult, { gated: true; ok: false }>): string {
  const shown = result.diagnostics;
  const lines = shown.map((d) => {
    const head = `  ${d.file}:${d.line}:${d.column}  ${d.code > 0 ? `TS${d.code}` : 'bundle'}: ${d.message.split('\n')[0]}`;
    const hint = memberHint(d);
    return hint ? `${head}\n${hint}` : head;
  });
  const more = result.total > shown.length ? `\n  …and ${result.total - shown.length} more.` : '';
  return [
    `commit rejected: ${result.total} compile error${result.total === 1 ? '' : 's'} — NOTHING was written.`,
    'Fix these against the vendored @sovereign-os/ui + @sovereign-os/app-sdk API and re-commit:',
    lines.join('\n') + more,
    'Never end the turn with known-red diagnostics: correct the exact errors above and call commit again.',
  ].join('\n');
}

/** A one-line activity-feed note for a gate outcome (reuses the existing line pattern). */
export function gateActivityNote(result: CompileGateResult): string {
  if (!result.gated) return 'compile check skipped (ungated shape)';
  if (result.ok) return result.bundleSkipped ? 'compile check ✓ (bundle skipped — asset missing)' : 'compile check ✓';
  return `compile check ✗ ${result.total} error${result.total === 1 ? '' : 's'}`;
}
