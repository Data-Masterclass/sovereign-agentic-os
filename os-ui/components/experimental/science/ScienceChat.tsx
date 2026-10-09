/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import Markdown from '@/components/Markdown';
import type { SciStageId } from './stages';
import { TASK_LABEL, type TaskType } from './shared';

/**
 * ScienceChat — ONE persistent, governed, multi-turn assistant mounted across all three
 * Science stages (Design · Launch · Monitor) in StageShell's assistant slot. It replaces the
 * five one-shot StageAssistant buttons with a real conversation, and follows the OS suggestion
 * -card pattern (components/core/StageAssistantChat.tsx, the .sac-* skin): the assistant only
 * PROPOSES; every mutation runs through the host's governed callback on an explicit Apply click.
 *
 * The thread is kept locally and POSTed whole to /api/science/assistant (multi-turn), which
 * grounds each turn in the model's real state, the caller's visible datasets + the selected
 * dataset's real column profile, and the honest capability statement. Suggestions are validated
 * SERVER-SIDE against the real feed before an Apply card renders (a hallucinated dataset/column
 * is refused with a reason). Honest failure: 503 (no model) / 402 (cost cap) surface plainly.
 */

/** The Design suggestion the assistant returns (validated server-side before it reaches here). */
export type ModelDefinition = {
  /** The governed dataset id the suggestion names (already validated visible to the caller). */
  datasetId?: string;
  /** Its FQN (what create stores as the source). */
  datasetFqn?: string;
  /** Its display name (shown on the card). */
  datasetName?: string;
  taskType?: TaskType;
  targetColumn?: string;
  features?: string[];
  rationale?: string;
  /** True when the OS auto-detected/corrected `taskType` from the target column (dtype + content). */
  autoDetectedTask?: boolean;
  /** Human reason for the auto-detection — shown so the correction is transparent, not hidden. */
  autoDetectedReason?: string;
};

type Turn = { role: 'user' | 'assistant'; content: string };

/** The structured suggestion a turn may carry (one of, per stage). Server-validated. */
type Suggestions = {
  /** Design → a full model definition the user can Apply to create the draft. */
  definition?: ModelDefinition;
  /** Launch → "start training & launch" action card. */
  launch?: boolean;
  /** Monitor → "score this example row" action card. */
  scoreExample?: boolean;
};

export default function ScienceChat({
  stage,
  modelId,
  datasetId,
  starters = [],
  onApplyDefinition,
  onApplyLaunch,
  onApplyScoreExample,
}: {
  stage: SciStageId;
  /** The current model (existing/just-created) so the server grounds in its real state. */
  modelId?: string;
  /** Design: the selected dataset id, so the server can profile its real columns for grounding. */
  datasetId?: string;
  starters?: string[];
  /** Design: adopt the suggested definition (host validates + creates through the governed route). */
  onApplyDefinition?: (def: ModelDefinition) => void;
  /** Launch: start training & launch (host POSTs the governed train route). */
  onApplyLaunch?: () => void;
  /** Monitor: focus the try-it panel to score a real example row. */
  onApplyScoreExample?: () => void;
}) {
  const [thread, setThread] = useState<Turn[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestions>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const nextThread: Turn[] = [...thread, { role: 'user', content: q }];
      setThread(nextThread);
      setInput('');
      setError('');
      setSuggestions({});
      setBusy(true);
      try {
        const res = await fetch('/api/science/assistant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, model: modelId, datasetId, messages: nextThread }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          suggestions?: Suggestions;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        setThread((t) => [...t, { role: 'assistant', content: data.message ?? '' }]);
        setSuggestions(data.suggestions ?? {});
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [stage, modelId, datasetId, thread, busy],
  );

  const def = suggestions.definition;
  const hasCard =
    (!!def && stage === 'design' && !!onApplyDefinition) ||
    (!!suggestions.launch && stage === 'launch' && !!onApplyLaunch) ||
    (!!suggestions.scoreExample && stage === 'monitor' && !!onApplyScoreExample);

  const intro =
    stage === 'design'
      ? 'Tell me what you want to predict — I’ll name a real dataset and columns you can apply in one click.'
      : stage === 'launch'
      ? 'Ask me anything about training this model, or I can start it for you.'
      : 'Ask me to interpret this model’s health, usage, or a score.';

  return (
    <div className="sac">
      <div className="sac-head">
        <span className="sac-title">Assistant</span>
        <span className="sac-intro">{intro}</span>
      </div>

      <div className="sac-thread" ref={scrollRef}>
        {thread.length === 0 && !busy ? (
          <div className="sac-empty">
            <p className="hint" style={{ margin: 0 }}>Ask the assistant, or start with an example.</p>
            {starters.length > 0 ? (
              <div className="sac-starters">
                {starters.map((s) => (
                  <button key={s} type="button" className="btn ghost sm" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {thread.map((t, i) => (
          <div key={i} className={`sac-turn sac-${t.role}`}>
            {t.role === 'assistant' ? <Markdown>{t.content || '…'}</Markdown> : <span>{t.content}</span>}
          </div>
        ))}

        {busy ? (
          <div className="sac-turn sac-assistant">
            <span className="spin" /> <span className="muted" style={{ fontSize: 12 }}>Thinking…</span>
          </div>
        ) : null}
      </div>

      {hasCard ? (
        <div className="sac-suggestions">
          {def && stage === 'design' && onApplyDefinition ? (
            <SuggestionCard label="Suggested model" applyLabel="Apply — create draft" onApply={() => onApplyDefinition(def)}>
              <ul className="sac-list">
                {def.datasetName ? <li><span className="muted">Data:</span> <strong>{def.datasetName}</strong></li> : null}
                {def.targetColumn ? <li><span className="muted">Predict:</span> <span className="mono">{def.targetColumn}</span></li> : null}
                {def.features?.length ? <li><span className="muted">From:</span> {def.features.map((f) => <span key={f} className="mono" style={{ marginRight: 6 }}>{f}</span>)}</li> : null}
                {def.taskType ? (
                  <li>
                    <span className="muted">Task:</span> <strong>{TASK_LABEL[def.taskType]}</strong>
                    {def.autoDetectedTask ? <span className="muted" style={{ fontSize: 12 }}> · auto-detected from target</span> : null}
                  </li>
                ) : null}
                {def.autoDetectedTask && def.autoDetectedReason ? <li className="muted" style={{ fontSize: 12 }}>{def.autoDetectedReason}</li> : null}
                {def.rationale ? <li className="muted" style={{ fontSize: 12 }}>{def.rationale}</li> : null}
              </ul>
            </SuggestionCard>
          ) : null}

          {suggestions.launch && stage === 'launch' && onApplyLaunch ? (
            <SuggestionCard label="Ready to launch" applyLabel="Start training & launch" onApply={onApplyLaunch}>
              <p style={{ margin: 0 }}>Train this model and put it live in one step.</p>
            </SuggestionCard>
          ) : null}

          {suggestions.scoreExample && stage === 'monitor' && onApplyScoreExample ? (
            <SuggestionCard label="Try it" applyLabel="Score an example row" onApply={onApplyScoreExample}>
              <p style={{ margin: 0 }}>Pick a real row from your data and see the model’s verdict.</p>
            </SuggestionCard>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error" style={{ margin: '8px 0 0' }}>{error}</div> : null}

      <form className="sac-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input
          type="text" value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the assistant…" disabled={busy} aria-label="Message the assistant"
        />
        <button className="btn sm" type="submit" disabled={busy || !input.trim()}>
          {busy ? <span className="spin" /> : 'Send'}
        </button>
      </form>

      <style jsx>{`
        .sac { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 12px 14px; margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
        .sac-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .sac-title { font-weight: 600; }
        .sac-intro { color: var(--text-muted); font-size: 12.5px; }
        .sac-thread { display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow-y: auto; padding-right: 2px; }
        .sac-empty { padding: 8px 2px; display: flex; flex-direction: column; gap: 10px; }
        .sac-starters { display: flex; flex-wrap: wrap; gap: 6px; }
        .sac-turn { font-size: 13.5px; line-height: 1.55; max-width: 100%; }
        .sac-user { align-self: flex-end; background: var(--gold-soft); border: 1px solid var(--gold-line); color: var(--text); border-radius: 12px 12px 4px 12px; padding: 7px 11px; max-width: 85%; }
        .sac-assistant { align-self: flex-start; background: var(--tile, var(--bg-elevated, var(--panel))); border: 1px solid var(--border); border-radius: 12px 12px 12px 4px; padding: 8px 12px; max-width: 92%; }
        .sac-suggestions { display: flex; flex-direction: column; gap: 8px; }
        .sac-list { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
        .sac-input { display: flex; gap: 8px; align-items: center; }
        .sac-input input { flex: 1; }
      `}</style>
    </div>
  );
}

function SuggestionCard({
  label, applyLabel, onApply, children,
}: {
  label: string; applyLabel: string; onApply: () => void; children: React.ReactNode;
}) {
  const [applied, setApplied] = useState(false);
  return (
    <div className="sac-card">
      <div className="sac-card-head">
        <span className="sac-card-label">{label}</span>
        <button type="button" className="btn sm" disabled={applied} onClick={() => { onApply(); setApplied(true); }}>
          {applied ? 'Applied ✓' : applyLabel}
        </button>
      </div>
      <div className="sac-card-body">{children}</div>
      <style jsx>{`
        .sac-card { border: 1px solid var(--gold-line); background: var(--gold-soft); border-radius: 8px; padding: 10px 12px; }
        .sac-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .sac-card-label { font-weight: 600; font-size: 12.5px; }
        .sac-card-body { margin-top: 6px; font-size: 13px; }
      `}</style>
    </div>
  );
}
