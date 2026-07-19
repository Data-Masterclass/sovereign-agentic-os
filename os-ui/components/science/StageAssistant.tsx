/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { TaskType } from './shared';

/** The strict Define suggestion the assistant returns (client validates before applying). */
export type ModelDefinition = { taskType?: TaskType; targetColumn?: string; features?: string[] };

/**
 * The per-stage Science assistant slot — a calm, collapsible helper mounted in
 * StageShell's `assistant` render prop (mirrors components/dashboards/StageAssistant).
 * It POSTs the stage + context to /api/science/assistant (the ONE governed model) and
 * renders the suggestion. Honest about failure: a 503 (no model configured) or 402 (cost
 * cap) surfaces as the route's own message, never a fake answer.
 *
 * Two shapes: prose stages render the returned `text`; Define consumes the returned
 * `definition` object via `onDefinition` (so the parent can pre-fill the Define form) and
 * shows a short confirmation instead of prose.
 */
export default function StageAssistant({
  label,
  cta,
  stage,
  payload,
  onDefinition,
  disabled,
}: {
  /** One-line "what this helper does here". */
  label: string;
  /** The action button text, e.g. "Suggest a definition". */
  cta: string;
  stage: 'define' | 'train' | 'deploy' | 'predict' | 'monitor';
  /** Extra fields merged into the request body (prompt/columns/reason/score/band/metric/drift). */
  payload: () => Record<string, unknown>;
  /** Define only — receive the suggested model definition. */
  onDefinition?: (def: ModelDefinition) => void;
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
      const res = await fetch('/api/science/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, ...payload() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      if (onDefinition && (data as { definition?: unknown }).definition) {
        onDefinition((data as { definition: ModelDefinition }).definition);
        setText('Applied a suggested task, target and features above — review, then create the draft.');
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
