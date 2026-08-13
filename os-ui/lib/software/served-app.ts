/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * served-app — the PURE serve-target decision for the same-origin `/apps/<slug>` route
 * (AppSpec Phase 3). No DOM, no I/O: given a loaded `App`, decide what the OS route should
 * render. Factored out so the routing rule is unit-tested independently of the React page.
 *
 * Three outcomes:
 *   • 'spec'           — `serveMode === 'spec'` AND `spec` has ≥1 tab: the OS renders the
 *                        declarative AppSpec same-origin (no pod). The common case.
 *   • 'image-elsewhere'— an image/runtime app: it is served at its OWN subdomain URL, not by
 *                        this route. The page shows an honest "open it at its URL" notice.
 *   • 'none'           — declared 'spec' but there is no usable spec (absent or empty
 *                        tabs): an honest "nothing to render yet" — never a blank screen.
 *
 * The rule reuses `serveModeOf` (the nil-safe coercion) so a legacy record with no `serveMode`
 * lands on 'image-elsewhere' exactly like an explicit image app.
 */
import { serveModeOf, type App } from '@/lib/software/apps';

export type ServeTargetKind = 'spec' | 'image-elsewhere' | 'none';
export type ServeTarget = { kind: ServeTargetKind };

/** Decide how the same-origin `/apps/<slug>` route should serve this app. Pure. */
export function resolveServeTarget(app: Pick<App, 'serveMode' | 'spec'>): ServeTarget {
  if (serveModeOf(app) !== 'spec') return { kind: 'image-elsewhere' };
  const hasSpec = !!app.spec && Array.isArray(app.spec.tabs) && app.spec.tabs.length > 0;
  return { kind: hasSpec ? 'spec' : 'none' };
}
