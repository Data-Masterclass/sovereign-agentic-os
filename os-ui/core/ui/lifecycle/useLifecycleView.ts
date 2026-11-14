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
import type { Lifecycle, LifecycleKind } from '@core/kernel/object-lifecycle';
import {
  lifecycleForTile,
  requestLifecycles,
  subscribeLifecycles,
} from '@core/ui/lifecycle/lifecycle-cache';

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

/**
 * THE hook a tab's tile list calls — one import, one call, and the list is Studio|Run aware.
 *
 * It needs no lifecycle data from the tab: it asks the shared batched cache about the ids it was
 * given, so every list and every badge in one render costs ONE request. Until the answer lands
 * nothing is hidden (`ready` is false and the full list is returned), because a list that
 * flickers empty is worse than a list that filters a tick late.
 */
export function useLifecycleTiles<T>(
  kind: LifecycleKind,
  items: readonly T[],
  idOf: (item: T) => string,
  role = 'creator',
): {
  tiles: T[];
  surface: ViewSurface;
  hiddenCount: number;
  ready: boolean;
  lifecycleOf: (item: T) => Lifecycle;
} {
  const { surface } = useViewSurface(role);
  const [, bump] = useState(0);

  const ids = useMemo(() => (items ?? []).map(idOf).filter(Boolean), [items, idOf]);
  const complete = requestLifecycles(kind, ids);
  const [ready, setReady] = useState(complete);

  useEffect(() => {
    const off = subscribeLifecycles(kind, () => {
      setReady(true);
      bump((n) => n + 1);
    });
    if (requestLifecycles(kind, ids)) setReady(true);
    return off;
  }, [kind, ids]);

  const lifecycleOfItem = useCallback((item: T) => lifecycleForTile(kind, idOf(item)), [kind, idOf]);

  const tiles = useMemo(
    () => (ready ? tilesForSurface(items, surface, lifecycleOfItem) : [...(items ?? [])]),
    [items, surface, lifecycleOfItem, ready],
  );

  return { tiles, surface, hiddenCount: (items?.length ?? 0) - tiles.length, ready, lifecycleOf: lifecycleOfItem };
}

/**
 * The PREDICATE variant of the same hook, for a list that is computed deep inside a render prop
 * (where a hook may not be called). Call it once in the component body with every id the surface
 * could show, then `.filter(keep)` wherever the list is actually assembled.
 */
export function useLifecycleFilter(
  kind: LifecycleKind,
  ids: readonly string[],
  role = 'creator',
): { keep: (id: string) => boolean; surface: ViewSurface; ready: boolean } {
  const { surface } = useViewSurface(role);
  const [, bump] = useState(0);
  const key = useMemo(() => [...(ids ?? [])].filter(Boolean).sort().join('|'), [ids]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const off = subscribeLifecycles(kind, () => {
      setReady(true);
      bump((n) => n + 1);
    });
    if (requestLifecycles(kind, key ? key.split('|') : [])) setReady(true);
    return off;
  }, [kind, key]);

  const keep = useCallback(
    (id: string) => {
      if (!ready || surface === 'studio') return true;
      return tilesForSurface([id], surface, (x) => lifecycleForTile(kind, x)).length > 0;
    },
    [kind, surface, ready],
  );
  return { keep, surface, ready };
}
