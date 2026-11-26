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
import { perUserDoc } from '@core/prefs/per-user-doc';
export { applyTileOrder, TILE_ORDER_SURFACES, ORDER_LIMIT } from '@core/prefs/tile-order-pure';
export type { TileOrderSurface } from '@core/prefs/tile-order-pure';
import { type TileOrderSurface, ORDER_LIMIT } from '@core/prefs/tile-order-pure';

const INDEX = 'os-user-prefs';
// Shared durable-mirror core (probe → bootstrap-on-404 → read/write-through): core/infra/os-mirror.ts.
const mirror = osMirror({ index: INDEX });

function prefKey(userId: string, surface: string): string {
  return `${userId}::${surface}`;
}
function docId(userId: string, surface: string): string {
  return `tileorder-${userId}-${surface.replace(/\./g, '_')}`;
}
function docIdOfKey(key: string): string {
  const i = key.lastIndexOf('::');
  return docId(key.slice(0, i), key.slice(i + 2));
}

// One record per user + surface, read BY ID (core/prefs/per-user-doc.ts): no whole-index read, so no
// record cap, and a failed read is never cached as "no order" — it is retried with backoff.
type PrefsState = { docs: ReturnType<typeof perUserDoc<string[]>> };
const STATE_KEY = Symbol.for('soa.prefs.tileOrder.v2');
function docs(): PrefsState['docs'] {
  const g = globalThis as unknown as Record<symbol, PrefsState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      docs: perUserDoc<string[]>({
        read: (id) => mirror.read(id),
        docId: docIdOfKey,
        parse: (doc) => {
          const o = (doc as { order?: unknown } | null)?.order;
          return Array.isArray(o) ? o.filter((x): x is string => typeof x === 'string') : null;
        },
      }),
    };
  }
  return g[STATE_KEY]!.docs;
}

function writeThrough(userId: string, surface: string, order: string[]): void {
  mirror.writeThrough(docId(userId, surface), { userId, surface, order, updatedAt: new Date().toISOString() });
}

/** Get the saved tile order for a user + surface (returns [] if none saved). */
export async function getTileOrder(userId: string, surface: TileOrderSurface): Promise<string[]> {
  return (await docs().get(prefKey(userId, surface))) ?? [];
}

/** Persist the tile order for a user + surface. Trims to ORDER_LIMIT. */
export async function setTileOrder(
  userId: string,
  surface: TileOrderSurface,
  ids: string[],
): Promise<void> {
  const trimmed = ids.slice(0, ORDER_LIMIT);
  docs().remember(prefKey(userId, surface), trimmed);
  writeThrough(userId, surface, trimmed);
}

/** Test seam: drop the in-process cache so tests start fresh. */
export function __resetForTests(): void {
  docs().reset();
  mirror.__reset();
}
