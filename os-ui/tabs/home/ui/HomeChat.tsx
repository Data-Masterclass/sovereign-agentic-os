/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat — one large conversation that does what the signed-in user may do
 * USER STORY: As a user I want to type what I need on Home and have the OS answer or do it, ask me
 *             before it changes anything, explain a refusal plainly, and link me to what it made.
 * ARCHITECTURE:
 *   - Client shell over `core/ui/chat-view.ts` (all decisions live there, unit-tested).
 *   - Talks to `/api/assistant/chat` (steps stream as newline-delimited JSON) and
 *     `/api/assistant/confirm`; both run the governed MCP dispatch as the signed-in user.
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
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import ConfirmCard, { sendDecision, type Pending } from '@core/ui/ConfirmCard';
import {
  STARTERS,
  parseStreamLines,
  plainError,
  streamStatusText,
  connectCards,
  type StreamEvent,
  type TypedError,
} from '@core/ui/chat-view';
import { useChatAttachments, AttachButton, AttachmentTray } from '@core/ui/ChatAttachments';
import { composeWithAttachments, type AttachmentResult } from '@core/runtime/chat-attachments';

type Step = { name: string; isError: boolean; parked?: boolean; error?: TypedError };
type Summary = { id: string; title: string; updatedAt: string; messageCount: number };
type SaveAsKind = 'kpi' | 'dashboard' | 'knowledge' | 'agent';
const SAVE_LABELS: Record<SaveAsKind, string> = { kpi: 'KPI', dashboard: 'Dashboard', knowledge: 'Knowledge note', agent: 'Agent' };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  saveAs?: SaveAsKind[];
  steps?: Step[];
  pending?: Pending[];
  artifacts?: ChatArtifact[];
  /** Which role and model handled each step of the turn, and the cost per role. */
  trace?: ModelTraceView;
  failed?: boolean;
};
type ModelTraceView = {
  calls: { purpose: string; role: string; model: string; escalated: boolean }[];
  byRole: Record<string, { calls: number; cost?: number }>;
};
/** "strong ×4 (0.0121 EUR) · worker ×1 (0.0002 EUR)": roles that ran, with their cost (a dash when no price is known). */
function traceSummary(t: ModelTraceView): string {
  return Object.entries(t.byRole).filter(([, v]) => v.calls > 0)
    .map(([role, v]) => `${role} ×${v.calls} (${v.cost === undefined ? '—' : `${v.cost.toFixed(4)} EUR`})`).join(' · ');
}

const newConversationId = () => `c-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;

function StepRow({ s }: { s: Step }) {
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
  const [conversationId, setConversationId] = useState(newConversationId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [live, setLive] = useState<Step[]>([]);
  const [draft, setDraft] = useState('');
  /** A quiet status from the server while the turn is still running (e.g. the model is busy and it retries). */
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<Summary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserRef = useRef('');
  const att = useChatAttachments();

  useEffect(() => {
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }, [messages, live, busy]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/conversations');
      if (r.ok) setHistory(((await r.json()) as { conversations?: Summary[] }).conversations ?? []);
    } catch { /* the list is a convenience; the chat works without it */ }
  }, []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const openConversation = useCallback(async (id: string) => {
    const r = await fetch(`/api/assistant/conversations/${encodeURIComponent(id)}`);
    if (!r.ok) { setError('That conversation is no longer available.'); return; }
    const c = (await r.json()) as { id: string; messages: { role: 'user' | 'assistant'; content: string; steps?: Step[]; pending?: { confirmationId: string; tool: string }[] }[] };
    setMessages(c.messages.map((m) => ({
      role: m.role,
      content: m.content,
      steps: m.steps,
      // A pending write's arguments are never stored: after a reload its card is closed.
      pending: m.pending?.map((p) => ({ ...p, args: {}, expiresAt: '', state: 'gone' as const, note: 'This request is no longer available (it expired or was already used). Ask again.' })),
    })));
    setConversationId(c.id);
    setShowHistory(false);
    setError('');
  }, []);

  const removeConversation = useCallback(async (id: string) => {
    await fetch('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteConversation: id }) });
    setHistory((h) => h.filter((x) => x.id !== id));
    if (id === conversationId) { setMessages([]); setConversationId(newConversationId()); }
  }, [conversationId]);

  const send = useCallback(async (text: string, prior: Msg[], saveAs?: SaveAsKind) => {
    const content = text.trim();
    if (!content || busy) return;
    setError('');
    lastUserRef.current = content;
    const next: Msg[] = [...prior, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setLive([]);
    setDraft('');
    setStatus('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: '/',
          conversationId,
          stream: true,
          ...(saveAs ? { saveAs } : {}),
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `The assistant answered ${res.status}.`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let rest = '';
      let done: StreamEvent | null = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const parsed = parseStreamLines(rest, dec.decode(value, { stream: true }));
        rest = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.type === 'token') { setStatus(''); setDraft((d) => d + String(ev.t ?? '')); }
          else if (ev.type === 'status') setStatus(streamStatusText(ev) ?? '');
          else if (ev.type === 'step') { setStatus(''); setDraft(''); setLive((l) => [...l, ev as unknown as Step]); }
          else if (ev.type === 'done') done = ev;
          else if (ev.type === 'error') throw new Error(String(ev.error ?? 'The assistant could not complete the request.'));
        }
      }
      if (!done) throw new Error('The answer was cut off before it finished. Try again.');
      const artifacts = parseArtifacts(done);
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content: String(done!.content ?? ''),
          steps: (done!.tools as Step[] | undefined) ?? [],
          pending: ((done!.pending as Pending[] | undefined) ?? []).map((p) => ({ ...p, state: 'open' as const })),
          artifacts: artifacts.length ? artifacts : undefined,
          saveAs: (done!.saveAs as SaveAsKind[] | undefined) ?? [],
          trace: done!.modelTrace as ModelTraceView | undefined,
        },
      ]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
        setMessages((m) => m.map((x, i) => (i === m.length - 1 && x.role === 'user' ? { ...x, failed: true } : x)));
      }
    } finally {
      abortRef.current = null;
      setLive([]);
      setDraft('');
      setStatus('');
      setBusy(false);
      void loadHistory();
    }
  }, [busy, conversationId, loadHistory]);

  /** Send from the composer: attachments are uploaded to My scope first, then the turn names them. */
  const submit = useCallback(async () => {
    if (busy || att.busy) return;
    if (!att.ready) { void send(input, messages); return; }
    setError('');
    setBusy(true);
    let results: AttachmentResult[];
    try {
      results = await att.upload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    // Nothing landed and nothing typed: keep the chips (they say why) and send nothing.
    if (!results.some((r) => r.outcome === 'created') && !input.trim()) return;
    att.clear();
    void send(composeWithAttachments(input, results), messages);
  }, [att, busy, input, messages, send]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    const patch = (u: Partial<Pending>) =>
      setMessages((all) => all.map((m, i) => (i !== mi ? m : { ...m, pending: m.pending?.map((x, j) => (j === pi ? { ...x, ...u } : x)) })));
    patch({ state: 'running' });
    patch(await sendDecision(p, conversationId, decision));
  }, [messages, conversationId]);

  const reset = () => { stop(); setMessages([]); setError(''); setInput(''); setConversationId(newConversationId()); };

  return (
    <section className={`hc${att.dragging ? ' is-dropping' : ''}`} aria-label="Chat with the OS" {...att.dropZoneProps}>
      <div className="hc-head">
        <p className="hc-kicker">✦ Ask the OS</p>
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
            <h2 className="hc-empty-title">What do you want to do, {firstName}?</h2>
            <p className="hc-empty-sub">Ask about your data, KPIs, files and knowledge, or ask me to build something. I act as you, and I ask before I change anything.</p>
            <div className="hc-starters">
              {STARTERS.map((s) => (
                <button key={s.label} type="button" className="hc-starter" onClick={() => void send(s.prompt, messages)}>{s.label}</button>
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
                        <button key={k} type="button" className="hc-saveas-btn" onClick={() => void send(`Save as ${SAVE_LABELS[k]}`, messages, k)}>{SAVE_LABELS[k]}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              {m.failed ? <button type="button" className="hc-retry" onClick={() => void send(lastUserRef.current, messages.slice(0, mi))}>Retry</button> : null}
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
          aria-label="Message the OS"
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
