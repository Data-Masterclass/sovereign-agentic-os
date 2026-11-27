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
import { useTranslations } from '@core/i18n/client';
import { friendlyTrinoError } from '@tabs/data/lib/friendly-error';

export type BuildResult = {
  ok: boolean;
  /** What was built — 'Silver' | 'Gold' | 'Gold (pass-through)' | 'Gold (served for metrics)' |
   *  'Transformation'. A known value renders in the user's language (WHAT_KEYS); any other passes through. */
  what: string;
  /** Success: what is now live/queryable — the caller passes it already translated.
   *  Failure: the honest error, verbatim. */
  detail: string;
  /** True when the build ran as the offline preview (cluster unreachable). */
  offline?: boolean;
  /** The next stage's title — renders the big "Continue to … →" confirmation. */
  nextTitle?: string;
};

/** The catalog key for each `what` the build stages send — translated at render time. */
const WHAT_KEYS = {
  Silver: 'buildResult.what.silver',
  Gold: 'buildResult.what.gold',
  'Gold (pass-through)': 'buildResult.what.goldPassThrough',
  'Gold (served for metrics)': 'buildResult.what.goldForMetrics',
  Transformation: 'buildResult.what.transformation',
} as const;

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
  const t = useTranslations('data');
  const primaryRef = useRef<HTMLButtonElement>(null);
  const whatKey = WHAT_KEYS[result.what as keyof typeof WHAT_KEYS];
  const what = whatKey ? t(whatKey) : result.what;
  // A FAILURE detail may arrive as a raw Trino string — lead with the plain sentence,
  // keep the raw (query_id and all) behind "Show details". A success detail is our own
  // copy and passes through untouched.
  const { friendly, raw, message } = result.ok
    ? { friendly: result.detail, raw: result.detail, message: undefined }
    : friendlyTrinoError(result.detail);
  const hasDetail = !result.ok && raw.trim() !== friendly.trim();
  const friendlyText = message ? t(message.key, message.args) : friendly;
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
        aria-label={result.ok ? t('buildResult.ariaSucceeded', { what }) : t('buildResult.ariaFailed', { what })}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, fontSize: 20 }}>
          {result.ok ? t('buildResult.built', { what }) : t('buildResult.failed', { what })}
        </h3>
        <p className={result.ok ? 'muted' : 'error'} style={{ fontSize: 15, lineHeight: 1.5 }}>
          {friendlyText}
        </p>
        {hasDetail ? (
          <details style={{ marginTop: -4, marginBottom: 4 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>{t('buildResult.showDetails')}</summary>
            <pre className="mono" style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{raw}</pre>
          </details>
        ) : null}
        {result.offline ? (
          <p className="hint">
            {t('buildResult.offline')}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          {result.ok && result.nextTitle ? (
            <>
              <button className="btn ghost" onClick={onClose}>{t('buildResult.stay')}</button>
              <button ref={primaryRef} className="btn primary" onClick={onContinue}>
                {t('buildResult.continue', { next: result.nextTitle })}
              </button>
            </>
          ) : (
            <button ref={primaryRef} className="btn" onClick={onClose}>{t('buildResult.close')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
