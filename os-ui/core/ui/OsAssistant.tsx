/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OS Assistant — the global "Ask the OS" chat drawer
 * USER STORY: As a signed-in user I want one assistant on every tab that knows which tab and
 *             artifact I am looking at so that I can ask for help or actions without leaving the page.
 * ARCHITECTURE:
 *   - Mounted once in `app/layout.tsx`. POSTs the path, messages and page context
 *     (`usePageContext`) to `/api/assistant/chat`, which runs the plan/act loop through the OS's
 *     own governed MCP as the user.
 *   - Every turn is confirm-gated server-side: a write the assistant wants to make comes back as
 *     `pending[]` and is shown as the same confirm card Home uses (`ConfirmCard`); it runs only when
 *     the user presses Run. The drawer keeps one conversation id so that decision is bound to it.
 *   - Asks for the live NDJSON stream so a `status` event (the model is busy and the turn retries)
 *     shows as a quiet line under the spinner; the final `done` event carries the same payload as
 *     the JSON response.
 *   - Shows which tools ran (and which were blocked) and renders the tools' typed artifacts via
 *     `AskArtifacts`; no model-authored markup is rendered.
 *   - Other surfaces (e.g. Home "Talk to the OS") open it with the `os-assistant:open` event, so
 *     there is one instance. Hidden when signed out.
 *   - Files can be dropped on the drawer, pasted, or attached (`ChatAttachments.tsx`), the same way as
 *     on Home: uploaded to My scope first, then the turn is sent with what was created named in front.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@core/ui/useUser';
import { parseAgentChatResponse } from '@tabs/agents/lib/agent-chat-response';
import { usePageContext } from '@core/ui/core/PageContext';
import Markdown from '@core/ui/Markdown';
import AskArtifacts from '@core/ui/AskArtifacts';
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import ConfirmCard, { sendDecision, type Pending } from '@core/ui/ConfirmCard';
import { parseStreamLines, streamStatusText, type StreamEvent } from '@core/ui/chat-view';
import { useChatAttachments, AttachButton, AttachmentTray } from '@core/ui/ChatAttachments';
import { composeWithAttachments, type AttachmentResult } from '@core/runtime/chat-attachments';

// Friendly label for the tab in focus (mirrors the server's path→tab map). Used
// only for the little "Context:" hint in the header; the server is authoritative.
const TAB_LABELS: Record<string, string> = {
  data: 'Data',
  knowledge: 'Knowledge',
  agents: 'Agents',
  software: 'Software',
  unstructured: 'Files',
  metrics: 'KPIs',
  dashboards: 'Dashboards',
  connections: 'Connections',
  governance: 'Governance',
  monitoring: 'Monitoring',

};

function tabLabel(pathname: string): string {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return TAB_LABELS[seg] ?? 'the OS';
}

type ToolTrace = { name: string; isError: boolean };
type Msg = { role: 'user' | 'assistant'; content: string; tools?: ToolTrace[]; artifacts?: ChatArtifact[]; pending?: Pending[] };

const newConversationId = () => `d-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;

export default function OsAssistant() {
  const pathname = usePathname() || '/';
  const { user } = useUser();
  // What the user is looking at right now (open artifact + stage), published by the
  // active tab surface. Sent with every message so the assistant is grounded on it
  // — it's null when no surface published one, and the request is unchanged then.
  const page = usePageContext();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId] = useState(newConversationId);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** A quiet status from the server while the turn is still running (e.g. the model is busy and it retries). */
  const [status, setStatus] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const att = useChatAttachments();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }, [messages, loading]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || loading) return;
      setError('');
      const next: Msg[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setStatus('');
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: pathname,
            stream: true,
            conversationId,
            messages: next.map((m) => ({ role: m.role, content: m.content })),
            pageContext: page,
          }),
          signal: ctrl.signal,
        });
        let raw = '';
        if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('content-type') ?? '')) {
          raw = await res.text();
        } else {
          // Live stream: a `status` line is shown quietly; `done` is the turn's JSON payload.
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let rest = '';
          let done: StreamEvent | null = null;
          let failed: string | null = null;
          for (;;) {
            const { value, done: end } = await reader.read();
            if (end) break;
            const chunk = parseStreamLines(rest, dec.decode(value, { stream: true }));
            rest = chunk.rest;
            for (const ev of chunk.events) {
              if (ev.type === 'status') setStatus(streamStatusText(ev) ?? '');
              else if (ev.type === 'step' || ev.type === 'token') setStatus('');
              else if (ev.type === 'done') done = ev;
              else if (ev.type === 'error') failed = String(ev.error ?? 'The assistant could not complete the request.');
            }
          }
          if (failed !== null) throw new Error(failed);
          if (!done) throw new Error('The answer was cut off before it finished. Try again.');
          raw = JSON.stringify(done);
        }
        const parsed = parseAgentChatResponse(res.ok, res.status, raw);
        if ('error' in parsed) {
          setError(parsed.error);
        } else {
          let tools: ToolTrace[] | undefined;
          let artifacts: ChatArtifact[] | undefined;
          let pending: Pending[] | undefined;
          try {
            const j = JSON.parse(raw);
            if (Array.isArray(j.tools)) tools = j.tools as ToolTrace[];
            // Validated client-side too: the last place that can refuse to render a kind
            // this build does not understand. An absent/malformed field degrades to none.
            const list = parseArtifacts(j);
            if (list.length > 0) artifacts = list;
            if (Array.isArray(j.pending) && j.pending.length > 0) {
              pending = (j.pending as Pending[]).map((p) => ({ ...p, state: 'open' as const }));
            }
          } catch {
            /* content already parsed; tools and artifacts are optional */
          }
          setMessages((m) => [...m, { role: 'assistant', content: parsed.content, tools, artifacts, pending }]);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        abortRef.current = null;
        setStatus('');
        setLoading(false);
      }
    },
    [loading, messages, pathname, page, conversationId],
  );

  /** Send from the composer: attachments are uploaded to My scope first, then the turn names them. */
  const submit = useCallback(async () => {
    if (loading || att.busy) return;
    if (!att.ready) { void send(input); return; }
    setError('');
    setLoading(true);
    let results: AttachmentResult[];
    try {
      results = await att.upload();
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      return;
    }
    setLoading(false);
    if (!results.some((r) => r.outcome === 'created') && !input.trim()) return;
    att.clear();
    void send(composeWithAttachments(input, results));
  }, [att, input, loading, send]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    const patch = (u: Partial<Pending>) =>
      setMessages((all) => all.map((m, i) => (i !== mi ? m : { ...m, pending: m.pending?.map((x, j) => (j === pi ? { ...x, ...u } : x)) })));
    patch({ state: 'running' });
    patch(await sendDecision(p, conversationId, decision));
  }, [messages, conversationId]);

  // OPEN-FROM-ANYWHERE bridge: other surfaces (e.g. the Home "Talk to the OS" hero) open this one
  // GLOBAL assistant by dispatching `os-assistant:open`, optionally seeding a prompt to send at once.
  // This keeps ONE assistant instance (no duplicate drawer/state) while letting Home feel like a
  // dedicated entry point.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt?.trim();
      setOpen(true);
      if (prompt) void send(prompt);
    };
    window.addEventListener('os-assistant:open', onOpen as EventListener);
    return () => window.removeEventListener('os-assistant:open', onOpen as EventListener);
  }, [send]);

  // The assistant acts AS the signed-in user; hide the surface when signed out.
  if (!user) return null;

  const context = tabLabel(pathname);

  return (
    <>
      {/* On Home the page IS the assistant; the floating launcher would only cover its input. */}
      {!open && pathname !== '/' && (
        <button
          type="button"
          className="osa-launcher"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label="Open the Sovereign OS Assistant"
        >
          <span aria-hidden className="osa-spark">✦</span>
          Ask the OS
        </button>
      )}

      {open && (
        <div className="drawer-backdrop" onClick={() => setOpen(false)}>
          <aside
            className={`drawer osa-drawer${att.dragging ? ' is-dropping' : ''}`}
            onClick={(e) => e.stopPropagation()}
            {...att.dropZoneProps}
            role="dialog"
            aria-modal="true"
            aria-label="Sovereign OS Assistant"
          >
            <div className="drawer-head">
              <div>
                <h2>Sovereign OS Assistant</h2>
                <p className="osa-context">
                  <span aria-hidden className="osa-dot" /> Context: <strong>{context}</strong>
                  {' '}· acts through governed MCP as {user.name}
                </p>
              </div>
              <button className="drawer-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            <div className="drawer-body osa-body">
              <div className="chat">
                <div className="chat-log osa-log" ref={scrollRef}>
                  {messages.length === 0 ? (
                    <div className="chat-empty">
                      Ask about anything in the OS. I help with the <strong>{context}</strong>{' '}
                      tab you are on, and can reach every governed tool across the platform.
                      Every action runs under your identity through the OS’s own MCP —
                      role-gated, approval-gated and audited.
                    </div>
                  ) : (
                    messages.map((m, i) => (
                      <div key={i} className={`bubble ${m.role}`}>
                        <div className="bubble-role">{m.role === 'user' ? 'You' : 'OS Assistant'}</div>
                        <div className="bubble-body">
                          {m.role === 'user'
                            ? m.content
                            : <Markdown>{m.content}</Markdown>}
                        </div>
                        {m.role === 'assistant' && m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                        {m.role === 'assistant' ? m.pending?.map((p, pi) => <ConfirmCard key={p.confirmationId} p={p} onDecide={(d) => void decide(i, pi, d)} />) : null}
                        {m.tools && m.tools.length > 0 ? (
                          <div className="osa-tools" aria-label="Governed tools invoked">
                            {m.tools.map((t, j) => (
                              <span key={j} className={`chip osa-tool${t.isError ? ' blocked' : ''}`}>
                                {t.isError ? '⚠︎' : '✓'} {t.name}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                  {loading ? (
                    <div className="bubble assistant">
                      <div className="bubble-role">OS Assistant</div>
                      <div className="bubble-body row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="spin" />
                        <span className="muted" role="status" style={{ fontSize: 12 }}>
                          {status || 'Planning and calling governed tools…'}
                        </span>
                        <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>
                          Stop
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}

                <AttachmentTray att={att} disabled={loading} />
                <form
                  onSubmit={(e) => { e.preventDefault(); void submit(); }}
                  style={{ marginTop: 12 }}
                >
                  <textarea
                    rows={3}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onPaste={att.onPaste}
                    aria-label="Message the OS Assistant"
                    placeholder={`Ask about ${context}, or anything across the OS…`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
                    }}
                  />
                  <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <AttachButton att={att} disabled={loading} className="btn ghost sm" />
                      <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send. Drop or paste files to attach.</div>
                    </div>
                    {loading ? (
                      <button className="btn ghost" type="button" onClick={stop}>Stop</button>
                    ) : (
                      <button className="btn" type="submit" disabled={att.busy || (!input.trim() && !att.ready)}>Send</button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
