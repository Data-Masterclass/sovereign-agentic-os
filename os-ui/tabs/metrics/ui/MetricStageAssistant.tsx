/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Per-stage metric assistant — a collapsible helper inside the metric builder
 * USER STORY: As a creator defining a metric I want an assistant that can draft the form or
 *             explain a stage so that I do not have to know the measure syntax up front.
 * ARCHITECTURE:
 *   - Client component used by `MetricBuilder`; POSTs stage + context to
 *     `/api/metrics/assistant` and renders the reply.
 *   - Define stage returns `{ form }` (partial metric payload applied via `onForm`); every other
 *     stage returns `{ text }`.
 *   - Failure is shown as the route's own message (503 = no model, 402 = cost cap).
 */
'use client';

import { useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { MetricStageId } from '@tabs/metrics/lib/stages';

type FormProposal = {
  name?: string;
  aggregation?: string;
  column?: string;
  dimensions?: string[];
  /** A proposed plain-language "what does this metric mean?" note (draft the user reviews). */
  description?: string;
};

export default function MetricStageAssistant({
  stage,
  label,
  cta,
  payload,
  onForm,
  disabled,
  compact,
}: {
  stage: MetricStageId;
  /** One-line "what this helper does here". */
  label: string;
  /** The action button text. */
  cta: string;
  /** Extra fields merged into the request body. */
  payload: () => Record<string, unknown>;
  /** Define only — receive the proposed form fields to apply into the UI. */
  onForm?: (form: FormProposal) => void;
  disabled?: boolean;
  /** Render as ONE big in-flow ✨ button (the Data-tab AiAction pattern) instead of
   *  the boxed assistant panel; `label` becomes the hover title, output shows below. */
  compact?: boolean;
}) {
  const t = useTranslations('metrics');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ask = async () => {
    setBusy(true);
    setError('');
    setText('');
    try {
      const res = await fetch('/api/metrics/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, ...payload() }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.error as string | undefined) ?? t('requestFailed', { status: String(res.status) }));

      if (stage === 'define' && onForm && data.form && typeof data.form === 'object') {
        onForm(data.form as FormProposal);
        setText(t('assistant.proposed'));
      } else {
        setText((data.text as string | undefined) ?? '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (compact) {
    return (
      <span style={{ display: 'inline-block' }}>
        <button className="btn primary" onClick={ask} disabled={busy || disabled} title={label}>
          {busy ? <span className="spin" /> : `✨ ${cta}`}
        </button>
        {error ? <div className="error" style={{ marginTop: 8 }}>{error}</div> : null}
        {text ? <p className="hint" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{text}</p> : null}
      </span>
    );
  }

  return (
    <div className="passthrough-note" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div>
          <span style={{ fontWeight: 600 }}>{t('assistant.title')}</span>
          <div className="hint" style={{ marginTop: 2 }}>{label}</div>
        </div>
        <button className="btn ghost sm" onClick={ask} disabled={busy || disabled}>
          {busy ? <span className="spin" /> : cta}
        </button>
      </div>
      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
      {text ? <p className="hint" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{text}</p> : null}
    </div>
  );
}
