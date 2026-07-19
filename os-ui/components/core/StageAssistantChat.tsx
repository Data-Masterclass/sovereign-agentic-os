/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import Markdown from '@/components/Markdown';
import type {
  StageSuggestions,
  SuggestedGrant,
  SuggestedEpic,
  SuggestedStoriesForEpic,
} from '@/lib/software/assistant-suggestions';

/**
 * StageAssistantChat — the ONE reusable, governed assistant CHAT panel any guided stage
 * can mount. It replaces the old one-shot StageAssistant stub with a real conversation:
 *
 *   • a visible thread of user + assistant turns, assistant replies rendered as MARKDOWN
 *     (reuses the OS `<Markdown>` renderer — no new dep, no raw markdown leaking through);
 *   • a message input + Send that POSTs the running thread to the stage assistant route;
 *   • structured SUGGESTION CARDS returned by the route, each with an Apply button that
 *     invokes a host callback — the host applies it locally + persists through its own
 *     governed path. The assistant only suggests; this component never mutates anything.
 *
 * Honest states: a busy spinner while awaiting; a 503/402/4xx surfaced plainly as the
 * route's own error; an empty thread invites the first question. Governance stays in the
 * route — this is presentation + fetch only.
 *
 * Controlled by the host via `onApply*` callbacks; it holds only local chat state.
 */

type Turn = { role: 'user' | 'assistant'; content: string };

export default function StageAssistantChat({
  appId,
  stage,
  intro,
  starters = [],
  onApplyPurpose,
  onApplyGrants,
  onApplyEpics,
  onApplyStories,
}: {
  /** The app the assistant reads under the caller's governance (server-side). */
  appId: string;
  /** The guided stage — routed to the stage-scoped prompt server-side. */
  stage: 'define' | 'design' | 'build' | 'preview' | 'operate';
  /** A one-line "what this helper does here", shown above the thread. */
  intro: string;
  /** Optional quick-start prompts shown when the thread is empty. */
  starters?: string[];
  /** Define: adopt an improved purpose (host shows it as a confirmable draft). */
  onApplyPurpose?: (purpose: string) => void;
  /** Define: fold suggested grants into the ContextGrants value. */
  onApplyGrants?: (grants: SuggestedGrant[]) => void;
  /** Design: create whole suggested epics. */
  onApplyEpics?: (epics: SuggestedEpic[]) => void;
  /** Design: add suggested stories under existing epics. */
  onApplyStories?: (groups: SuggestedStoriesForEpic[]) => void;
}) {
  const [thread, setThread] = useState<Turn[]>([]);
  const [suggestions, setSuggestions] = useState<StageSuggestions>({});
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
        const res = await fetch(`/api/apps/${appId}/assistant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, messages: nextThread }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          suggestions?: StageSuggestions;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        setThread((t) => [...t, { role: 'assistant', content: data.message ?? '' }]);
        setSuggestions(data.suggestions ?? {});
        // Scroll the thread to the latest turn.
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [appId, stage, thread, busy],
  );

  const hasSuggestions =
    !!suggestions.improvedPurpose ||
    (suggestions.suggestedGrants?.length ?? 0) > 0 ||
    (suggestions.suggestedEpics?.length ?? 0) > 0 ||
    (suggestions.suggestedStories?.length ?? 0) > 0;

  return (
    <div className="sac">
      <div className="sac-head">
        <span className="sac-title">Assistant</span>
        <span className="sac-intro">{intro}</span>
      </div>

      <div className="sac-thread" ref={scrollRef}>
        {thread.length === 0 && !busy ? (
          <div className="sac-empty">
            <p className="hint" style={{ margin: 0 }}>Ask the assistant, or start with a suggestion.</p>
            {starters.length > 0 ? (
              <div className="sac-starters">
                {starters.map((s) => (
                  <button key={s} type="button" className="btn ghost sm" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {thread.map((t, i) => (
          <div key={i} className={`sac-turn sac-${t.role}`}>
            {t.role === 'assistant' ? (
              <Markdown>{t.content || '…'}</Markdown>
            ) : (
              <span>{t.content}</span>
            )}
          </div>
        ))}

        {busy ? (
          <div className="sac-turn sac-assistant">
            <span className="spin" /> <span className="muted" style={{ fontSize: 12 }}>Thinking…</span>
          </div>
        ) : null}
      </div>

      {hasSuggestions ? (
        <div className="sac-suggestions">
          {suggestions.improvedPurpose && onApplyPurpose ? (
            <SuggestionCard
              label="Suggested purpose"
              onApply={() => onApplyPurpose(suggestions.improvedPurpose!)}
              applyLabel="Use this purpose"
            >
              <p style={{ margin: 0 }}>{suggestions.improvedPurpose}</p>
            </SuggestionCard>
          ) : null}

          {suggestions.suggestedGrants?.length && onApplyGrants ? (
            <SuggestionCard
              label={`Suggested context (${suggestions.suggestedGrants.length})`}
              onApply={() => onApplyGrants(suggestions.suggestedGrants!)}
              applyLabel="Grant all"
            >
              <ul className="sac-list">
                {suggestions.suggestedGrants.map((g, i) => (
                  <li key={`${g.kind}:${g.id}:${i}`}>
                    <span className="badge muted">{g.kind}</span>{' '}
                    <span className="mono" style={{ fontSize: 12 }}>{g.id}</span>
                    {g.access ? <span className="badge" style={{ marginLeft: 6 }}>{g.access}</span> : null}
                    {g.reason ? <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>— {g.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </SuggestionCard>
          ) : null}

          {suggestions.suggestedEpics?.length && onApplyEpics ? (
            <SuggestionCard
              label={`Suggested EPICs (${suggestions.suggestedEpics.length})`}
              onApply={() => onApplyEpics(suggestions.suggestedEpics!)}
              applyLabel="Create EPICs"
            >
              <ul className="sac-list">
                {suggestions.suggestedEpics.map((e, i) => (
                  <li key={`${e.title}:${i}`}>
                    <strong>{e.title}</strong>
                    {e.stories?.length ? <span className="muted" style={{ fontSize: 12 }}> · {e.stories.length} stor{e.stories.length === 1 ? 'y' : 'ies'}</span> : null}
                    {e.description ? <div className="muted" style={{ fontSize: 12 }}>{e.description}</div> : null}
                  </li>
                ))}
              </ul>
            </SuggestionCard>
          ) : null}

          {suggestions.suggestedStories?.length && onApplyStories ? (
            <SuggestionCard
              label={`Suggested stories (${suggestions.suggestedStories.reduce((n, g) => n + g.stories.length, 0)})`}
              onApply={() => onApplyStories(suggestions.suggestedStories!)}
              applyLabel="Add stories"
            >
              <ul className="sac-list">
                {suggestions.suggestedStories.map((g, i) => (
                  <li key={`${g.epicTitle}:${i}`}>
                    <span className="muted" style={{ fontSize: 12 }}>under</span> <strong>{g.epicTitle}</strong>
                    <ul className="sac-sublist">
                      {g.stories.map((s, j) => <li key={j}>{s.title}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </SuggestionCard>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error" style={{ margin: '8px 0 0' }}>{error}</div> : null}

      <form
        className="sac-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the assistant…"
          disabled={busy}
          aria-label="Message the assistant"
        />
        <button className="btn sm" type="submit" disabled={busy || !input.trim()}>
          {busy ? <span className="spin" /> : 'Send'}
        </button>
      </form>

      <style jsx>{`
        .sac {
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--panel);
          padding: 12px 14px;
          margin-top: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sac-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .sac-title { font-weight: 600; }
        .sac-intro { color: var(--text-muted); font-size: 12.5px; }
        .sac-thread {
          display: flex; flex-direction: column; gap: 10px;
          max-height: 340px; overflow-y: auto;
          padding-right: 2px;
        }
        .sac-empty { padding: 8px 2px; display: flex; flex-direction: column; gap: 10px; }
        .sac-starters { display: flex; flex-wrap: wrap; gap: 6px; }
        .sac-turn { font-size: 13.5px; line-height: 1.55; max-width: 100%; }
        .sac-user {
          align-self: flex-end;
          background: var(--gold-soft);
          border: 1px solid var(--gold-line);
          color: var(--text);
          border-radius: 12px 12px 4px 12px;
          padding: 7px 11px;
          max-width: 85%;
        }
        .sac-assistant {
          align-self: flex-start;
          background: var(--tile, var(--bg-elevated, var(--panel)));
          border: 1px solid var(--border);
          border-radius: 12px 12px 12px 4px;
          padding: 8px 12px;
          max-width: 92%;
        }
        .sac-suggestions { display: flex; flex-direction: column; gap: 8px; }
        .sac-list { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
        .sac-sublist { margin: 2px 0 0; padding-left: 16px; color: var(--text-muted); font-size: 12px; }
        .sac-input { display: flex; gap: 8px; align-items: center; }
        .sac-input input { flex: 1; }
      `}</style>
    </div>
  );
}

/**
 * One suggestion card — a labelled, calm block with an Apply button. Presentation only;
 * the Apply handler is host-provided (it applies locally + persists through governance).
 */
function SuggestionCard({
  label,
  applyLabel,
  onApply,
  children,
}: {
  label: string;
  applyLabel: string;
  onApply: () => void;
  children: React.ReactNode;
}) {
  const [applied, setApplied] = useState(false);
  return (
    <div className="sac-card">
      <div className="sac-card-head">
        <span className="sac-card-label">{label}</span>
        <button
          type="button"
          className="btn sm"
          disabled={applied}
          onClick={() => {
            onApply();
            setApplied(true);
          }}
        >
          {applied ? 'Applied ✓' : applyLabel}
        </button>
      </div>
      <div className="sac-card-body">{children}</div>
      <style jsx>{`
        .sac-card {
          border: 1px solid var(--gold-line);
          background: var(--gold-soft);
          border-radius: 8px;
          padding: 10px 12px;
        }
        .sac-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .sac-card-label { font-weight: 600; font-size: 12.5px; }
        .sac-card-body { margin-top: 6px; font-size: 13px; }
      `}</style>
    </div>
  );
}
