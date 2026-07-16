/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * ActionButton — the drop-in button for any async action that used to look silent.
 *
 * It wraps a normal `.btn` and manages the whole idle → pending → done/error dance so a
 * press ALWAYS visibly does something, and can never double-submit:
 *   • idle    — your label.
 *   • pending — a spinner replaces the label; the button is disabled.
 *   • done    — a brief "✓" flash (the label swaps to a check) then back to idle.
 *   • error   — the button settles back to idle so the user can retry; the error is
 *               surfaced via the toast (pass a shared useToast()) or your own onError.
 *
 * `onAction` returns a promise; ActionButton awaits it. Give it `successToast` and it
 * fires a success toast on resolve; give it `toast` (from useToast) so it can. Keeping
 * the visuals identical everywhere means a user learns "spinner → check = it worked"
 * once and trusts it across every tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from './Toast';

type Phase = 'idle' | 'pending' | 'done';

export default function ActionButton({
  children,
  onAction,
  className = 'btn',
  disabled = false,
  title,
  type = 'button',
  successToast,
  errorToast = true,
  onError,
  ariaLabel,
  doneMs = 1100,
}: {
  children: React.ReactNode;
  /** The async work. Resolve → success flash (+ optional toast); reject → error toast. */
  onAction: () => Promise<unknown> | unknown;
  className?: string;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  /** Message to toast on success. Omit for a silent-but-still-visible check flash. */
  successToast?: string;
  /** Toast the thrown error's message on failure (default true). */
  errorToast?: boolean;
  /** Custom failure handler; runs in addition to the error toast. */
  onError?: (err: unknown) => void;
  ariaLabel?: string;
  /** How long the ✓ flash lingers before returning to idle. */
  doneMs?: number;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const alive = useRef(true);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      alive.current = false;
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, []);

  const run = useCallback(async () => {
    if (phase === 'pending') return; // hard guard against double-submit
    setPhase('pending');
    try {
      await onAction();
      if (!alive.current) return;
      setPhase('done');
      if (successToast) toast.success(successToast);
      doneTimer.current = setTimeout(() => {
        if (alive.current) setPhase('idle');
      }, doneMs);
    } catch (err) {
      if (!alive.current) return;
      setPhase('idle');
      if (errorToast) toast.error(err instanceof Error ? err.message : 'Something went wrong');
      onError?.(err);
    }
  }, [phase, onAction, successToast, errorToast, onError, toast, doneMs]);

  return (
    <button
      type={type}
      className={className}
      onClick={run}
      disabled={disabled || phase === 'pending'}
      title={title}
      aria-label={ariaLabel}
      aria-busy={phase === 'pending'}
    >
      {phase === 'pending' ? (
        <span className="spin" />
      ) : phase === 'done' ? (
        <span className="ab-done" aria-hidden>
          ✓
        </span>
      ) : (
        children
      )}
    </button>
  );
}
