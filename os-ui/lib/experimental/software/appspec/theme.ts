/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * App-wide theme CSS — PURE scoping so an author's `theme.css` can restyle THEIR app without
 * leaking into the OS chrome. `scopeThemeCss(css, scope)` rewrites every rule's selector list
 * to be a DESCENDANT of `scope` (the app-root class the renderer injects the <style> under),
 * so a bare `.card { … }` becomes `.app-root .card { … }` and a rogue `body { … }` becomes
 * `.app-root body` (inert — the OS body is outside the scope).
 *
 * This is a small, conservative rewriter for the common CSS shapes an app theme uses (rules,
 * `@media` groups, `@keyframes`/`@font-face` left as-is because they carry no selectors to
 * escape the scope). It is NOT a full CSS parser; combined with the author-time size cap and
 * the fact that CSS cannot execute code, that is an acceptable, honest boundary. Anything it
 * can't confidently scope, it drops (fail-closed) rather than emit unscoped.
 */

/** Strip CSS comments (so a `}` inside a comment can't confuse the block matcher). */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Prefix each selector in a comma-separated list with the scope (descendant combinator). */
function scopeSelectorList(selectors: string, scope: string): string {
  return selectors
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${scope} ${s}`)
    .join(', ');
}

/**
 * Scope a stylesheet under `scope`. Walks top-level blocks: an `@media`/`@supports` group is
 * recursed into (its inner rules scoped); `@keyframes`/`@font-face`/other `@`-rules are emitted
 * unchanged (no selector to leak); a normal rule has its selector list scoped. Declarations and
 * unbalanced tails are dropped (fail-closed).
 */
export function scopeThemeCss(css: string, scope: string): string {
  // SECURITY (belt-and-suspenders): this output is injected same-origin into the trusted OS DOM
  // via <style dangerouslySetInnerHTML>. The HTML tokenizer ends a <style> at the first `</style>`
  // (even inside a CSS string/url()), so any `<`/`>` could break out and inject markup that runs in
  // the OS session origin. The schema now BLOCKS such a theme at author time, but a pre-existing
  // stored value must not break out at render time either — so if the input carries `<`/`>` at all,
  // blank the whole stylesheet (legit CSS never needs either).
  if (css.includes('<') || css.includes('>')) return '';
  const src = stripComments(css);
  const out: string[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    // Skip whitespace between blocks.
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;

    // Read the prelude up to the next `{` or `;` (a bare `;` at top level is noise → skip).
    let j = i;
    while (j < n && src[j] !== '{' && src[j] !== ';') j++;
    if (j >= n) break; // no block body — drop the dangling tail (fail-closed)
    if (src[j] === ';') {
      i = j + 1; // a top-level `@import;`-style statement or stray `;` → skip (fail-closed)
      continue;
    }

    const prelude = src.slice(i, j).trim();

    // Find the matching close brace for this block (brace-depth aware).
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') depth--;
      k++;
    }
    if (depth !== 0) break; // unbalanced → drop the rest (fail-closed)
    const body = src.slice(j + 1, k - 1).trim();

    if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
      // Group rule: scope the inner rules, keep the group prelude.
      out.push(`${prelude} { ${scopeThemeCss(body, scope)} }`);
    } else if (prelude.startsWith('@')) {
      // @keyframes / @font-face / @page etc. — no selector to escape the scope; emit as-is.
      out.push(`${prelude} { ${body} }`);
    } else {
      // Normal rule — scope its selector list.
      const scoped = scopeSelectorList(prelude, scope);
      if (scoped) out.push(`${scoped} { ${body} }`);
    }

    i = k;
  }

  return out.join('\n');
}
