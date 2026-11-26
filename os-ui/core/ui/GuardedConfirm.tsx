/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    GuardedConfirm — a typed-confirmation modal for destructive platform-admin actions
 * USER STORY: As a platform admin I want to type an exact phrase before a restore or a component
 *             disable so that I never trigger one by accident.
 * ARCHITECTURE:
 *   - Used by `tabs/admin/ui/BackupsRestore.tsx` and `tabs/admin/ui/OverviewHealth.tsx`.
 *   - The UI mirror of the server check in `tabs/admin/lib/guard.ts`; the server still verifies
 *     the phrase, this modal only makes it explicit.
 *   - Escape, backdrop click and Cancel dismiss it, except while the action is in flight.
 * I18N:       converted (wave 1) — built-in texts from `common.confirm.*` / `common.actions.*`; title, detail and phrase are the caller's.
 */
'use client';

import { useEffect, useState } from 'react';
import { onEscape, isBackdropClick } from '@core/kernel/overlay-dismiss';
import { useTranslations } from '@core/i18n/client';

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
  confirmLabel,
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
  const t = useTranslations('common');
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
          {t.rich('confirm.guarded', { phrase, code: (chunks) => <code>{chunks}</code> })}
        </div>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phrase}
          style={{ width: '100%' }}
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>{t('actions.cancel')}</button>
          <button className="btn" onClick={onConfirm} disabled={!ok || busy}>
            {busy ? <span className="spin" /> : (confirmLabel ?? t('actions.confirm'))}
          </button>
        </div>
      </div>
    </div>
  );
}
