/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import type { CurrentUser } from '@/lib/core/auth';
import { getAppBySlugForUser, previewFilesForApp, serveModeOf, type App } from '@/lib/software/apps';
import { compileGate, formatGateError, type CompileGateResult } from '@/lib/software/compile-gate';
import { getCachedAppBundle } from '@/lib/software/preview-runtime';
import { detectPreviewShape } from '@/lib/software/preview-shape';
import type { ScaffoldFile } from '@/lib/software/model';

/**
 * PHASE D — OS runtime serving (no per-app image), behind the App.serveMode flag.
 *
 * This is the platform SURFACE that serves a governed app's committed tree DIRECTLY:
 * it resolves the app by slug (reusing the SAME domain-wide visibility gate deployed
 * apps use — getAppBySlugForUser), bundles the durable mirror tree via the promoted
 * Instant-Preview machinery (preview-runtime.bundleAppTree, cached by tree hash), and
 * serves ONE HTML document that mounts the app inside a SANDBOXED, SAME-ORIGIN iframe.
 *
 * AUTH BRIDGE (reused, not invented): the iframe is SAME-ORIGIN, so the app's
 * createOsClient() calls hit the OS API with `credentials:'include'` — the exact
 * ambient soa_session mechanism the Instant Preview already relies on (see
 * lib/app-sdk/client.ts). No token, no postMessage RPC, no new auth path.
 *
 * HONESTY GATE: the runtime serves ONLY compile-gate-green trees. A red tree (or a
 * shape the gate cannot check) yields an honest "does not compile" / "not runtime-
 * serveable" page carrying the diagnostics — NEVER a broken bundle.
 *
 * SCOPE (stated, not exceeded): Vite-shaped sovereign-app/vite-os SPAs only; no SSR
 * of untrusted code (client-side render inside the sandboxed iframe only). Resource
 * limits are whatever the iframe naturally constrains — no extra quota is imposed yet.
 */

export type RuntimeServeResult = {
  html: string;
  status: number;
  /** The exact CSP applied to the OUTER document response (headers set by the route). */
  csp: string;
};

/** The runtime asset route the iframe import-map points React specifiers at. */
const RUNTIME_ASSET = '/api/software/preview-runtime';

/** Minimal HTML escape for text interpolated into the page (titles, messages). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The OUTER-document CSP. The app itself runs INSIDE a sandboxed iframe (srcdoc), so
 * this frames the platform chrome: it may load the runtime asset facades + call the
 * OS API same-origin, and frame its own (srcdoc) child. `frame-ancestors 'self'`
 * keeps the surface from being embedded off-origin.
 */
function outerCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self'`,
    "img-src 'self' data:",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The INNER (iframe) CSP embedded as a <meta> in the srcdoc. Strict:
 *   • script-src — the runtime facades (same-origin) + the nonce'd inline bundle only.
 *   • connect-src 'self' — the SDK's governed OS calls (same-origin fetch).
 *   • NO frame-src / object-src / base-uri — the app cannot re-frame or rebase.
 * Top-level navigation is separately blocked by omitting allow-top-navigation from
 * the sandbox attribute.
 */
function innerCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The import-map that resolves the bundle's external React deps to the runtime facades. */
function importMap(): string {
  return JSON.stringify({
    imports: {
      react: `${RUNTIME_ASSET}?asset=react`,
      'react/jsx-runtime': `${RUNTIME_ASSET}?asset=jsx-runtime`,
      'react-dom/client': `${RUNTIME_ASSET}?asset=react-dom-client`,
    },
  });
}

/**
 * The srcdoc for the app iframe: import-map + inline CSS + #root + the app bundle as a
 * nonce'd module. Everything the app needs is inlined so the sandboxed frame makes no
 * cross-origin request except the same-origin runtime facades + governed OS API.
 */
function appFrameSrcdoc(bundleJs: string, css: string, nonce: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<meta http-equiv="Content-Security-Policy" content="${esc(innerCsp(nonce))}" />`,
    `<script type="importmap" nonce="${nonce}">${importMap()}</script>`,
    css ? `<style>${css}</style>` : '',
    '</head><body>',
    '<div id="root"></div>',
    `<script type="module" nonce="${nonce}">${bundleJs}</script>`,
    '</body></html>',
  ].join('\n');
}

/** The outer chrome document that hosts the sandboxed app frame. Deliberately minimal. */
function outerDocument(app: App, frameSrcdoc: string, nonce: string): string {
  // allow-scripts: the app runs; allow-same-origin: the SDK's credentialed fetch keeps
  // the OS session (the reused auth bridge). We OMIT allow-top-navigation / allow-popups
  // so the app can never navigate the OS away or spawn windows.
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${esc(app.name)}</title>`,
    '<style>html,body{margin:0;height:100%;background:#0b0b0c}iframe{border:0;width:100%;height:100vh;display:block}</style>',
    '</head><body>',
    `<iframe title="${esc(app.name)}" sandbox="allow-scripts allow-same-origin" srcdoc="${esc(frameSrcdoc)}"></iframe>`,
    // No script in the outer doc today; the nonce is reserved for future chrome + keeps
    // the CSP consistent with the inner frame.
    `<!-- runtime nonce ${esc(nonce)} -->`,
    '</body></html>',
  ].join('\n');
}

/** An honest, standalone error page (no bundle) — its own strict CSP, no app code. */
function errorPage(app: App | null, title: string, detail: string, nonce: string): string {
  const name = app ? esc(app.name) : 'App';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<meta http-equiv="Content-Security-Policy" content="${esc(innerCsp(nonce))}" />`,
    `<title>${name} — not served</title>`,
    '<style>body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0b0b0c;color:#e7e7ea;padding:48px}' +
      'main{max-width:760px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{color:#a9a9b2}' +
      'pre{white-space:pre-wrap;background:#141416;border:1px solid #2a2a2e;border-radius:8px;padding:16px;color:#f0a5a5;font-size:13px}' +
      '.ok{color:#8fdca0}</style>',
    '</head><body><main>',
    `<h1>${esc(title)}</h1>`,
    `<p>${esc(detail)}</p>`,
    '</main></body></html>',
  ].join('\n');
}

/**
 * The gate-red page: names the exact diagnostics (reusing formatGateError's contract),
 * so a runtime-served app that does not compile shows the SAME honest errors the build
 * loop feeds back — never a white screen, never a broken bundle.
 */
function gateRedPage(app: App, result: Extract<CompileGateResult, { gated: true; ok: false }>, nonce: string): string {
  const detail = 'This app’s code does not compile, so the OS runtime will not serve a broken bundle. ' +
    'Fix the errors below and re-commit — the runtime serves the next green tree automatically.';
  const diags = formatGateError(result);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<meta http-equiv="Content-Security-Policy" content="${esc(innerCsp(nonce))}" />`,
    `<title>${esc(app.name)} — does not compile</title>`,
    '<style>body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0b0b0c;color:#e7e7ea;padding:48px}' +
      'main{max-width:820px;margin:0 auto}h1{font-size:20px;margin:0 0 8px}p{color:#a9a9b2}' +
      'pre{white-space:pre-wrap;background:#141416;border:1px solid #2a2a2e;border-radius:8px;padding:16px;color:#f0a5a5;font-size:13px}</style>',
    '</head><body><main>',
    `<h1>${esc(app.name)} — this app’s code does not compile</h1>`,
    `<p>${esc(detail)}</p>`,
    `<pre>${esc(diags)}</pre>`,
    '</main></body></html>',
  ].join('\n');
}

/**
 * Serve one app by slug through the OS runtime. Returns the HTML + status + the CSP the
 * route must set on the OUTER response. Pure of Next primitives so it is unit-testable.
 *
 * Path:
 *   1. resolve + visibility gate (getAppBySlugForUser — 404 if unseeable/absent).
 *   2. serveMode must be 'runtime' (else 409 with an honest note — image-served apps
 *      have their own deployed URL; this surface is opt-in).
 *   3. shape must be Vite (else an honest "not runtime-serveable" page).
 *   4. compile gate GREEN required (red → the diagnostics page; ungated → honest note).
 *   5. bundle (cached by tree hash) → sandboxed iframe document.
 */
export async function serveAppRuntime(slug: string, user: CurrentUser): Promise<RuntimeServeResult> {
  const nonce = randomBytes(16).toString('base64');
  const csp = outerCsp(nonce);

  const app = await getAppBySlugForUser(slug, user);
  if (!app) {
    return { html: errorPage(null, 'App not found', 'No app with that name is visible to you.', nonce), status: 404, csp };
  }

  if (serveModeOf(app) !== 'runtime') {
    return {
      html: errorPage(
        app,
        'Not runtime-served',
        'This app is served by its container image, not the OS runtime. Open its deployed URL instead, ' +
          'or enable “Runtime serving (beta)” on the app’s Publish surface.',
        nonce,
      ),
      status: 409,
      csp,
    };
  }

  const { files } = await previewFilesForApp(app.id, user);
  const shape = detectPreviewShape(files.map((f) => f.path));
  if (shape.kind !== 'vite') {
    return {
      html: errorPage(
        app,
        'Not runtime-serveable',
        'The OS runtime serves only Vite-shaped sovereign-app / vite-os SPAs. This app is a different ' +
          'shape — switch it back to image serving to deploy it.',
        nonce,
      ),
      status: 422,
      csp,
    };
  }

  // HONESTY GATE — serve only a compile-green tree.
  const gate = await compileGate(files);
  if (gate.gated && !gate.ok) {
    return { html: gateRedPage(app, gate, nonce), status: 200, csp };
  }
  if (!gate.gated) {
    // The gate could not check this tree (a slip / unexpected shape). Refuse to serve a
    // bundle we could not verify rather than risk a broken one.
    return {
      html: errorPage(
        app,
        'Could not verify this app',
        'The OS runtime could not compile-check this app’s tree, so it will not serve an unverified bundle. ' +
          'Re-commit, or use image serving.',
        nonce,
      ),
      status: 200,
      csp,
    };
  }

  // Green — bundle (cached by app id + tree hash) and mount in the sandboxed frame.
  let bundle: { js: string; css: string };
  try {
    bundle = await getCachedAppBundle(app.id, files as ScaffoldFile[]);
  } catch (e) {
    return {
      html: errorPage(app, 'Bundle failed', `The app compiled but could not be bundled: ${(e as Error).message}`, nonce),
      status: 200,
      csp,
    };
  }
  const frame = appFrameSrcdoc(bundle.js, bundle.css, nonce);
  return { html: outerDocument(app, frame, nonce), status: 200, csp };
}
