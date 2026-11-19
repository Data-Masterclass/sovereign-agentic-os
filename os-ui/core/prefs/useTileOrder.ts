/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    useTileOrder — client hook for drag-to-reorder tile lists
 * USER STORY: As a user I want to drag tiles into my own order and have it saved so that the
 *             artifacts I use most are first.
 * ARCHITECTURE:
 *   - Loads the saved order from `/api/prefs/tile-order` on mount and applies it with
 *     `applyTileOrder` (new items append, stale ids drop).
 *   - Optimistic update on drop, then PUT; rolls back on error. A sequence counter makes sure only
 *     the latest request's outcome applies.
 *   - Drag starts only from the `.drag-handle` element so card text stays selectable. Optional
 *     `groupOf` limits drops to the source item's group. `idOf` and `groupOf` should be stable.
 *   - Usage: `const { orderedItems, itemDragProps, dragHandleProps } = useTileOrder('data.list',
 *     items, idOf)`; spread `itemDragProps(item)` on the tile and `dragHandleProps` on the handle.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyTileOrder, type TileOrderSurface } from '@core/prefs/tile-order-pure';

export function useTileOrder<T>(
  surface: TileOrderSurface,
  items: T[],
  idOf: (item: T) => string,
  opts?: { groupOf?: (item: T) => string },
) {
  const groupOf = opts?.groupOf;
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);

  // Refs for synchronous access inside drag handlers.
  const dragSrcId = useRef<string | null>(null);
  const dragSrcGroup = useRef<string | null>(null);
  // Monotonic persist sequence: only the LATEST request's outcome applies, so a
  // slow stale failure can never roll back a newer successful reorder.
  const persistSeq = useRef(0);

  // Fetch saved order on mount / surface change.
  useEffect(() => {
    let alive = true;
    fetch(`/api/prefs/tile-order?surface=${encodeURIComponent(surface)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (alive && Array.isArray((j as { order?: unknown })?.order)) {
          setSavedOrder((j as { order: string[] }).order);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [surface]);

  // The current effective order: optimistic (in-flight) > saved > default.
  const effectiveOrder = optimistic ?? savedOrder;
  const orderedItems = useMemo(
    () => applyTileOrder(items, effectiveOrder, idOf),
    [items, effectiveOrder, idOf],
  );

  const persist = useCallback(
    async (newOrder: string[]) => {
      const seq = ++persistSeq.current;
      // Capture prev BEFORE state update so rollback restores the right value.
      const prev = optimistic ?? savedOrder;
      setOptimistic(newOrder);
      try {
        const r = await fetch('/api/prefs/tile-order', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ surface, order: newOrder }),
        });
        if (seq !== persistSeq.current) return; // stale — a newer drag owns the state
        if (r.ok) {
          setSavedOrder(newOrder);
          setOptimistic(null);
        } else {
          setOptimistic(prev); // rollback on server error
        }
      } catch {
        if (seq !== persistSeq.current) return;
        setOptimistic(prev); // rollback on network error
      }
    },
    [surface, optimistic, savedOrder],
  );

  const reorder = useCallback(
    (srcId: string, overId: string) => {
      const ids = orderedItems.map(idOf);
      const from = ids.indexOf(srcId);
      const to = ids.indexOf(overId);
      if (from === -1 || to === -1 || from === to) return;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, srcId);
      void persist(next);
    },
    [orderedItems, idOf, persist],
  );

  /** Factory: returns draggable + event props for the item's outer container. */
  const itemDragProps = useCallback(
    (item: T) => {
      const itemId = idOf(item);
      return {
        draggable: true as const,
        'data-drag-over': dragOverId === itemId ? ('true' as const) : undefined,
        'data-drag-source': dragSourceId === itemId ? ('true' as const) : undefined,
        onDragStart: (e: React.DragEvent) => {
          // Drag starts from the ⋮⋮ handle ONLY — cancelling here restores
          // native text selection everywhere else on the card.
          if (!(e.target as HTMLElement)?.closest?.('.drag-handle')) {
            e.preventDefault();
            return;
          }
          dragSrcId.current = itemId;
          dragSrcGroup.current = groupOf ? groupOf(item) : null;
          setDragSourceId(itemId);
          setIsDragging(true);
          e.dataTransfer.effectAllowed = 'move';
          // Default drag image (the element snapshot) — calm, native ghost.
        },
        onDragEnd: () => {
          dragSrcId.current = null;
          dragSrcGroup.current = null;
          setDragSourceId(null);
          setIsDragging(false);
          setDragOverId(null);
        },
        onDragOver: (e: React.DragEvent) => {
          if (!dragSrcId.current) return; // foreign drag (file, other app) — ignore
          if (groupOf && groupOf(item) !== dragSrcGroup.current) return; // cross-group: not a target
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (itemId !== dragSrcId.current && dragOverId !== itemId) setDragOverId(itemId);
        },
        onDragLeave: (e: React.DragEvent) => {
          // Only clear when leaving to outside the element (not a child).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOverId(null);
          }
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          const src = dragSrcId.current;
          const sameGroup = !groupOf || groupOf(item) === dragSrcGroup.current;
          if (src && src !== itemId && sameGroup) reorder(src, itemId);
          dragSrcId.current = null;
          dragSrcGroup.current = null;
          setDragSourceId(null);
          setIsDragging(false);
          setDragOverId(null);
        },
      };
    },
    [idOf, groupOf, dragOverId, dragSourceId, reorder],
  );

  /** Spread onto the ⋮⋮ handle — stops mousedown from interfering with clicks. */
  const dragHandleProps = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  } as const;

  return { orderedItems, itemDragProps, dragHandleProps, isDragging };
}
