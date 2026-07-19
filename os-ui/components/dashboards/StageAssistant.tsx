/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * The per-stage Dashboards assistant slot — a calm, collapsible helper mounted in
 * StageShell's `assistant` render prop. It POSTs the stage + context to
 * /api/dashboards/assistant (the ONE governed model) and renders the suggestion. Honest
 * about failure: a 503 (no model configured) or 402 (cost cap) surfaces as the route's
 * own message, never a fake answer.
 *
 * Two shapes: prose stages render the returned `text`; Design consumes the returned
 * `charts` array via `onCharts` (so the parent can drop them into the Design stage) and
 * shows a short confirmation instead of prose.
 */
export default function StageAssistant({
  label,
  cta,
  stage,
  payload,
  onCharts,
  disabled,
}: {
  /** One-line "what this helper does here". */
  label: string;
  /** The action button text, e.g. "Suggest a view". */
  cta: string;
  stage: 'define' | 'design' | 'build' | 'view' | 'govern';
  /** Extra fields merged into the request body (prompt/view/members/reason/rls/name/tier). */
  payload: () => Record<string, unknown>;
  /** Design only — receive the suggested chart array. */
  onCharts?: (charts: Array<{ name: string; vizType: string; metric: string }>) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ask = async () => {
    setBusy(true);
    setError('');
    setText('');
    try {
      const res = await fetch('/api/dashboards/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, ...payload() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      if (onCharts && Array.isArray((data as { charts?: unknown }).charts)) {
        const charts = (data as { charts: Array<{ name: string; vizType: string; metric: string }> }).charts;
        onCharts(charts);
        setText(`Suggested ${charts.length} chart${charts.length === 1 ? '' : 's'} — review them below.`);
      } else {
        setText((data as { text?: string }).text ?? '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="passthrough-note" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div>
          <span style={{ fontWeight: 600 }}>Assistant</span>
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
