/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef } from 'react';

/**
 * Tab navigation reset signal.
 *
 * Several tabs keep their detail/sub-view in *component* state, not in the URL
 * (a dataset detail, an agent SystemView, a workflow detail, a metric Explore…).
 * Next.js client-navigating to that tab's own route — e.g. clicking the already
 * active sidebar link — does NOT change the pathname, so those pages never
 * re-mount and stay stuck on the detail view. This is the tiny cross-cutting
 * primitive that fixes it: the Sidebar broadcasts a nav event on every tab
 * link click, and each tab page resets its detail state back to the list when
 * it hears one. Only the currently-mounted page (the tab you're on) is listening,
 * so a same-route click reliably returns THAT tab to its list; a click to a
 * different tab resets the outgoing page harmlessly right before it unmounts.
 *
 * Deep-linking is unaffected — the event fires only on sidebar clicks, never on
 * initial load or URL-driven navigation.
 */
export const TAB_NAV_EVENT = 'soa:tab-nav';

/** Sidebar → broadcast that a tab link was clicked (best-effort; SSR no-op). */
export function emitTabNav(href: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TAB_NAV_EVENT, { detail: href }));
}

/**
 * Subscribe a tab page's "reset to list" handler to the sidebar nav signal. The
 * latest `reset` is always used (kept in a ref) so callers need not memoize it,
 * and the listener is registered exactly once.
 */
export function useTabNavReset(reset: () => void): void {
  const ref = useRef(reset);
  ref.current = reset;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(TAB_NAV_EVENT, handler);
    return () => window.removeEventListener(TAB_NAV_EVENT, handler);
  }, []);
}
