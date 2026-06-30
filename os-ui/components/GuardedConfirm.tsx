/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';

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
  if (!open) return null;
  const ok = typed.trim().toLowerCase().replace(/\s+/g, ' ') === phrase;
  return (
    <div className="pa-confirm-backdrop" onClick={onCancel}>
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
