/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Phone navigation drawer — the breakpoint convention and the drawer's state logic
 * USER STORY: As a user on a phone I want the main navigation behind a menu button, opening as a
 *             drawer I can close with Escape, the backdrop or by following a link, so that the
 *             page itself gets the whole 390 px width.
 * ARCHITECTURE:
 *   - The ONE breakpoint convention for os-ui (documented in docs/components/os-ui.md →
 *     "Phone and tablet layout"): phone < 640 px, tablet < 1024 px, desktop ≥ 1024 px. CSS
 *     writes the same numbers as `(max-width: 639.98px)` / `(max-width: 1023.98px)`; plain CSS
 *     has no custom media, so the numbers live here and in a comment block in app/styles/mobile.css.
 *   - Pure, DOM-free: `navReducer` (open/close transitions), `nextTrapIndex` (Tab wrap inside the
 *     drawer) and `lockScroll` (body scroll lock with restore). `core/ui/Sidebar.tsx` wires them to
 *     React and the DOM; this module is what `mobile-nav.test.ts` drives under `node --test`.
 */

/** Upper bounds (inclusive) in CSS px. `.98` keeps 640 / 1024 themselves on the larger side. */
export const BREAKPOINTS = { phoneMax: 639.98, tabletMax: 1023.98 } as const;

/** matchMedia query for "this is a phone" — the drawer only exists below it. */
export const PHONE_QUERY = `(max-width: ${BREAKPOINTS.phoneMax}px)`;
/** matchMedia query for "phone or tablet" — anything narrower than the desktop layout. */
export const TABLET_QUERY = `(max-width: ${BREAKPOINTS.tabletMax}px)`;

/** Everything that can happen to the drawer. */
export type NavEvent =
  | 'toggle' // the menu button
  | 'open'
  | 'close' // the drawer's own close button
  | 'escape' // Escape key while open
  | 'backdrop' // click on the dimmed backdrop
  | 'route-change' // a link inside the drawer (or anywhere) navigated
  | 'left-phone'; // the viewport grew past the phone breakpoint — no drawer exists there

/** The drawer is a boolean: open or not. Every event except toggle/open closes it. */
export function navReducer(open: boolean, event: NavEvent): boolean {
  switch (event) {
    case 'toggle':
      return !open;
    case 'open':
      return true;
    case 'close':
    case 'escape':
    case 'backdrop':
    case 'route-change':
    case 'left-phone':
      return false;
    default: {
      // Exhaustiveness: a new event must decide what it does.
      const never: never = event;
      return never;
    }
  }
}

/** Elements Tab may land on inside the drawer. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Focus trap arithmetic. Given the index of the focused element among `count` focusables
 * (-1 when focus is outside the drawer) and the Tab direction, return the index focus must
 * move to — or `null` to let the browser move focus normally (it stays inside).
 */
export function nextTrapIndex(current: number, count: number, shiftKey: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey && current === 0) return count - 1;
  if (!shiftKey && current === count - 1) return 0;
  return null;
}

/** The two style properties the scroll lock touches (a CSSStyleDeclaration satisfies it). */
export interface LockableStyle {
  overflow: string;
  paddingRight: string;
}

/**
 * Lock page scroll while the drawer is open. Returns the restore function, which puts the
 * previous inline values back exactly (an empty string removes the inline value). The
 * scrollbar gutter is compensated so the page does not shift where scrollbars take width.
 */
export function lockScroll(style: LockableStyle, scrollbarWidth = 0): () => void {
  const prev = { overflow: style.overflow, paddingRight: style.paddingRight };
  style.overflow = 'hidden';
  if (scrollbarWidth > 0) style.paddingRight = `${scrollbarWidth}px`;
  return () => {
    style.overflow = prev.overflow;
    style.paddingRight = prev.paddingRight;
  };
}
