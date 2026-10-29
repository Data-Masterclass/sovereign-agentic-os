/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';

/**
 * Platform Admin shell — tenant-scoped, ABOVE the per-domain workspace.
 *
 * The Admin tab is now builder-visible, but only the OVERVIEW page (/platform)
 * renders a builder-safe, tile-filtered cockpit; every /platform/* SUB-page is
 * admin-only. This layout enforces that split:
 *   - anon              → /signin (middleware also guards)
 *   - builder+, overview → render (the overview page itself hides admin KPIs and
 *                          shows only the tiles the caller is authorised for)
 *   - non-admin, sub-page → redirect to /platform (the safe overview). The
 *                          section sub-nav (PlatformNav) is admin-only, so a
 *                          builder is never handed a link into a sub-page, and
 *                          each /platform-admin/* API is hard-gated by adminCtx().
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/signin');
  const isAdmin = user.role === 'admin';
  if (!isAdmin && !roleAtLeast(user.role, 'builder')) {
    // creators have no platform surface at all.
    redirect('/');
  }
  // Fail-closed sub-page guard: a non-admin may only see the /platform overview.
  // Any deeper /platform/* path (Users, Security, Models, Backups, …) bounces to
  // the overview — the sub-page never renders and its adminCtx()-gated APIs 403.
  if (!isAdmin) {
    const pathname = (await headers()).get('x-pathname') ?? '';
    if (pathname !== '/platform' && pathname.startsWith('/platform')) {
      redirect('/platform');
    }
  }
  // No section strip: the grouped tiles on /platform are the one admin menu, and
  // the sidebar's Admin entry is the way back up from a section. Two navigations
  // for the same thing is what let them drift apart in the first place.
  return <>{children}</>;
}
