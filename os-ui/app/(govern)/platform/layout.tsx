/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';

/**
 * Platform shell — tenant-scoped, ABOVE the per-domain workspace.
 *
 * WHAT CHANGED 2026-10-30, and why it matters for security. Every Platform
 * section used to be its own sub-route, so this layout could gate by PATHNAME:
 * a non-admin was allowed at exactly `/platform` (a tile grid that filtered
 * itself) and bounced out of anything deeper. Task 7 collapsed the six sections
 * onto `/platform?section=<id>`, which DESTROYS that gate — every section now
 * lives at the one path the rule explicitly allows.
 *
 * So the section gate moved from the route to the TAB and is enforced in three
 * places, all fail-closed:
 *   1. `visibleSections(role)` in tabs/admin/lib/sections.ts builds the strip —
 *      an unresolved role gets no tabs, so nothing flashes;
 *   2. `resolveSection(?section=, role)` refuses a deep link into a tab the role
 *      may not see, so a hand-crafted `/platform?section=domains` renders nothing;
 *   3. each section component re-checks `sectionMinRole(<id>)` and keeps its
 *      hooks — and therefore its fetches — behind that check.
 * Those are unit-tested in tabs/admin/lib/sections.test.ts (the page itself is a
 * .tsx the test harness cannot import). None of it is the real boundary: every
 * /api/platform-admin/* route is adminCtx()-gated server-side.
 *
 * This layout therefore keeps only what is still route-shaped:
 *   - anon                → /signin (middleware also guards)
 *   - creator             → / (no platform surface at all)
 *   - builder+            → render `/platform`; the strip decides which tabs
 *   - non-admin, deeper   → bounce to /platform. STILL NEEDED: three real admin
 *     pages remain under /platform (mcp-apis, oauth-apps, plugins — the registry
 *     surfaces Connections links into), and the six section sub-paths are now
 *     redirect stubs. Dropping this bounce would hand a builder the shell of
 *     those three pages.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/signin');
  const isAdmin = user.role === 'admin';
  if (!isAdmin && !roleAtLeast(user.role, 'builder')) {
    // creators have no platform surface at all.
    redirect('/');
  }
  if (!isAdmin) {
    const pathname = (await headers()).get('x-pathname') ?? '';
    if (pathname !== '/platform' && pathname.startsWith('/platform')) {
      redirect('/platform');
    }
  }
  // No second navigation: the tab strip on /platform is the one admin menu, and
  // the sidebar's Platform entry is the way back up. The tile grid that used to
  // live alongside it is gone.
  return <>{children}</>;
}
