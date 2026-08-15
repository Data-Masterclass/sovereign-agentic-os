/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect, useState } from 'react';
import { onEscape, isBackdropClick } from '@/lib/core/overlay-dismiss';

/**
 * Typed-confirmation modal for guarded, destructive Platform-Admin actions
 * (restore, disable a component). The confirm button stays disabled until the
 * admin types the EXACT phrase the server will verify — a UI mirror of
 * `lib/platform-admin/guard.ts`. Nothing here bypasses the server guard; it just
 * makes the intent explicit and the phrase discoverable.
 */
export default function GuardedConfirm({
  open,
  title,
  phrase,
  detail,
  confirmLabel = 'Confirm',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  phrase: string;
  detail: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  // Escape dismisses (backdrop-click + Cancel already do) — shared safety net so
  // the guarded modal can never trap the user (os-ui 0.6.139). No-ops while closed
  // or busy so an in-flight guarded action isn't abandoned mid-request.
  useEffect(() => (open && !busy ? onEscape(onCancel) : undefined), [open, busy, onCancel]);
  if (!open) return null;
  const ok = typed.trim().toLowerCase().replace(/\s+/g, ' ') === phrase;
  return (
    <div className="pa-confirm-backdrop" onClick={(e) => { if (isBackdropClick(e.target, e.currentTarget) && !busy) onCancel(); }}>
      <div className="pa-confirm" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="muted" style={{ fontSize: 13 }}>{detail}</div>
        <div className="danger-note">
          This is a guarded, audited action. Type <code>{phrase}</code> to confirm.
        </div>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phrase}
          style={{ width: '100%' }}
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn" onClick={onConfirm} disabled={!ok || busy}>
            {busy ? <span className="spin" /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
