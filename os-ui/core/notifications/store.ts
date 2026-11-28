/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    In-app notification inbox — per-user report and alert notifications
 * USER STORY: As a user I want report and alert deliveries to land in an in-app inbox when no
 *             mailer is configured so that I still receive them.
 * ARCHITECTURE:
 *   - In-process store plus a best-effort OpenSearch mirror (`os-notifications`), same pattern as
 *     the dashboards store. Read back via `GET /api/notifications`.
 *   - Written by dashboard delivery, data-quality alerts and connection events.
 *   - Each user can read and mark only their own notifications.
 */
import { osMirror } from '@core/infra/os-mirror';

export type NotificationKind = 'report' | 'alert';

export type OsNotification = {
  id: string;
  /** The recipient user id (owner of the inbox). */
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
};

type NotifState = { items: OsNotification[]; hydration: Promise<void> | null };
const KEY = Symbol.for('soa.notifications.store');
function notifState(): NotifState {
  const g = globalThis as unknown as Record<symbol, NotifState | undefined>;
  if (!g[KEY]) g[KEY] = { items: [], hydration: null };
  return g[KEY]!;
}

const mirror = osMirror({
  index: 'os-notifications',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        userId: { type: 'keyword' },
        kind: { type: 'keyword' },
        title: { type: 'text' },
        body: { type: 'text' },
        createdAt: { type: 'date' },
        read: { type: 'boolean' },
      },
    },
  },
});

export async function ensureHydrated(): Promise<void> {
  const s = notifState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = notifState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as OsNotification[]) {
    if (rec && rec.id && !s.items.find((n) => n.id === rec.id)) s.items.push(rec);
  }
}

/**
 * A notification id. os-ui and os-ui-worker both add notifications, each with its own counter
 * starting at 0, so time + counter alone collided across the two processes in the same
 * millisecond — and the second mirrored doc overwrote the first. A random part (Web Crypto, as
 * the data store uses) keeps them apart; time first keeps the ids roughly sortable.
 */
function newNotificationId(): string {
  return `ntf_${Date.now().toString(36)}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Persist a notification for a user. Returns the stored record. */
export function addNotification(input: { userId: string; kind: NotificationKind; title: string; body: string }): OsNotification {
  const rec: OsNotification = {
    id: newNotificationId(),
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    createdAt: Date.now(),
    read: false,
  };
  notifState().items.push(rec);
  mirror.writeThrough(rec.id, rec);
  return rec;
}

/**
 * The user's notifications, newest first. Two notifications added in the same millisecond tie on
 * `createdAt`; the later-added one (higher position in the store) comes first, so "newest first"
 * holds on a fast machine too instead of falling back to the stable sort's oldest-first order.
 */
export function listNotifications(userId: string): OsNotification[] {
  const items = notifState().items;
  return items
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.userId === userId)
    .sort((a, b) => b.n.createdAt - a.n.createdAt || b.i - a.i)
    .map(({ n }) => n);
}

/** How many of the user's notifications are unread. */
export function unreadCount(userId: string): number {
  return notifState().items.filter((n) => n.userId === userId && !n.read).length;
}

/**
 * Mark notifications read for a user. Pass `ids` to mark a specific subset, or omit to mark
 * ALL of the user's notifications read. Returns how many transitioned unread → read. Only
 * the owner's own rows are touched (a caller can never mark another user's inbox).
 */
export function markRead(userId: string, ids?: string[]): number {
  const idSet = ids ? new Set(ids) : null;
  let changed = 0;
  for (const n of notifState().items) {
    if (n.userId !== userId || n.read) continue;
    if (idSet && !idSet.has(n.id)) continue;
    n.read = true;
    changed++;
    mirror.writeThrough(n.id, n);
  }
  return changed;
}

export function __resetNotifications(): void {
  const s = notifState();
  s.items = [];
  s.hydration = null;
  mirror.__reset();
}
