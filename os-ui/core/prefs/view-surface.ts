/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    The Studio | Run surface choice — the per-user server store
 * USER STORY: As a user I want the OS to remember which surface I work on, on every device,
 *             without me setting it again after a deploy.
 * ARCHITECTURE:
 *   - The same dual pattern as `core/prefs/tile-order.ts`: authoritative in-process map plus a
 *     best-effort OpenSearch write-through, so a laptop install with no cluster still works and
 *     a dead mirror degrades to "the role's default" rather than an error.
 *   - The user id ALWAYS comes from the session, enforced at the route; this module stays free
 *     of Next request context so it is directly testable.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { defaultViewSurface, parseViewSurface, type ViewSurface } from '@core/prefs/view-surface-pure';

export * from '@core/prefs/view-surface-pure';

type State = { cache: Map<string, ViewSurface> | null };
const STATE_KEY = Symbol.for('soa.prefs.viewSurface');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null };
  return g[STATE_KEY]!;
}

const mirror = osMirror({ index: 'os-user-prefs' });

function docId(userId: string): string {
  return `viewsurface-${userId}`;
}

async function getCache(): Promise<Map<string, ViewSurface>> {
  const s = state();
  if (s.cache) return s.cache;
  const map = new Map<string, ViewSurface>();
  type Doc = { userId?: string; surface?: string; viewSurface?: string };
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const d of docs as Doc[]) {
    // The index is shared with tile-order, whose docs carry `surface` as a LIST surface; only
    // our own documents carry `viewSurface`, so the two never read each other's rows.
    if (!d?.userId || !d.viewSurface) continue;
    map.set(d.userId, parseViewSurface(d.viewSurface, 'creator'));
  }
  s.cache = map;
  return map;
}

/** The user's remembered surface, or their role's default when they have never chosen. */
export async function getViewSurface(userId: string, role: string): Promise<ViewSurface> {
  const map = await getCache();
  return map.get(userId) ?? defaultViewSurface(role);
}

/** Remember the user's choice. */
export async function setViewSurface(userId: string, surface: ViewSurface): Promise<void> {
  const map = await getCache();
  map.set(userId, surface);
  mirror.writeThrough(docId(userId), { userId, viewSurface: surface, updatedAt: new Date().toISOString() });
}

/** Test seam. */
export function __resetViewSurface(): void {
  state().cache = null;
  mirror.__reset();
}
