/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tile order (pure) — known surfaces and the rule that applies a saved order to a list
 * USER STORY: As a user who rearranged my tiles I want new artifacts to appear at the end without
 *             breaking my order so that my layout survives new items.
 * ARCHITECTURE:
 *   - Pure and isomorphic: safe in client components, server routes and tests.
 *   - Re-exported by the server store `tile-order.ts` and used by the client hook `useTileOrder.ts`.
 */
// Known surfaces — extend this list when new tabs wire the hook.
export const TILE_ORDER_SURFACES = [
  'dashboard.list',
  'data.list',
  'agents.list',
  'software.list',
  'metrics.list',
  'knowledge.list',

  'files.list',
  'connections.list',
] as const;

export type TileOrderSurface = (typeof TILE_ORDER_SURFACES)[number];

export const ORDER_LIMIT = 500;

/**
 * Apply a saved order to a live item list — the platform-wide merge rule:
 *   1. Items whose id appears in savedOrder come first, in saved order.
 *   2. Items NOT in savedOrder are appended in their default (live list) order.
 *   3. Ids in savedOrder that no longer exist in items are silently dropped.
 *
 * This means adding a new artifact never breaks a user's existing arrangement —
 * it just appears at the end until the user drags it to where they want it.
 */
export function applyTileOrder<T>(
  items: T[],
  savedOrder: string[],
  idOf: (item: T) => string,
): T[] {
  if (!savedOrder.length) return items;
  const byId = new Map(items.map((it) => [idOf(it), it]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of savedOrder) {
    if (seen.has(id)) continue; // a duplicated saved id must not duplicate the item
    const it = byId.get(id);
    if (it !== undefined) {
      ordered.push(it);
      seen.add(id);
    }
  }
  for (const it of items) {
    if (!seen.has(idOf(it))) ordered.push(it);
  }
  return ordered;
}
