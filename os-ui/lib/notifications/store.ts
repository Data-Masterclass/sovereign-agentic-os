/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { osMirror } from '../infra/os-mirror.ts';

/**
 * A small, principal-scoped in-app notification inbox (same in-memory + durable-mirror
 * discipline as the dashboards store). It is the honest FALLBACK for report/alert
 * delivery when no mailer is configured: instead of a silent no-op, the send lands here
 * as a real record the recipient can read back (GET /api/notifications).
 */

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

let seq = 0;

/** Persist a notification for a user. Returns the stored record. */
export function addNotification(input: { userId: string; kind: NotificationKind; title: string; body: string }): OsNotification {
  const rec: OsNotification = {
    id: `ntf_${Date.now().toString(36)}_${++seq}`,
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

/** The user's notifications, newest first. */
export function listNotifications(userId: string): OsNotification[] {
  return notifState().items.filter((n) => n.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}

export function __resetNotifications(): void {
  const s = notifState();
  s.items = [];
  s.hydration = null;
  seq = 0;
  mirror.__reset();
}
