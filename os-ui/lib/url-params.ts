/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tiny client-side helpers to persist small pieces of UI state (which chat /
 * system / embedded tool is open) in the URL query string. We drive the URL via
 * the History API directly rather than `useSearchParams`, so a globally-mounted
 * provider (ToolWindowProvider) doesn't force every page under a Suspense
 * boundary. A reload re-reads the params; a `popstate` listener in each caller
 * makes browser back/forward restore state too; and the URL is shareable.
 *
 * `computeSearch` is PURE (no `window`) so it runs under `node --test`.
 */

/** Given a current query string, return the next one with `patch` applied. */
export function computeSearch(current: string, patch: Record<string, string | null>): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/** Read one query param (client-only; returns null on the server). */
export function getUrlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Apply a patch to the current URL's query string. Defaults to `replaceState`
 * (keep-current, e.g. a mode toggle); pass `{ push: true }` when opening a
 * surface so browser Back closes it.
 */
export function patchUrl(patch: Record<string, string | null>, opts?: { push?: boolean }): void {
  if (typeof window === 'undefined') return;
  const next = computeSearch(window.location.search, patch);
  const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
  const state = window.history.state;
  if (opts?.push) window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
}
