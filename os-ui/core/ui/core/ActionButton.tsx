/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    ActionButton — a `.btn` for async actions with idle → pending → done/error states
 * USER STORY: As a user I want every button press on an async action to show a spinner and then a
 *             check (or an error toast) so that I can tell it worked and cannot submit it twice.
 * ARCHITECTURE:
 *   - Shared core UI. `onAction` returns a promise that the button awaits. While pending, a
 *     spinner replaces the label and the button is disabled. A second press during pending is
 *     ignored.
 *   - On resolve, a "✓" shows for `doneMs`, plus a success toast if `successToast` is set. On
 *     reject, the button goes back to idle and the error message is toasted through `useToast()`
 *     from `@core/ui/core/Toast`, and `onError` runs if given.
 *   - The same visuals in every tab, so "spinner → check" means the same thing everywhere.
 * I18N:       converted (wave 1) — the fallback error from `common.errors.generic`; labels are the caller's children.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@core/ui/core/Toast';
import { useTranslations } from '@core/i18n/client';

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
  const t = useTranslations('common');
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
      if (errorToast) toast.error(err instanceof Error ? err.message : t('errors.generic'));
      onError?.(err);
    }
  }, [phase, onAction, successToast, errorToast, onError, toast, doneMs, t]);

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
