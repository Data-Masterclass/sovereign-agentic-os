/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    The Studio | Run surface choice — the CLIENT-SAFE half
 * USER STORY: As a builder I want the OS to remember that I work in Studio, and as someone who
 *             only consumes what the company runs I want to land in Run — once, not on every
 *             page, and without a setting to hunt for.
 * ARCHITECTURE:
 *   - Import-free (no server-only, no Next, no React) so the header toggle, the shared tile
 *     hook and the server store share one source of truth and the rules are unit-testable.
 *   - The DEFAULT is the only interesting rule, and it is deliberately boring: everyone who can
 *     author lands in Studio. The role ladder has no viewer/consumer role today, so "consumers
 *     default to Run" is not expressible yet — deviation V-6 rather than a guess that pretends
 *     some role is a consumer.
 */

import { VIEW_SURFACES, isViewSurface, visibleOnSurface, type Lifecycle, type ViewSurface } from '@core/kernel/object-lifecycle';

export { VIEW_SURFACES, isViewSurface };
export type { ViewSurface };

/**
 * Where a user lands before they have ever toggled. Every role in today's ladder (creator,
 * builder, domain_admin, admin) can author, so every role starts in Studio; a role that could
 * only consume would start in Run.
 */
export function defaultViewSurface(role: string): ViewSurface {
  const authoring = ['creator', 'builder', 'domain_admin', 'admin'];
  return authoring.includes(String(role)) ? 'studio' : 'run';
}

/** Parse a stored or posted value, falling back to the role's default. Never throws. */
export function parseViewSurface(value: unknown, role: string): ViewSurface {
  return isViewSurface(value) ? value : defaultViewSurface(role);
}

/**
 * THE tile-list rule, in one place: Studio shows everything (drafts, what is being tested, and
 * live objects for editing); Run shows only what is live. Every tab's tile list goes through
 * the shared hook, which goes through this.
 */
export function tilesForSurface<T>(
  items: readonly T[],
  surface: ViewSurface,
  lifecycleOfItem: (item: T) => Lifecycle,
): T[] {
  if (surface === 'studio') return [...(items ?? [])];
  return (items ?? []).filter((i) => visibleOnSurface(lifecycleOfItem(i), surface));
}

/** The one-line explanation under the toggle, so nobody has to guess what it does. */
export const VIEW_SURFACE_HINTS: Record<ViewSurface, string> = {
  studio: 'Everything you can work on, including what is already running.',
  run: 'Only what the OS runs right now.',
};
