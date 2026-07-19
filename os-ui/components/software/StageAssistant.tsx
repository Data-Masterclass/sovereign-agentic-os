/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { SwStageId } from './stages';

/**
 * The per-stage Software assistant slot — a calm, collapsible helper mounted in
 * StageShell's `assistant` render prop. It POSTs the stage + an optional free-text detail
 * to /api/apps/{id}/assistant (the ONE governed model, app-scoped) and renders the returned
 * prose. Honest about failure: a 503 (no model configured) or 402 (cost cap) surfaces as
 * the route's own message, never a fake answer.
 *
 * Same visual grammar as the Dashboards StageAssistant (passthrough-note card), so the two
 * tabs' guided helpers look identical. It only SUGGESTS — the delivery team and build chat
 * are the agents that write code; the buttons here never mutate the app.
 */
export default function StageAssistant({
  appId,
  stage,
  label,
  cta,
  detail,
  disabled,
}: {
  /** The app the assistant reads (loaded under the caller's governance server-side). */
  appId: string;
  stage: SwStageId;
  /** One-line "what this helper does here". */
  label: string;
  /** The action button text, e.g. "Suggest a surface". */
  cta: string;
  /** Optional extra free-text context for the model (a paste of the error/finding). */
  detail?: () => string;
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
      const res = await fetch(`/api/apps/${appId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, detail: detail ? detail() : '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      setText((data as { text?: string }).text ?? '');
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
