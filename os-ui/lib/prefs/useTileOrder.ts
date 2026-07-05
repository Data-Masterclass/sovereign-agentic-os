/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyTileOrder, type TileOrderSurface } from './tile-order-pure';

/**
 * useTileOrder — platform-wide client hook for drag-to-reorder tile lists.
 *
 * Fetches the session user's saved order on mount, applies it to the live items
 * (new items append; stale ids drop), and provides HTML5 drag handlers. Optimistic
 * update on drop with server persist + rollback on error (a stale request's
 * outcome never overrides a newer drag — monotonic sequence guard).
 *
 * Drag starts ONLY from the ⋮⋮ `.drag-handle` element — dragging anywhere else
 * on the card is cancelled so text stays selectable (Apple-lens: never trade a
 * basic affordance for a power feature).
 *
 * Usage:
 *   const { orderedItems, itemDragProps, dragHandleProps } =
 *     useTileOrder('strategy.pillars', cards, idOf);
 *
 *   <section {...itemDragProps(card)}>
 *     <span className="drag-handle" {...dragHandleProps}>⋮⋮</span>
 *     ... card content ...
 *   </section>
 *
 * Options:
 *   groupOf — when the list renders in visual groups (e.g. Big Bets grouped by
 *   pillar), pass a group-key fn; drops are then constrained to the source's
 *   group so the highlight never promises a move the re-grouping would undo.
 *
 * Returned API (for follow-up wiring of other tabs):
 *   orderedItems    — live items in the user's preferred order (memoized)
 *   itemDragProps   — factory: draggable + drag-event props for the container.
 *                     Emits data-drag-over / data-drag-source for the CSS.
 *   dragHandleProps — spread onto the ⋮⋮ glyph (stops mousedown bubbling)
 *   isDragging      — true while a drag is in flight (optional cursor styling)
 *
 * NOTE: idOf/groupOf should be stable references (module-level or useCallback)
 * so the memoization holds.
 */
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
