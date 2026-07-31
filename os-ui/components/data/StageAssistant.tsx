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

/** The Clean-stage draft shape — a Silver cleaning proposal the RefinePanel can apply as-is. */
export type CleanDraft = {
  columns?: Array<{
    name: string;
    cast?: string;
    clean?: 'trim' | 'normalize';
    rename?: string;
    key?: boolean;
    drop?: boolean;
  }>;
  dedupe?: boolean;
};

/**
 * AiAction — a big, clear per-stage AI button built into each Data stage's natural flow
 * (top of the stage, next to its heading), replacing the old collapsible bottom
 * "Assistant" box. It POSTs the stage + context to /api/data/datasets/[id]/assistant
 * (the ONE governed model) and shows the result inline right below the button.
 * Honest about failure: a 503 (no model configured) or 402 (cost cap) surfaces as the
 * route's own message, never a fake answer.
 *
 * Two shapes: prose stages (ingest/harmonize/validate/publish) render the returned
 * `text`; draft stages (define/clean) hand the returned `draft` to `onDraft` (the
 * parent applies it into its editors) and show `successText` as a calm confirmation.
 */
export default function AiAction<Draft = unknown>({
  datasetId,
  stage,
  cta,
  payload,
  onDraft,
  successText,
  disabled,
  title,
}: {
  datasetId: string;
  stage: 'define' | 'clean' | 'ingest' | 'harmonize' | 'validate' | 'publish';
  /** The action text, e.g. "Draft documentation" — rendered big with a ✨ prefix. */
  cta: string;
  /** Extra fields merged into the request body (name/prompt/columns/reason/measures). */
  payload: () => Record<string, unknown>;
  /** Draft stages only — receive the structured draft to apply into the stage's editors. */
  onDraft?: (draft: Draft) => void;
  /** Draft stages only — the calm confirmation shown once the draft was applied. */
  successText?: string;
  disabled?: boolean;
  title?: string;
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
      const draft = (data as { draft?: unknown }).draft;
      if (onDraft && draft && typeof draft === 'object') {
        onDraft(draft as Draft);
        setText(successText ?? 'Done — review the result below.');
      } else {
        setText((data as { text?: string }).text ?? '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The status area resets the heading cascade (uppercase/letter-spacing/display font)
  // so AI prose reads calmly even when the button lives inside a section-title row.
  const statusReset = {
    marginTop: 8,
    maxWidth: 560,
    textAlign: 'left',
    textTransform: 'none',
    letterSpacing: 'normal',
    fontFamily: 'var(--font-body)',
    fontWeight: 400,
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 0 }}>
      <button className="btn primary" onClick={ask} disabled={busy || disabled} title={title}>
        {busy ? <span className="spin" /> : <>✨ {cta}</>}
      </button>
      {error ? <div className="error" style={statusReset}>{error}</div> : null}
      {text ? (
        <p className="hint" style={{ ...statusReset, marginBottom: 0, whiteSpace: 'pre-wrap' }}>{text}</p>
      ) : null}
    </div>
  );
}
