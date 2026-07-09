/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * ConfirmDialog — the ONE confirmation popup for the whole OS. A real, focus-
 * trapped modal (ESC / backdrop cancel, keyboard-accessible) that renders the
 * lifecycle copy from lib/lifecycle.ts identically everywhere. It reuses the
 * existing .pa-confirm-backdrop / .pa-confirm brand chrome so it matches the
 * app's visual language rather than looking like a generic browser dialog.
 *
 * Trigger it imperatively via useConfirm() — any tab wraps its subtree in
 * <ConfirmProvider> and calls `const confirm = useConfirm()` then
 * `if (await confirm(deleteCopy('dataset', name, visibility))) { …do it… }`.
 * The promise resolves true on confirm, false on cancel/ESC/backdrop.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ConfirmCopy } from '@/lib/core/lifecycle';
import { phraseSatisfied } from '@/lib/core/lifecycle';

type Pending = ConfirmCopy & { resolve: (ok: boolean) => void };

const ConfirmCtx = createContext<((copy: ConfirmCopy) => Promise<boolean>) | null>(null);

/** Wrap any surface that uses the lifecycle controls in this once (near its root). */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (copy: ConfirmCopy) => new Promise<boolean>((resolve) => setPending({ ...copy, resolve })),
    [],
  );

  const close = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending ? <Dialog copy={pending} onClose={close} /> : null}
    </ConfirmCtx.Provider>
  );
}

/** Imperative confirm — resolves true if the user confirms, false otherwise. */
export function useConfirm(): (copy: ConfirmCopy) => Promise<boolean> {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm must be used within a <ConfirmProvider>');
  return ctx;
}

function Dialog({ copy, onClose }: { copy: ConfirmCopy; onClose: (ok: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement | HTMLButtonElement>(null);
  const gated = copy.confirmPhrase !== undefined;
  const canConfirm = phraseSatisfied(copy.confirmPhrase, typed);

  // Autofocus the first interactive control (type-to-confirm input, else the
  // confirm button) so the dialog is immediately keyboard-drivable.
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // ESC cancels; Tab is trapped inside the card so focus never escapes to the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="pa-confirm-backdrop"
      onClick={() => onClose(false)}
      role="presentation"
    >
      <div
        ref={cardRef}
        className="pa-confirm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <h3 id="confirm-title">{copy.title}</h3>
        <div id="confirm-body" className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          {copy.body}
        </div>

        {gated ? (
          <>
            <div className="danger-note">
              Type <code>{copy.confirmPhrase}</code> to confirm.
            </div>
            <input
              ref={firstFieldRef as React.RefObject<HTMLInputElement>}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={copy.confirmPhrase}
              aria-label="Type the name to confirm"
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) onClose(true);
              }}
            />
          </>
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button
            ref={gated ? undefined : (firstFieldRef as React.RefObject<HTMLButtonElement>)}
            className="btn"
            style={copy.danger ? { background: 'var(--danger)', color: '#fff', boxShadow: 'none' } : undefined}
            disabled={!canConfirm}
            onClick={() => onClose(true)}
          >
            {copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Dialog;
