/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * Toast — the ONE transient "that did something" confirmation for the whole OS.
 *
 * A calm, self-dismissing pill that slides in bottom-right after a button press so an
 * action never looks like a silent no-op. It is the sibling of <ConfirmDialog>: same
 * imperative shape (wrap the app once, call a hook), but passive — it never blocks.
 *
 * Mounted once in the root layout, so every tab can `const toast = useToast()` and
 * `toast.success('Added to your team')`. The queue rules (dedup, cap, dwell) live in
 * the pure, unit-tested lib/core/toast.ts; this file is only the React + DOM shell.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { pushToast, dismissToast, type Toast, type ToastAction, type ToastInput, type ToastTone } from '@/lib/core/toast';

type ToastApi = {
  /** Low-level: push any toast. */
  show: (input: ToastInput) => void;
  /** Sugar for the three tones — what tabs actually call. */
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

/** Wrap the app once (root layout). Renders the toast viewport as a fixed overlay. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<Toast[]>([]);
  // Track live auto-dismiss timers so we can clear them on unmount / manual close.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setQueue((q) => dismissToast(q, id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      setQueue((q) => {
        const next = pushToast(q, input);
        // A newly-added toast is the last element; arm its auto-dismiss timer once.
        const added = next[next.length - 1];
        if (added && added !== q[q.length - 1] && added.duration > 0 && !timers.current.has(added.id)) {
          timers.current.set(
            added.id,
            setTimeout(() => dismiss(added.id), added.duration),
          );
        }
        return next;
      });
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, duration) => show({ tone: 'success', message, duration }),
      error: (message, duration) => show({ tone: 'error', message, duration }),
      info: (message, duration) => show({ tone: 'info', message, duration }),
    }),
    [show],
  );

  // Clear every pending timer if the provider ever unmounts.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications" aria-live="polite">
        {queue.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * useToast — imperative feedback. Safe to call outside a provider: it degrades to a
 * no-op so a component that happens to render without the root layout (tests, isolated
 * previews) never throws. In the app the provider is always mounted.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  return ctx ?? NOOP;
}

const NOOP: ToastApi = {
  show: () => {},
  success: () => {},
  error: () => {},
  info: () => {},
};

const ICON: Record<ToastTone, string> = { success: '✓', error: '!', info: 'i' };

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const actions = toast.actions ?? [];
  return (
    <div className={`toast toast-${toast.tone}${actions.length ? ' toast-actionable' : ''}`} role="status">
      <div className="toast-body">
        <span className="toast-icon" aria-hidden>
          {ICON[toast.tone]}
        </span>
        <span className="toast-msg">{toast.message}</span>
        <button type="button" className="toast-close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      </div>
      {actions.length > 0 && (
        <div className="toast-actions">
          {actions.map((a, i) => (
            <ToastActionButton key={i} action={a} primary={i === 0} onDone={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One action button inside a toast. A plain `href` navigates (client push) and
 * dismisses the toast. An async `onClick` marked `busy` gets the ActionButton
 * dance — spinner while pending, a brief ✓, then it closes the toast on success.
 */
function ToastActionButton({
  action,
  primary,
  onDone,
}: {
  action: ToastAction;
  primary: boolean;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done'>('idle');
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const cls = `btn sm${primary ? '' : ' ghost'}`;

  const run = useCallback(async () => {
    if (phase === 'pending') return;
    if (action.href) {
      // Full-page-safe: use a hard nav only if the router isn't handy. We keep it
      // simple and just navigate the location — the Policies tab is a top-level route.
      window.location.assign(action.href);
      onDone();
      return;
    }
    if (!action.onClick) return;
    if (!action.busy) {
      await action.onClick();
      onDone();
      return;
    }
    setPhase('pending');
    try {
      await action.onClick();
      if (!alive.current) return;
      setPhase('done');
      setTimeout(() => {
        if (alive.current) onDone();
      }, 900);
    } catch {
      if (alive.current) setPhase('idle');
      // The onClick owns its own error toast; we just settle back to idle.
    }
  }, [action, phase, onDone]);

  return (
    <button
      type="button"
      className={cls}
      onClick={run}
      disabled={phase === 'pending'}
      aria-busy={phase === 'pending'}
    >
      {phase === 'pending' ? (
        <span className="spin" />
      ) : phase === 'done' ? (
        <span className="ab-done" aria-hidden>
          ✓
        </span>
      ) : (
        action.label
      )}
    </button>
  );
}

export default ToastProvider;
