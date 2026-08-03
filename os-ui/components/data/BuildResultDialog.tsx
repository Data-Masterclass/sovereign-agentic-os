/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * BuildResultDialog — the CENTRAL outcome popup for the Data build stages. A Silver/
 * Gold build's result used to announce itself only as a small bottom-right toast that
 * was easy to miss; this is the loud, unmissable version: a centered modal (the same
 * `.pa-confirm` brand chrome the lifecycle ConfirmDialog uses) that says what happened
 * and — on success — offers the explicit "Continue to <next stage> →" step, so moving
 * on is a conscious confirmation, never a hunt for a small button. Failures show the
 * honest error big and central; the detailed build report stays inline in the panel.
 */

import { useEffect, useRef } from 'react';
import { friendlyTrinoError } from '@/lib/data/friendly-error';

export type BuildResult = {
  ok: boolean;
  /** What was built — 'Silver' | 'Gold' | 'Gold (pass-through)'. */
  what: string;
  /** Success: what is now live/queryable. Failure: the honest error, verbatim. */
  detail: string;
  /** True when the build ran as the offline preview (cluster unreachable). */
  offline?: boolean;
  /** The next stage's title — renders the big "Continue to … →" confirmation. */
  nextTitle?: string;
};

export default function BuildResultDialog({
  result,
  onContinue,
  onClose,
}: {
  result: BuildResult;
  /** The user confirmed moving on — advance the stepper to the next stage. */
  onContinue: () => void;
  /** Stay on the stage (review/explore/fix); ESC and the backdrop do the same. */
  onClose: () => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  // A FAILURE detail may arrive as a raw Trino string — lead with the plain sentence,
  // keep the raw (query_id and all) behind "Show details". A success detail is our own
  // copy and passes through untouched.
  const { friendly, raw } = result.ok
    ? { friendly: result.detail, raw: result.detail }
    : friendlyTrinoError(result.detail);
  const hasDetail = !result.ok && raw.trim() !== friendly.trim();
  useEffect(() => { primaryRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pa-confirm-backdrop" onClick={onClose} role="presentation">
      <div
        className="pa-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={`${result.what} build ${result.ok ? 'succeeded' : 'failed'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, fontSize: 20 }}>
          {result.ok ? `${result.what} built ✓` : `${result.what} build failed`}
        </h3>
        <p className={result.ok ? 'muted' : 'error'} style={{ fontSize: 15, lineHeight: 1.5 }}>
          {friendly}
        </p>
        {hasDetail ? (
          <details style={{ marginTop: -4, marginBottom: 4 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Show details</summary>
            <pre className="mono" style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{raw}</pre>
          </details>
        ) : null}
        {result.offline ? (
          <p className="hint">
            Recorded as an offline preview — no live table was written (cluster unreachable).
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          {result.ok && result.nextTitle ? (
            <>
              <button className="btn ghost" onClick={onClose}>Stay &amp; review</button>
              <button ref={primaryRef} className="btn primary" onClick={onContinue}>
                Continue to {result.nextTitle} →
              </button>
            </>
          ) : (
            <button ref={primaryRef} className="btn" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
