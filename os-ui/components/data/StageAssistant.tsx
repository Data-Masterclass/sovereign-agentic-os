/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/** The Define-stage draft shape the assistant returns (docs + quality rules from the schema). */
export type DefineDraft = {
  description?: string;
  columns?: Array<{ name: string; description: string }>;
  checks?: Array<{ rule: string; column: string; values?: string[]; min?: number; max?: number }>;
};

/**
 * The per-stage Data assistant slot — a calm, collapsible helper mounted in StageShell's
 * `assistant` render prop. It POSTs the stage + context to
 * /api/data/datasets/[id]/assistant (the ONE governed model) and renders the suggestion.
 * Honest about failure: a 503 (no model configured) or 402 (cost cap) surfaces as the
 * route's own message, never a fake answer.
 *
 * Two shapes: prose stages (Ingest/Refine/Publish) render the returned `text`; Define
 * consumes the returned `draft` via `onDraft` (so the parent can pre-fill the docs +
 * quality-rule editor) and shows a short confirmation instead of prose.
 */
export default function StageAssistant({
  datasetId,
  label,
  cta,
  stage,
  payload,
  onDraft,
  disabled,
}: {
  datasetId: string;
  /** One-line "what this helper does here". */
  label: string;
  /** The action button text, e.g. "Draft docs & rules". */
  cta: string;
  stage: 'define' | 'ingest' | 'harmonize' | 'validate' | 'publish';
  /** Extra fields merged into the request body (name/prompt/columns/reason/measures). */
  payload: () => Record<string, unknown>;
  /** Define only — receive the drafted docs + quality rules. */
  onDraft?: (draft: DefineDraft) => void;
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
      const res = await fetch(`/api/data/datasets/${datasetId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, ...payload() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      if (onDraft && (data as { draft?: unknown }).draft && typeof (data as { draft: unknown }).draft === 'object') {
        const draft = (data as { draft: DefineDraft }).draft;
        onDraft(draft);
        const cols = draft.columns?.length ?? 0;
        const checks = draft.checks?.length ?? 0;
        setText(`Drafted a description, ${cols} column note${cols === 1 ? '' : 's'} and ${checks} quality rule${checks === 1 ? '' : 's'} — review them below.`);
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
