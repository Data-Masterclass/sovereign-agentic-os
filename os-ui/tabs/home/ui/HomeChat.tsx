/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat — one large conversation that does what the signed-in user may do
 * USER STORY: As a user I want to type what I need on Home and have the OS answer or do it, ask me
 *             before it changes anything, explain a refusal plainly, and link me to what it made.
 * ARCHITECTURE:
 *   - Client shell over `tabs/home/lib/chat-view.ts` (all decisions live there, unit-tested).
 *   - Talks to `/api/assistant/chat` (steps stream as newline-delimited JSON) and
 *     `/api/assistant/confirm`; both run the governed MCP dispatch as the signed-in user.
 *   - A write arrives as `pending[]` and runs only when the user presses Run on its card.
 *   - Everything from the model or a tool is rendered as text (Markdown component, AskArtifacts);
 *     no raw HTML, no model-supplied links.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from '@core/ui/Markdown';
import AskArtifacts from '@core/ui/AskArtifacts';
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import {
  STARTERS,
  confirmCardArgs,
  linkForResult,
  parseStreamLines,
  plainError,
  type StreamEvent,
  type TypedError,
} from '@tabs/home/lib/chat-view';

type Step = { name: string; isError: boolean; parked?: boolean; error?: TypedError };
type Pending = { confirmationId: string; tool: string; args: Record<string, unknown>; expiresAt: string; state?: 'open' | 'running' | 'done' | 'declined' | 'failed' | 'gone'; note?: string; link?: { href: string; label: string } };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  steps?: Step[];
  pending?: Pending[];
  artifacts?: ChatArtifact[];
  failed?: boolean;
};

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
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserRef = useRef('');

  useEffect(() => {
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }, [messages, live, busy]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(async (text: string, history: Msg[]) => {
    const content = text.trim();
    if (!content || busy) return;
    setError('');
    lastUserRef.current = content;
    const next: Msg[] = [...history, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setLive([]);
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
          if (ev.type === 'step') setLive((l) => [...l, ev as unknown as Step]);
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
      setBusy(false);
    }
  }, [busy, conversationId]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    const patch = (u: Partial<Pending>) =>
      setMessages((all) => all.map((m, i) => (i !== mi ? m : { ...m, pending: m.pending?.map((x, j) => (j === pi ? { ...x, ...u } : x)) })));
    patch({ state: 'running' });
    try {
      const res = await fetch('/api/assistant/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmationId: p.confirmationId, conversationId, decision }),
      });
      const j = (await res.json()) as { status?: string; text?: string; error?: TypedError };
      if (j.status === 'executed') patch({ state: 'done', note: 'Done.', link: linkForResult(p.tool, j.text) ?? undefined });
      else if (j.status === 'declined') patch({ state: 'declined', note: 'Cancelled. Nothing was changed.' });
      else if (j.status === 'failed') patch({ state: 'failed', note: j.error ? plainError(j.error) : 'It did not run.' });
      else patch({ state: 'gone', note: 'This request is no longer available (it expired or was already used). Ask again.' });
    } catch (e) {
      patch({ state: 'failed', note: (e as Error).message });
    }
  }, [messages, conversationId]);

  const reset = () => { stop(); setMessages([]); setError(''); setInput(''); setConversationId(newConversationId()); };

  return (
    <section className="hc" aria-label="Chat with the OS">
      <div className="hc-head">
        <p className="hc-kicker">✦ Ask the OS</p>
        {messages.length > 0 ? <button type="button" className="hc-new" onClick={reset}>New chat</button> : null}
      </div>

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
                  {m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                  {m.pending?.map((p, pi) => (
                    <div key={p.confirmationId} className="hc-confirm" role="group" aria-label={`Confirm ${p.tool}`}>
                      <p className="hc-confirm-title">Waiting for your OK: <code>{p.tool}</code></p>
                      <pre className="hc-confirm-args">{JSON.stringify(confirmCardArgs(p.args), null, 2)}</pre>
                      {p.state === 'open' || p.state === 'running' ? (
                        <div className="hc-confirm-actions">
                          <button type="button" className="hc-run" disabled={p.state === 'running'} onClick={() => void decide(mi, pi, 'confirm')}>Run it</button>
                          <button type="button" className="hc-cancel" disabled={p.state === 'running'} onClick={() => void decide(mi, pi, 'decline')}>Cancel</button>
                        </div>
                      ) : (
                        <p className={`hc-confirm-note is-${p.state}`}>{p.note}{p.link ? <> <Link href={p.link.href}>{p.link.label} →</Link></> : null}</p>
                      )}
                    </div>
                  ))}
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
              <p className="hc-working"><span className="spin" /> Working through governed tools…</p>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="error hc-error" role="alert">{error}</div> : null}

      <form className="hc-form" onSubmit={(e) => { e.preventDefault(); void send(input, messages); }}>
        <textarea
          className="hc-input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask, or tell the OS what to build…"
          aria-label="Message the OS"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input, messages); }
            if (e.key === 'Escape' && busy) stop();
          }}
        />
        {busy ? (
          <button type="button" className="hc-send is-stop" onClick={stop}>Stop</button>
        ) : (
          <button type="submit" className="hc-send" disabled={!input.trim()}>Send</button>
        )}
      </form>
      <p className="hc-hint">Enter sends, Shift+Enter adds a line. Every action is role-checked, audited and traced.</p>
    </section>
  );
}
