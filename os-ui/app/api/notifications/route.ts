/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import type { CurrentUser } from '@/lib/core/auth';
import { withRoute } from '@/lib/core/route-server';
import { requirePrincipal } from '@/lib/data/server';
import { ensureHydrated, listNotifications, markRead, unreadCount } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user's in-app notifications (newest first) + the unread count. This is the
 * ONE delivery surface for alerts, DQ alerts and scheduled reports — a "send" is never a
 * silent no-op: the recipient reads it back here (rendered by the notification bell).
 */
export const GET = withRoute(async ({ user }) => {
  return NextResponse.json({ notifications: listNotifications(user.id), unread: unreadCount(user.id) });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated });

/**
 * Mark notifications read. Body `{ ids?: string[] }` — a specific subset, or omit to mark
 * ALL of the caller's notifications read. Only the caller's own inbox is ever touched.
 */
export const PATCH = withRoute<Record<string, string>, { ids?: string[] }>(async ({ user, body }) => {
  const marked = markRead(user.id, Array.isArray(body?.ids) ? body.ids : undefined);
  return NextResponse.json({ marked, unread: unreadCount(user.id) });
}, { gate: requirePrincipal as () => Promise<CurrentUser>, hydrate: ensureHydrated, parse: true });
