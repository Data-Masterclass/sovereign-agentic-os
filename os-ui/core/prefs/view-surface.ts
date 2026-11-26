/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    The Studio | Run surface choice — the per-user server store
 * USER STORY: As a user I want the OS to remember which surface I work on, on every device,
 *             without me setting it again after a deploy.
 * ARCHITECTURE:
 *   - One record per user in `os-user-prefs` (doc id `viewsurface-<userId>`), read BY ID through
 *     `per-user-doc.ts`: no whole-index read (no record cap), and a failed read is never cached as
 *     "never chosen" — it serves the role's default for now and is retried with backoff. Writes are
 *     a best-effort write-through, so a laptop install with no cluster still works.
 *   - The user id ALWAYS comes from the session, enforced at the route; this module stays free
 *     of Next request context so it is directly testable.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { perUserDoc } from '@core/prefs/per-user-doc';
import { defaultViewSurface, isViewSurface, type ViewSurface } from '@core/prefs/view-surface-pure';

export * from '@core/prefs/view-surface-pure';

const mirror = osMirror({ index: 'os-user-prefs' });

function docId(userId: string): string {
  return `viewsurface-${userId}`;
}

type State = { docs: ReturnType<typeof perUserDoc<ViewSurface>> };
const STATE_KEY = Symbol.for('soa.prefs.viewSurface.v2');
function docs(): State['docs'] {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      docs: perUserDoc<ViewSurface>({
        read: (id) => mirror.read(id),
        docId,
        parse: (doc) => {
          const v = (doc as { viewSurface?: unknown } | null)?.viewSurface;
          return isViewSurface(v) ? v : null;
        },
      }),
    };
  }
  return g[STATE_KEY]!.docs;
}

/** The user's remembered surface, or their role's default when they have never chosen (or the store is down). */
export async function getViewSurface(userId: string, role: string): Promise<ViewSurface> {
  return (await docs().get(userId)) ?? defaultViewSurface(role);
}

/** Remember the user's choice. */
export async function setViewSurface(userId: string, surface: ViewSurface): Promise<void> {
  docs().remember(userId, surface);
  mirror.writeThrough(docId(userId), { userId, viewSurface: surface, updatedAt: new Date().toISOString() });
}

/** Test seam: forget what this process knows. */
export function __resetViewSurfaceForTests(): void {
  docs().reset();
  mirror.__reset();
}
