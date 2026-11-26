/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NotificationBell — the in-app inbox for alerts, data-quality alerts and reports
 * USER STORY: As a recipient of alerts and scheduled reports I want a bell with an unread count
 *             and a list of my notifications so that I see what was delivered to me.
 * ARCHITECTURE:
 *   - Rendered by `core/ui/Sidebar.tsx`. Reads `GET /api/notifications` on mount, every 60 s and
 *     on open. There are no websockets.
 *   - Opening the panel marks everything read (`PATCH /api/notifications`) and clears the badge
 *     optimistically. A failed fetch is ignored so the shell never crashes.
 *   - The badge shows only a real unread count. The panel shows exactly what the server
 *     returns, with a plain empty state.
 * I18N:       converted (wave 1) — strings from the `shell` namespace (`shell.notifications.*`).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from '@core/i18n/client';

type Notification = {
  id: string;
  kind: 'report' | 'alert';
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
};

const POLL_MS = 60_000;

type ShellT = ReturnType<typeof useTranslations<'shell'>>;

/** "just now" / "5m ago" / "3h ago" / "2d ago" — a quiet relative time, in the user's language. */
function relativeTime(ms: number, t: ShellT): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return t('notifications.justNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('notifications.minutesAgo', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('notifications.hoursAgo', { count: h });
  const d = Math.round(h / 24);
  return t('notifications.daysAgo', { count: d });
}

export default function NotificationBell() {
  const t = useTranslations('shell');
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return; // signed-out / transient — stay quiet, never crash the shell
      const data = await res.json();
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setUnread(typeof data.unread === 'number' ? data.unread : 0);
    } catch {
      /* non-blocking */
    }
  }, []);

  // Light poll + initial load.
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await load(); // refetch on open
      if (unread > 0) {
        // Mark all read; optimistically clear the badge.
        setUnread(0);
        setItems((prev) => prev.map((n) => ({ ...n, read: true })));
        try { await fetch('/api/notifications', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* non-blocking */ }
      }
    }
  };

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className="notif-bell"
        aria-label={unread > 0 ? t('notifications.labelUnread', { count: unread }) : t('notifications.label')}
        aria-expanded={open}
        onClick={toggle}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 ? <span className="notif-badge">{unread > 9 ? '9+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="notif-panel" role="dialog" aria-label={t('notifications.label')}>
          <div className="notif-panel-head">{t('notifications.label')}</div>
          {items.length === 0 ? (
            <div className="notif-empty">{t('notifications.empty')}</div>
          ) : (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id} className={`notif-item${n.read ? '' : ' unread'}`}>
                  <div className="notif-item-top">
                    <span className="notif-item-title">{n.title}</span>
                    <span className="notif-item-time">{relativeTime(n.createdAt, t)}</span>
                  </div>
                  {n.body ? <div className="notif-item-body">{n.body}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
