/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@/lib/useUser';
import { parseAgentChatResponse } from '@/lib/agents/agent-chat-response';

/**
 * THE SOVEREIGN OS ASSISTANT — one overarching, globally-available assistant.
 *
 * Mounted once in the app shell so it rides along on EVERY tab. It is context-
 * aware of the current route (it sends the pathname so the server grounds it in
 * that tab's context and surfaces that tab's tools first) while carrying the
 * whole-OS context — it can reach any governed tool. It POSTs to
 * /api/assistant/chat, which runs the PLAN→ACT harness and dispatches every
 * action through the OS's own governed MCP (same guardrails as external clients).
 *
 * The panel is transparent: each answer shows which governed tools were invoked
 * and flags any the governance layer blocked — it never hides what it did.
 */

// Friendly label for the tab in focus (mirrors the server's path→tab map). Used
// only for the little "Context:" hint in the header; the server is authoritative.
const TAB_LABELS: Record<string, string> = {
  data: 'Data',
  science: 'Science',
  knowledge: 'Knowledge',
  agents: 'Agents',
  software: 'Software',
  unstructured: 'Files',
  metrics: 'Metrics',
  dashboards: 'Dashboards',
  'big-bets': 'Big Bets',
  connections: 'Connections',
  governance: 'Governance',
  marketplace: 'Marketplace',
  strategy: 'Strategy',
  monitoring: 'Monitoring',
};

function tabLabel(pathname: string): string {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return TAB_LABELS[seg] ?? 'the OS';
}

type ToolTrace = { name: string; isError: boolean };
type Msg = { role: 'user' | 'assistant'; content: string; tools?: ToolTrace[] };

export default function OsAssistant() {
  const pathname = usePathname() || '/';
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: pathname, messages: next }),
          signal: ctrl.signal,
        });
        const raw = await res.text();
        const parsed = parseAgentChatResponse(res.ok, res.status, raw);
        if ('error' in parsed) {
          setError(parsed.error);
        } else {
          let tools: ToolTrace[] | undefined;
          try {
            const j = JSON.parse(raw);
            if (Array.isArray(j.tools)) tools = j.tools as ToolTrace[];
          } catch {
            /* content already parsed; tools are optional */
          }
          setMessages((m) => [...m, { role: 'assistant', content: parsed.content, tools }]);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        abortRef.current = null;
        setLoading(false);
      }
    },
    [loading, messages, pathname],
  );

  // The assistant acts AS the signed-in user; hide the surface when signed out.
  if (!user) return null;

  const context = tabLabel(pathname);

  return (
    <>
      {!open && (
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
            className="drawer osa-drawer"
            onClick={(e) => e.stopPropagation()}
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
                        <div className="bubble-body">{m.content}</div>
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
                        <span className="muted" style={{ fontSize: 12 }}>
                          Planning and calling governed tools…
                        </span>
                        <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>
                          Stop
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}

                <form
                  onSubmit={(e) => { e.preventDefault(); send(input); }}
                  style={{ marginTop: 12 }}
                >
                  <textarea
                    rows={3}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={`Ask about ${context}, or anything across the OS…`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); }
                    }}
                  />
                  <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send.</div>
                    {loading ? (
                      <button className="btn ghost" type="button" onClick={stop}>Stop</button>
                    ) : (
                      <button className="btn" type="submit" disabled={!input.trim()}>Send</button>
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
