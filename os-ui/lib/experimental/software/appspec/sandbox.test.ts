/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * sandbox.test — the SECURITY-CRITICAL srcdoc builder. Pins the guarantee-relevant properties:
 * the assembled document carries a strict CSP <meta>; injected data is inlined as a FROZEN
 * `window.__DATA__` that cannot terminate the <script> element (`</script>` in the data is
 * neutralized); html is placed in the body; and the function is pure/deterministic. The
 * `sandbox="allow-scripts"` WITHOUT allow-same-origin lives on the iframe (JSX, covered by the
 * CustomBlockRenderer + tsc) — asserted here via the documented CSP + no-network policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxSrcdoc, serializeForScript, escapeHtml, SANDBOX_CSP } from './sandbox.ts';

test('the srcdoc carries a strict CSP meta and no-referrer, and embeds the html', () => {
  const doc = buildSandboxSrcdoc({ html: '<h1>Hello</h1>' });
  assert.match(doc, /<!doctype html>/i);
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /connect-src 'none'/); // no network egress from the sandbox
  assert.match(doc, /name="referrer" content="no-referrer"/);
  assert.match(doc, /<h1>Hello<\/h1>/);
});

test('css and js are wrapped in their own tags only when provided', () => {
  const bare = buildSandboxSrcdoc({ html: '<p>x</p>' });
  // the reset <style> is always present, but no author <style>/<script> beyond it
  assert.doesNotMatch(bare, /color:red/);
  assert.doesNotMatch(bare, /author-js/);

  const full = buildSandboxSrcdoc({ html: '<p>x</p>', css: 'p{color:red}', js: 'var authorjs=1;' });
  assert.match(full, /<style>p\{color:red\}<\/style>/);
  assert.match(full, /<script>var authorjs=1;<\/script>/);
});

test('NO allow-same-origin is granted: the CSP forbids network + off-origin forms (null-origin box)', () => {
  // The srcdoc's CSP is the belt-and-braces layer behind the iframe sandbox flag; assert the
  // policy that makes even inline code unable to phone home.
  assert.match(SANDBOX_CSP, /connect-src 'none'/);
  assert.match(SANDBOX_CSP, /form-action 'none'/);
  assert.match(SANDBOX_CSP, /base-uri 'none'/);
});

test('injected data is inlined as a frozen window.__DATA__', () => {
  const doc = buildSandboxSrcdoc({ html: '<div></div>', data: { rows: [[1, 2]], columns: ['a', 'b'] } });
  assert.match(doc, /window\.__DATA__=Object\.freeze\(/);
  // the payload round-trips (after unescaping the <-style escapes it uses none here)
  assert.match(doc, /"columns":\["a","b"\]/);
});

test('a </script> hidden in the data can NEVER terminate the inlined script element', () => {
  const doc = buildSandboxSrcdoc({ html: '<div></div>', data: { evil: '</script><img src=x onerror=alert(1)>' } });
  // The dangerous raw break-out sequence must NOT survive — the `<` of `</script>` and `<img`
  // is escaped to <, so no literal `</script><img` (nor a raw `<img`) appears in the doc.
  assert.doesNotMatch(doc, /<\/script><img/i);
  assert.doesNotMatch(doc, /<img src=x/i);
  // …and the payload is present in its safe, escaped form.
  assert.match(doc, /\\u003c\/script\\u003e\\u003cimg/i);
});

test('serializeForScript escapes <, >, & so break-out sequences are inert', () => {
  const s = serializeForScript({ a: '<b>&</b>' });
  assert.doesNotMatch(s, /</);
  assert.doesNotMatch(s, />/);
  assert.match(s, /\\u003c/);
  assert.match(s, /\\u003e/);
  assert.match(s, /\\u0026/);
});

test('serializeForScript defaults undefined to null (valid JSON literal)', () => {
  assert.equal(serializeForScript(undefined), 'null');
});

test('escapeHtml covers the five significant characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('buildSandboxSrcdoc is deterministic (same input → same output)', () => {
  const input = { html: '<h1>x</h1>', css: 'h1{color:blue}', js: 'x()', data: { n: 1 } };
  assert.equal(buildSandboxSrcdoc(input), buildSandboxSrcdoc(input));
});

test('with no data there is no __DATA__ script at all', () => {
  const doc = buildSandboxSrcdoc({ html: '<h1>x</h1>' });
  assert.doesNotMatch(doc, /window\.__DATA__/);
});
