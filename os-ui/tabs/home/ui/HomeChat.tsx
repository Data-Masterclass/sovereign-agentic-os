/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Ask the OS on Home — the large view of the one conversation that does what the signed-in user may do
 * USER STORY: As a user I want to type what I need on Home and have the OS answer or do it, ask me
 *             before it changes anything, explain a refusal plainly, and link me to what it made.
 * ARCHITECTURE:
 *   - Client shell over `core/ui/chat-view.ts` (all decisions live there, unit-tested).
 *   - Renders the ONE chat session (`core/ui/chat-session.ts`, via `useChatSession`), which owns the
 *     conversation and the `/api/assistant/chat` stream (newline-delimited JSON). The global "Ask the OS"
 *     panel renders the same session, so a turn started here keeps running after the user changes tab.
 *     Confirm decisions go through `sendDecision(` → `/api/assistant/chat`; history is
 *     `/api/assistant/conversations` (per user); saveAs offers come back on the answer.
 *   - A write arrives as `pending[]` and runs only when the user presses Run on its card.
 *   - Everything from the model or a tool is rendered as text (Markdown component, AskArtifacts);
 *     no raw HTML, no model-supplied links.
 *   - Files can be dropped on the chat, pasted, or attached (`core/ui/ChatAttachments.tsx`); they are
 *     uploaded to My scope first and the turn is sent with what was created named in front.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from '@core/ui/Markdown';
import AskArtifacts from '@core/ui/AskArtifacts';
import ConfirmCard, { sendDecision } from '@core/ui/ConfirmCard';
import { STARTERS, plainError, connectCards } from '@core/ui/chat-view';
import { SAVE_LABELS, type ChatStep, type ModelTraceView } from '@core/ui/chat-session';
import { LAUNCHER_NAME } from '@core/ui/chat-launcher';
import { useChatSession, chatSession } from '@core/ui/useChatSession';
import { useChatAttachments, AttachButton, AttachmentTray } from '@core/ui/ChatAttachments';
import { composeWithAttachments, type AttachmentResult } from '@core/runtime/chat-attachments';

type Summary = { id: string; title: string; updatedAt: string; messageCount: number };
/** "strong ×4 (0.0121 EUR) · worker ×1 (0.0002 EUR)": roles that ran, with their cost (a dash when no price is known). */
function traceSummary(t: ModelTraceView): string {
  return Object.entries(t.byRole).filter(([, v]) => v.calls > 0)
    .map(([role, v]) => `${role} ×${v.calls} (${v.cost === undefined ? '—' : `${v.cost.toFixed(4)} EUR`})`).join(' · ');
}

function StepRow({ s }: { s: ChatStep }) {
  const state = s.parked ? 'waiting for you' : s.isError ? 'refused' : 'done';
  return (
    <details className={`hc-step${s.isError ? ' is-refused' : ''}`}>
      <summary>
        <span aria-hidden>{s.parked ? '…' : s.isError ? '⚠︎' : '✓'}</span> <code>{s.name}</code> <span className="hc-step-state">{state}</span>
      </summary>
      {s.error ? <p className="hc-step-detail">{plainError(s.error)}</p> : <p className="hc-step-detail">Governed tool call, run as you.</p>}
    </details>
  );
}

export default function HomeChat({ firstName }: { firstName: string }) {
  const { conversationId, messages, live, draft, status, busy: turnBusy, error } = useChatSession();
  const [history, setHistory] = useState<Summary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  /** Attachments are uploading; the turn itself has not started yet. */
  const [uploading, setUploading] = useState(false);
  const busy = turnBusy || uploading;
  const logRef = useRef<HTMLDivElement | null>(null);
  const att = useChatAttachments();

  // Home is on screen: a turn that finishes now needs no "answer ready" dot.
  useEffect(() => chatSession.attachView(), []);

  useEffect(() => {
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }, [messages, live, busy]);

  const stop = useCallback(() => chatSession.stop(), []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/conversations');
      if (r.ok) setHistory(((await r.json()) as { conversations?: Summary[] }).conversations ?? []);
    } catch { /* the list is a convenience; the chat works without it */ }
  }, []);
  // On mount, and each time a turn ends (it may have been stored under a new title).
  useEffect(() => { if (!turnBusy) void loadHistory(); }, [turnBusy, loadHistory]);

  const openConversation = useCallback(async (id: string) => {
    if (await chatSession.loadConversation(id)) setShowHistory(false);
  }, []);

  const removeConversation = useCallback(async (id: string) => {
    await chatSession.deleteConversation(id);
    setHistory((h) => h.filter((x) => x.id !== id));
  }, []);

  const send = useCallback((text: string) => {
    if (!text.trim() || busy) return;
    setInput('');
    void chatSession.send(text);
  }, [busy]);

  /** Send from the composer: attachments are uploaded to My scope first, then the turn names them. */
  const submit = useCallback(async () => {
    if (busy || att.busy) return;
    if (!att.ready) { send(input); return; }
    chatSession.setError('');
    setUploading(true);
    let results: AttachmentResult[];
    try {
      results = await att.upload();
    } catch (e) {
      chatSession.setError((e as Error).message);
      setUploading(false);
      return;
    }
    setUploading(false);
    // Nothing landed and nothing typed: keep the chips (they say why) and send nothing.
    if (!results.some((r) => r.outcome === 'created') && !input.trim()) return;
    att.clear();
    setInput('');
    void chatSession.send(composeWithAttachments(input, results));
  }, [att, busy, input, send]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    chatSession.patchPending(mi, pi, { state: 'running' });
    chatSession.patchPending(mi, pi, await sendDecision(p, conversationId, decision));
  }, [messages, conversationId]);

  const reset = () => { chatSession.reset(); setInput(''); };

  return (
    <section className={`hc${att.dragging ? ' is-dropping' : ''}`} aria-labelledby="hc-title" {...att.dropZoneProps}>
      <div className="hc-head">
        <h2 className="hc-title" id="hc-title"><span aria-hidden className="hc-title-spark">✦</span> {LAUNCHER_NAME}</h2>
        <div className="hc-head-actions">
          {history.length > 0 ? <button type="button" className="hc-new" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>History ({history.length})</button> : null}
          {messages.length > 0 ? <button type="button" className="hc-new" onClick={reset}>New chat</button> : null}
        </div>
      </div>
      {showHistory ? (
        <ul className="hc-history" aria-label="Your conversations">
          {history.map((h) => (
            <li key={h.id} className={`hc-history-row${h.id === conversationId ? ' is-current' : ''}`}>
              <button type="button" className="hc-history-open" onClick={() => void openConversation(h.id)}>
                <span className="hc-history-title">{h.title}</span>
                <span className="hc-history-meta">{new Date(h.updatedAt).toLocaleDateString()} · {Math.ceil(h.messageCount / 2)} turn{h.messageCount > 2 ? 's' : ''}</span>
              </button>
              <button type="button" className="hc-history-del" aria-label={`Delete ${h.title}`} onClick={() => void removeConversation(h.id)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="hc-log" ref={logRef} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="hc-empty">
            <h3 className="hc-empty-title">What do you want to do, {firstName}?</h3>
            <p className="hc-empty-sub">Ask about your data, KPIs, files and knowledge, or ask me to build something. I act as you, and I ask before I change anything. This chat follows you: it keeps working when you open another tab, under the {LAUNCHER_NAME} button.</p>
            <div className="hc-starters">
              {STARTERS.map((s) => (
                <button key={s.label} type="button" className="hc-starter" onClick={() => send(s.prompt)}>{s.label}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, mi) => (
            <div key={mi} className={`hc-msg hc-${m.role}`}>
              {m.role === 'user' ? (
                <div className="hc-bubble">{m.content}</div>
              ) : (
                <div className="hc-answer">
                  {m.steps && m.steps.length > 0 ? <div className="hc-steps">{m.steps.map((s, i) => <StepRow key={i} s={s} />)}</div> : null}
                  <Markdown>{m.content}</Markdown>
                  {m.trace && m.trace.calls.length > 0 ? (
                    <details className="hc-trace">
                      <summary>Models: {traceSummary(m.trace)}</summary>
                      <ul>{m.trace.calls.map((c, i) => <li key={i}>{c.purpose} · {c.role} · {c.model}{c.escalated ? ' · escalated from worker' : ''}</li>)}</ul>
                    </details>
                  ) : null}
                  {m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                  {connectCards(m.steps, typeof window === 'undefined' ? '/' : window.location.pathname).map((c) => (
                    <div key={c.connectionId} className="hc-connect" role="group" aria-label={c.action}>
                      <span>{c.note}</span>
                      <a className="hc-connect-btn" href={c.href}>{c.action}</a>
                    </div>
                  ))}
                  {m.pending?.map((p, pi) => <ConfirmCard key={p.confirmationId} p={p} onDecide={(d) => void decide(mi, pi, d)} />)}
                  {mi === messages.length - 1 && !busy && !m.pending?.length && m.saveAs && m.saveAs.length > 0 && m.content ? (
                    <div className="hc-saveas" role="group" aria-label="Save this answer as">
                      <span className="hc-saveas-label">Save as</span>
                      {m.saveAs.map((k) => (
                        <button key={k} type="button" className="hc-saveas-btn" onClick={() => void chatSession.send(`Save as ${SAVE_LABELS[k]}`, { saveAs: k })}>{SAVE_LABELS[k]}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              {m.failed ? <button type="button" className="hc-retry" onClick={() => void chatSession.retry(mi)}>Retry</button> : null}
            </div>
          ))
        )}
        {busy ? (
          <div className="hc-msg hc-assistant">
            <div className="hc-answer">
              {live.length > 0 ? <div className="hc-steps">{live.map((s, i) => <StepRow key={i} s={s} />)}</div> : null}
              {draft ? <div className="hc-draft"><Markdown>{draft}</Markdown></div> : null}
              <p className="hc-working" role="status"><span className="spin" /> {status || (draft ? 'Writing…' : 'Working through governed tools…')}</p>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="error hc-error" role="alert">{error}</div> : null}

      <AttachmentTray att={att} disabled={busy} />
      <form className="hc-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <AttachButton att={att} disabled={busy} className="hc-attach" />
        <textarea
          className="hc-input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={att.onPaste}
          placeholder="Ask, or tell the OS what to build…"
          aria-label={`Message ${LAUNCHER_NAME}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === 'Escape' && busy) stop();
          }}
        />
        {busy ? (
          <button type="button" className="hc-send is-stop" onClick={stop}>Stop</button>
        ) : (
          <button type="submit" className="hc-send" disabled={att.busy || (!input.trim() && !att.ready)}>Send</button>
        )}
      </form>
      <p className="hc-hint">Enter sends, Shift+Enter adds a line. Drop, paste or attach files: data goes to Data, documents to Files, markdown to Knowledge — in your My scope. Every action is role-checked, audited and traced.</p>
    </section>
  );
}
