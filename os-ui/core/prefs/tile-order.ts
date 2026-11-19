/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tile order store — per-user saved tile order for each list surface
 * USER STORY: As a user I want the tile order I set to be kept across sessions so that my lists stay
 *             arranged the way I left them.
 * ARCHITECTURE:
 *   - Server-only. In-process Map pinned on `globalThis` plus a best-effort OpenSearch mirror
 *     (`os-user-prefs`); works with no cluster. Same pattern as `tabs/agents/lib/store.ts`.
 *   - Called by `app/api/prefs/tile-order/route.ts`, which restricts access to the session user.
 *   - Trims a saved order to `ORDER_LIMIT` ids.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
export { applyTileOrder, TILE_ORDER_SURFACES, ORDER_LIMIT } from '@core/prefs/tile-order-pure';
export type { TileOrderSurface } from '@core/prefs/tile-order-pure';
import { type TileOrderSurface, ORDER_LIMIT } from '@core/prefs/tile-order-pure';

type PrefsState = { cache: Map<string, string[]> | null };
const STATE_KEY = Symbol.for('soa.prefs.tileOrder');
function state(): PrefsState {
  const g = globalThis as unknown as Record<symbol, PrefsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null };
  return g[STATE_KEY]!;
}

const INDEX = 'os-user-prefs';
// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: INDEX });

function prefKey(userId: string, surface: string): string {
  return `${userId}::${surface}`;
}
function docId(userId: string, surface: string): string {
  return `tileorder-${userId}-${surface.replace(/\./g, '_')}`;
}

async function getCache(): Promise<Map<string, string[]>> {
  const s = state();
  if (s.cache) return s.cache;
  const map = new Map<string, string[]>();
  type Doc = { userId: string; surface: string; order: string[] };
  const docs = (await mirror.hydrate(2000)) ?? []; // null → mirror down → in-memory only
  for (const d of docs as Doc[]) {
    map.set(prefKey(d.userId, d.surface), d.order);
  }
  s.cache = map;
  return map;
}

function writeThrough(userId: string, surface: string, order: string[]): void {
  mirror.writeThrough(docId(userId, surface), { userId, surface, order, updatedAt: new Date().toISOString() });
}

/** Get the saved tile order for a user + surface (returns [] if none saved). */
export async function getTileOrder(userId: string, surface: TileOrderSurface): Promise<string[]> {
  const map = await getCache();
  return map.get(prefKey(userId, surface)) ?? [];
}

/** Persist the tile order for a user + surface. Trims to ORDER_LIMIT. */
export async function setTileOrder(
  userId: string,
  surface: TileOrderSurface,
  ids: string[],
): Promise<void> {
  const trimmed = ids.slice(0, ORDER_LIMIT);
  const map = await getCache();
  map.set(prefKey(userId, surface), trimmed);
  writeThrough(userId, surface, trimmed);
}

/** Test seam: drop the in-process cache so tests start fresh. */
export function __resetForTests(): void {
  const s = state();
  s.cache = null;
  mirror.__reset();
}
