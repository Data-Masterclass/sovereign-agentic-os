/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/os-mirror';
export { applyTileOrder, TILE_ORDER_SURFACES, ORDER_LIMIT } from './tile-order-pure';
export type { TileOrderSurface } from './tile-order-pure';
import { type TileOrderSurface, ORDER_LIMIT } from './tile-order-pure';

/**
 * Per-user tile-order preference store — the server-side half of the platform-
 * wide tile-reorder mechanism. Persists via the standard dual pattern:
 * authoritative in-process globalThis-pinned Map (works with NO cluster) plus
 * best-effort OpenSearch write-through to "os-user-prefs" for durability on a
 * real deploy. Same pattern as lib/marketplace/store.ts and lib/agents/store.ts.
 *
 * The session user is the only valid caller — enforced at the route layer, not
 * here, so this module stays free of Next.js request context.
 */

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
