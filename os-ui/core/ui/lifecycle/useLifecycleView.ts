/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    useLifecycleView — the ONE hook every tab's tile list calls
 * USER STORY: As a user I expect the Studio | Run toggle in the header to mean the same thing on
 *             every tab, instantly, without each tab inventing its own idea of what Run shows.
 * ARCHITECTURE:
 *   - ONE hook, so the rule lives in one place: Studio shows everything, Run shows only what is
 *     live (`tilesForSurface`). A tab's tile list calls it and renders what comes back — that is
 *     the whole integration, and it is why there is nothing else new on screen.
 *   - The surface is read from the per-user preference once and then shared through a window
 *     event, so flipping the header toggle re-filters every mounted list without prop-drilling
 *     a surface through thirteen tabs.
 *   - Logic lives in `@core/prefs/view-surface-pure`; this file is the React plumbing only.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  defaultViewSurface,
  isViewSurface,
  tilesForSurface,
  type ViewSurface,
} from '@core/prefs/view-surface-pure';
import type { Lifecycle } from '@core/kernel/object-lifecycle';

/** The event the header toggle fires and every tile list listens for. */
export const VIEW_SURFACE_EVENT = 'os:view-surface';

/** Tell every mounted tile list that the surface changed. */
export function announceViewSurface(surface: ViewSurface): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VIEW_SURFACE_EVENT, { detail: surface }));
}

/** The current surface, fetched once per page and kept in step with the header toggle. */
export function useViewSurface(role = 'creator'): {
  surface: ViewSurface;
  setSurface: (s: ViewSurface) => void;
  ready: boolean;
} {
  const [surface, setLocal] = useState<ViewSurface>(() => defaultViewSurface(role));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/prefs/view-surface', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { surface?: unknown } | null) => {
        if (live && d && isViewSurface(d.surface)) setLocal(d.surface);
      })
      .catch(() => {
        /* no preference service ⇒ the role's default, never a blank screen */
      })
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent).detail;
      if (isViewSurface(next)) setLocal(next);
    };
    window.addEventListener(VIEW_SURFACE_EVENT, onChange);
    return () => window.removeEventListener(VIEW_SURFACE_EVENT, onChange);
  }, []);

  const setSurface = useCallback((next: ViewSurface) => {
    setLocal(next);
    announceViewSurface(next);
    void fetch('/api/prefs/view-surface', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: next }),
    }).catch(() => {
      /* the choice still applies for this session; it just is not remembered */
    });
  }, []);

  return { surface, setSurface, ready };
}

/**
 * THE tile-list hook. Give it the items and how to read each item's lifecycle; it returns the
 * ones this surface shows, plus the surface itself for the empty-state copy.
 */
export function useLifecycleView<T>(
  items: readonly T[],
  lifecycleOfItem: (item: T) => Lifecycle,
  role = 'creator',
): { tiles: T[]; surface: ViewSurface; hiddenCount: number } {
  const { surface } = useViewSurface(role);
  const tiles = useMemo(() => tilesForSurface(items, surface, lifecycleOfItem), [items, surface, lifecycleOfItem]);
  return { tiles, surface, hiddenCount: (items?.length ?? 0) - tiles.length };
}
