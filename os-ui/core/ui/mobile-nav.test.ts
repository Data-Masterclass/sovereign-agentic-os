/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Phone navigation drawer + shared phone layout — the contract
 * USER STORY: As a user on a 390 px phone I want a menu button that opens the navigation as a
 *             drawer and closes it on Escape, backdrop or navigation, and pages that never scroll
 *             sideways, without the desktop layout changing.
 * ARCHITECTURE:
 *   - Drives the pure logic in `./mobile-nav.ts` (navReducer, nextTrapIndex, lockScroll) — no DOM.
 *   - Static checks of the wiring that cannot run under `node --test` (Sidebar.tsx is JSX and
 *     imports next/navigation): the Sidebar reads its state from navReducer and exposes
 *     aria-expanded / aria-controls; app/styles/mobile.css is imported LAST and keeps every phone
 *     rule inside the phone query, so desktop (≥ 1024 px) is untouched by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BREAKPOINTS,
  PHONE_QUERY,
  TABLET_QUERY,
  lockScroll,
  navReducer,
  nextTrapIndex,
  type NavEvent,
} from './mobile-nav.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('breakpoints: phone < 640, tablet < 1024, as matchMedia queries', () => {
  assert.equal(BREAKPOINTS.phoneMax, 639.98);
  assert.equal(BREAKPOINTS.tabletMax, 1023.98);
  assert.equal(PHONE_QUERY, '(max-width: 639.98px)');
  assert.equal(TABLET_QUERY, '(max-width: 1023.98px)');
});

test('navReducer: toggle flips, open opens', () => {
  assert.equal(navReducer(false, 'toggle'), true);
  assert.equal(navReducer(true, 'toggle'), false);
  assert.equal(navReducer(false, 'open'), true);
  assert.equal(navReducer(true, 'open'), true);
});

test('navReducer: every dismissal closes, from either state', () => {
  const closers: NavEvent[] = ['close', 'escape', 'backdrop', 'route-change', 'left-phone'];
  for (const ev of closers) {
    assert.equal(navReducer(true, ev), false, `${ev} closes an open drawer`);
    assert.equal(navReducer(false, ev), false, `${ev} keeps a closed drawer closed`);
  }
});

test('nextTrapIndex: Tab wraps last → first, Shift+Tab wraps first → last', () => {
  assert.equal(nextTrapIndex(4, 5, false), 0);
  assert.equal(nextTrapIndex(0, 5, true), 4);
});

test('nextTrapIndex: inside the list the browser moves focus itself', () => {
  assert.equal(nextTrapIndex(1, 5, false), null);
  assert.equal(nextTrapIndex(3, 5, true), null);
});

test('nextTrapIndex: focus outside the drawer is pulled back in', () => {
  assert.equal(nextTrapIndex(-1, 5, false), 0);
  assert.equal(nextTrapIndex(-1, 5, true), 4);
});

test('nextTrapIndex: nothing focusable → nothing to do', () => {
  assert.equal(nextTrapIndex(-1, 0, false), null);
});

test('lockScroll: hides overflow, compensates the scrollbar, restores the exact previous values', () => {
  const style = { overflow: 'auto', paddingRight: '3px' };
  const restore = lockScroll(style, 15);
  assert.deepEqual(style, { overflow: 'hidden', paddingRight: '15px' });
  restore();
  assert.deepEqual(style, { overflow: 'auto', paddingRight: '3px' });
});

test('lockScroll: no scrollbar (phones) → padding untouched; empty inline values restore to empty', () => {
  const style = { overflow: '', paddingRight: '' };
  const restore = lockScroll(style, 0);
  assert.deepEqual(style, { overflow: 'hidden', paddingRight: '' });
  restore();
  assert.deepEqual(style, { overflow: '', paddingRight: '' });
});

test('Sidebar wires the drawer: reducer state, aria-expanded/-controls, route change closes', () => {
  const src = read('./Sidebar.tsx');
  assert.match(src, /useReducer\(navReducer, false\)/);
  assert.match(src, /aria-expanded=\{navOpen\}/);
  assert.match(src, /aria-controls="os-main-nav"/);
  assert.match(src, /id="os-main-nav"/);
  assert.match(src, /navDispatch\('route-change'\);\s*\}, \[pathname\]\)/);
  assert.match(src, /navDispatch\('backdrop'\)/);
  assert.match(src, /e\.key === 'Escape'/);
  assert.match(src, /lockScroll\(/);
  // The fixed full-screen domain prompt must not live inside the (transformed) drawer.
  const asideAt = src.search(/<aside\s+ref=/);
  assert.ok(asideAt > 0);
  assert.ok(src.indexOf('<DomainStartPrompt') < asideAt, 'DomainStartPrompt renders outside <aside>');
});

test('mobile.css is imported last and every rule sits behind the phone query', () => {
  const globals = read('../../app/globals.css');
  const imports = [...globals.matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
  assert.equal(imports.at(-1), './styles/mobile.css');

  const css = read('../../app/styles/mobile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // Outside @media blocks only the "hide the phone pieces" rule may exist.
  let depth = 0;
  let top = '';
  for (const ch of css) {
    if (ch === '{') depth++;
    if (depth === 0) top += ch;
    if (ch === '}') depth--;
  }
  const topSelectors = top
    .split('@media')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('('));
  assert.deepEqual(topSelectors.map((s) => s.replace(/\s+/g, ' ')), ['.mnav-toggle, .mnav-backdrop, .mnav-close']);
  for (const q of css.match(/@media[^{]+/g) ?? []) {
    assert.match(q, /\(max-width: 639\.98px\)/, `every media block in mobile.css is a phone block: ${q}`);
  }
});

test('mobile.css covers the shared root causes', () => {
  const css = read('../../app/styles/mobile.css');
  const has = (re: RegExp, why: string) => assert.match(css, re, why);
  has(/\.topbar \{[^}]*flex-wrap: wrap/, 'PageHeader topbar wraps');
  has(/\.topbar-actions \{[^}]*flex-wrap: wrap/, 'topbar actions wrap');
  has(/\.row \{[^}]*flex-wrap: wrap/, '.row wraps');
  has(/\.seg \{[^}]*overflow-x: auto/, '.seg scrolls inside itself');
  has(/select \{[^}]*min-width: 0/, 'select drops its 130 px floor');
  has(/\.signin-wrap \{[^}]*overflow-y: auto/, 'sign-in scrolls');
  has(/\.home-content \{[^}]*padding: 18px 16px/, 'home-content phone padding wins the source order');
  has(/\.sidebar\.is-open \{[^}]*transform: none/, 'drawer opens');
  has(/prefers-reduced-motion: reduce\)[\s\S]*\.sidebar[\s\S]*transition: none/, 'reduced motion');
  has(/\.main table:not\(\.table-wrap table\)[^}]*overflow-x: auto/, 'bare table safety net');
});

test('grid minimums never exceed a phone: min(100%, N px)', () => {
  const bs = read('../../app/styles/builder-simple.css');
  const conn = read('../../app/styles/connections.css');
  const mon = read('../../app/(govern)/monitoring/monitoring.css');
  assert.match(bs, /\.dash-grid \{[^}]*minmax\(min\(100%, 300px\), 1fr\)/);
  assert.match(conn, /\.conn-doors \{[^}]*minmax\(min\(100%, 300px\), 1fr\)/);
  assert.match(mon, /\.mon-lens-grid \{[^}]*minmax\(min\(100%, 330px\), 1fr\)/);
  assert.match(mon, /\.mon-tile-grid \{[^}]*minmax\(min\(100%, 320px\), 1fr\)/);
});
