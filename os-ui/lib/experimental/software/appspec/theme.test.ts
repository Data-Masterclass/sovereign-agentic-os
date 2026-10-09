/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * theme.test — the PURE theme-CSS scoper. Every rule's selector is rewritten to a descendant of
 * the app-root scope so an author's CSS restyles their app but cannot leak into the OS chrome.
 * `@media` groups are recursed; `@keyframes` is left intact; comments and malformed tails are
 * dropped fail-closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeThemeCss } from './theme.ts';

const SCOPE = '.sb-appspec-root';

test('a bare rule is scoped under the app root', () => {
  const out = scopeThemeCss('.card { color: red; }', SCOPE);
  assert.match(out, /\.sb-appspec-root \.card \{ color: red; \}/);
});

test('a comma selector list is scoped per-selector', () => {
  const out = scopeThemeCss('h1, h2 { margin: 0; }', SCOPE);
  assert.match(out, /\.sb-appspec-root h1, \.sb-appspec-root h2/);
});

test('a rogue body/html selector is neutralised (scoped, so it cannot hit the OS body)', () => {
  const out = scopeThemeCss('body { background: black; }', SCOPE);
  assert.match(out, /\.sb-appspec-root body \{/);
  assert.doesNotMatch(out, /^body \{/m);
});

test('an @media group is kept, its inner rules scoped', () => {
  const out = scopeThemeCss('@media (max-width: 600px) { .card { padding: 4px; } }', SCOPE);
  assert.match(out, /@media \(max-width: 600px\)/);
  assert.match(out, /\.sb-appspec-root \.card \{ padding: 4px; \}/);
});

test('@keyframes is emitted intact (no selector to leak the scope)', () => {
  const out = scopeThemeCss('@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }', SCOPE);
  assert.match(out, /@keyframes spin/);
  assert.doesNotMatch(out, /\.sb-appspec-root from/);
});

test('comments are stripped and cannot smuggle an unscoped rule', () => {
  const out = scopeThemeCss('/* } body { color: red } */ .ok { color: green; }', SCOPE);
  assert.match(out, /\.sb-appspec-root \.ok \{ color: green; \}/);
  assert.doesNotMatch(out, /^body/m);
});

test('a malformed unbalanced tail is dropped fail-closed', () => {
  const out = scopeThemeCss('.ok { color: green; } .broken { color:', SCOPE);
  assert.match(out, /\.sb-appspec-root \.ok/);
  assert.doesNotMatch(out, /\.broken/);
});

test('a stray top-level declaration (no braces) is dropped, not emitted unscoped', () => {
  const out = scopeThemeCss('color: red; .ok { color: green; }', SCOPE);
  // the leading `color: red;` is a top-level statement with no block — dropped.
  assert.match(out, /\.sb-appspec-root \.ok/);
  assert.doesNotMatch(out, /^color: red/m);
});

test('empty input yields empty output', () => {
  assert.equal(scopeThemeCss('', SCOPE), '');
});

// --- Security (0.6.131): `</style>` breakout guard --------------------------------------
// The scoper's output is injected into the TRUSTED OS DOM same-origin via
// <style dangerouslySetInnerHTML>. The HTML tokenizer ends a <style> at the first
// `</style>` (case-insensitive, even inside a CSS string/url()), so any `<`/`>` in the
// CSS could break out and inject markup that runs in the OS session origin. Legit CSS
// never needs `<` or `>`, so a belt-and-suspenders guard blanks the whole stylesheet.

test('css containing a </style> breakout via content string is neutralised to empty', () => {
  const payload = '.x { content: "</style><img src=x onerror=alert(1)>"; }';
  assert.equal(scopeThemeCss(payload, SCOPE), '');
});

test('css with a raw </style><script> breakout is neutralised to empty', () => {
  const payload = 'foo</style><script>alert(1)</script> { color:red }';
  assert.equal(scopeThemeCss(payload, SCOPE), '');
});

test('css with a </style> inside @font-face url() is neutralised to empty', () => {
  const payload = '@font-face { src: url("</style><script>alert(1)</script>"); }';
  assert.equal(scopeThemeCss(payload, SCOPE), '');
});

test('any lone < or > blanks the stylesheet (no partial passthrough)', () => {
  assert.equal(scopeThemeCss('.a { width: calc(100% > 3); }', SCOPE), '');
  assert.equal(scopeThemeCss('.a::before { content: "<"; }', SCOPE), '');
});
