/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * `buildSandboxSrcdoc` — the PURE, unit-testable core of the custom HTML/CSS/JS block.
 *
 * SECURITY MODEL (the guarantee this function + CustomBlockRenderer enforce):
 * The author's html/css/js runs inside an `<iframe srcdoc=…>` rendered with
 *   sandbox="allow-scripts"        ← scripts run, but…
 *   (NO allow-same-origin)         ← …the frame is a UNIQUE, NULL origin.
 * Because the frame is a null origin it CANNOT:
 *   • read or write the OS session cookie (cookies are per-origin; a null origin has none),
 *   • touch the parent DOM or `window.parent` cross-origin (blocked by the same-origin policy),
 *   • call the OS's governed `/api/*` routes AS the user (no ambient credentials cross a null
 *     origin; even a `fetch('/api/…')` resolves against the null origin, not the OS origin).
 * So custom JS can NEVER act as the user or exfiltrate the user's data. The ONLY governed data
 * it can see is what the PARENT fetched (as the user, through the SDK) and inlined READ-ONLY as
 * `window.__DATA__` — a frozen snapshot the frame cannot use to call back.
 *
 * This function only ASSEMBLES the srcdoc string; the `sandbox` attribute (which is what makes
 * the origin null) lives on the <iframe> in CustomBlockRenderer and is asserted by its own note.
 * A strict CSP <meta> is added as belt-and-braces (blocks network/inline beyond what we inline).
 */

/** JSON-serializable rows passed to the sandbox (the SDK's grid, or any plain data). */
export type SandboxData = unknown;

export type BuildSandboxSrcdocInput = {
  html: string;
  css?: string;
  js?: string;
  /** Optional governed data snapshot to inline as a frozen `window.__DATA__`. */
  data?: SandboxData;
};

/**
 * HTML-escape text placed into element content or a double-quoted attribute. Covers the five
 * significant characters so authored html cannot break out of the container we wrap it in.
 * (The author's html is intentionally rendered AS html inside the frame; this escaper is for
 * the wrapper/attribute contexts we control, not the author's own markup.)
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR are valid inside a JSON string but are
// LINE TERMINATORS to the JS parser — a raw one in an inlined literal breaks the script. Match
// them by codepoint (constructed here, never embedded as a raw char in this source file).
const JS_LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']', 'g');

/**
 * Serialize a value for safe inlining inside a `<script>` body. `JSON.stringify` then neutralize
 * the sequences that can break OUT of a script element or start an HTML comment:
 *   `<` `>` `&` → so an author string containing `</script>` / `<!--` can never terminate the
 *   tag or start an HTML comment (each is emitted as a `\uXXXX` escape — still the same JSON
 *   value to the JS parser),
 *   U+2028 / U+2029 → escaped so they don't terminate the JS statement.
 * The result is exactly the intended `window.__DATA__` value, but it can never terminate the
 * script element or the statement.
 */
export function serializeForScript(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(JS_LINE_SEPARATORS, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * A strict Content-Security-Policy for the sandbox document. `'self'` here is the NULL origin,
 * so nothing external loads. Inline `<style>`/`<script>` (which we assemble) are permitted via
 * `'unsafe-inline'` — acceptable because the frame is already a null origin with no credentials,
 * so inline code cannot reach the OS. No network egress (`connect-src 'none'`), no framing of
 * others, no form posts off-origin.
 */
export const SANDBOX_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'self'";

/**
 * Assemble the full `srcdoc` document string for a custom block. Deterministic and pure — the
 * SAME inputs always yield the SAME string (unit-tested). The data snapshot, when present, is
 * inlined FIRST as a frozen `window.__DATA__` so the author's script can read it synchronously.
 */
export function buildSandboxSrcdoc(input: BuildSandboxSrcdocInput): string {
  const { html, css, js, data } = input;

  const dataScript =
    data !== undefined
      ? `<script>window.__DATA__=Object.freeze(${serializeForScript(data)});</script>`
      : '';

  const style = css ? `<style>${css}</style>` : '';
  const script = js ? `<script>${js}</script>` : '';

  // Reset margins + a neutral system font so a bare block still looks at home. The author's
  // css/js can override anything below it. `<meta charset>` first so non-ASCII content renders.
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    // SANDBOX_CSP is a controlled constant with only `'` quotes (no <, >, or " to escape), and
    // the attribute is double-quoted, so it is inlined verbatim — escaping `'` here would only
    // mangle the policy text the browser reads.
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<style>html,body{margin:0;padding:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1813;background:transparent;} *{box-sizing:border-box;}</style>' +
    style +
    '</head><body>' +
    dataScript +
    html +
    script +
    '</body></html>'
  );
}
