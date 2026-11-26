/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OS Assistant — the global "Ask the OS" chat drawer
 * USER STORY: As a signed-in user I want one assistant on every tab that knows which tab and
 *             artifact I am looking at so that I can ask for help or actions without leaving the page.
 * ARCHITECTURE:
 *   - Mounted once in `app/layout.tsx`. Renders the ONE chat session (`core/ui/chat-session.ts`) that
 *     Home renders too, so a conversation started on Home is the conversation here, and a turn keeps
 *     running across route changes. It registers the session's context provider: each new message
 *     carries the path and page context (`usePageContext`) of the page the user is on at send time.
 *   - While a turn runs and the panel is closed, the launcher shows "Ask the OS — working…" (pulse +
 *     polite live region); a turn that ends unseen leaves an "answer ready" dot (`chat-launcher.ts`).
 *     Signing out stops the turn and forgets the conversation.
 *   - Every turn is confirm-gated server-side: a write the assistant wants to make comes back as
 *     `pending[]` and is shown as the same confirm card Home uses (`ConfirmCard`); it runs only when
 *     the user presses Run. The decision is bound to the session's conversation id.
 *   - Live steps, the streamed draft and `status` lines (the model is busy and the turn retries) come
 *     from the session's one NDJSON reader.
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
import { usePageContext } from '@core/ui/core/PageContext';
import Markdown from '@core/ui/Markdown';
import AskArtifacts from '@core/ui/AskArtifacts';
import ConfirmCard, { sendDecision } from '@core/ui/ConfirmCard';
import { useChatSession, chatSession } from '@core/ui/useChatSession';
import { launcherView, LAUNCHER_NAME } from '@core/ui/chat-launcher';
import type { ChatContext } from '@core/ui/chat-session';
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

export default function OsAssistant() {
  const pathname = usePathname() || '/';
  const { user } = useUser();
  // What the user is looking at right now (open artifact + stage), published by the
  // active tab surface. Read by the chat session at SEND time, so each message is grounded
  // on the page the user is on when they press Send — null when no surface published one.
  const page = usePageContext();
  const [open, setOpen] = useState(false);
  const { conversationId, messages, live, draft, status, busy: turnBusy, error, ready } = useChatSession();
  const [input, setInput] = useState('');
  /** Attachments are uploading; the turn itself has not started yet. */
  const [uploading, setUploading] = useState(false);
  const loading = turnBusy || uploading;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const att = useChatAttachments();

  const contextRef = useRef<ChatContext>({ path: pathname, pageContext: page });
  contextRef.current = { path: pathname, pageContext: page };
  useEffect(() => chatSession.setContextProvider(() => contextRef.current), []);

  // The open panel is a view of the conversation: no "answer ready" dot while it is open.
  useEffect(() => (open ? chatSession.attachView() : undefined), [open]);

  // Sign-out (or a different user signing in) stops the turn and forgets the conversation.
  const userId = user?.id ?? null;
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    if (lastUserId.current !== null && lastUserId.current !== userId) {
      chatSession.signOut();
      setOpen(false);
    }
    lastUserId.current = userId;
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }, [messages, live, draft, loading, open]);

  const stop = useCallback(() => chatSession.stop(), []);

  const send = useCallback((text: string) => {
    if (!text.trim() || loading) return;
    setInput('');
    void chatSession.send(text);
  }, [loading]);

  /** Send from the composer: attachments are uploaded to My scope first, then the turn names them. */
  const submit = useCallback(async () => {
    if (loading || att.busy) return;
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
    if (!results.some((r) => r.outcome === 'created') && !input.trim()) return;
    att.clear();
    setInput('');
    void chatSession.send(composeWithAttachments(input, results));
  }, [att, input, loading, send]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    chatSession.patchPending(mi, pi, { state: 'running' });
    chatSession.patchPending(mi, pi, await sendDecision(p, conversationId, decision));
  }, [messages, conversationId]);

  // OPEN-FROM-ANYWHERE bridge: other surfaces open this one GLOBAL assistant by dispatching
  // `os-assistant:open`, optionally seeding a prompt to send at once. One session, one panel.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt?.trim();
      setOpen(true);
      if (prompt) void chatSession.send(prompt);
    };
    window.addEventListener('os-assistant:open', onOpen as EventListener);
    return () => window.removeEventListener('os-assistant:open', onOpen as EventListener);
  }, []);

  // The assistant acts AS the signed-in user; hide the surface when signed out.
  if (!user) return null;

  const context = tabLabel(pathname);
  const launcher = launcherView({ busy: turnBusy, ready }, pathname, open);

  return (
    <>
      {/* On Home the page IS the assistant; the floating launcher would only cover its input. */}
      {launcher.visible && (
        <>
          <button
            type="button"
            className={`osa-launcher${launcher.state === 'working' ? ' is-working' : ''}`}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-label={launcher.ariaLabel}
          >
            <span aria-hidden className="osa-spark">✦</span>
            <span className="osa-launcher-label">{LAUNCHER_NAME}</span>
            {launcher.badge ? <span className="osa-launcher-badge" aria-hidden>· {launcher.badge}</span> : null}
            {launcher.state === 'ready' ? <span className="osa-ready-dot" aria-hidden /> : null}
          </button>
          {/* Polite, so a background turn starting or finishing is announced without stealing focus. */}
          <span className="osa-sr" role="status" aria-live="polite">{launcher.announce}</span>
        </>
      )}

      {open && (
        <div className="drawer-backdrop" onClick={() => setOpen(false)}>
          <aside
            className={`drawer osa-drawer${att.dragging ? ' is-dropping' : ''}`}
            onClick={(e) => e.stopPropagation()}
            {...att.dropZoneProps}
            role="dialog"
            aria-modal="true"
            aria-label={LAUNCHER_NAME}
          >
            <div className="drawer-head">
              <div>
                <h2>{LAUNCHER_NAME}</h2>
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
                        <div className="bubble-role">{m.role === 'user' ? 'You' : LAUNCHER_NAME}</div>
                        <div className="bubble-body">
                          {m.role === 'user'
                            ? m.content
                            : <Markdown>{m.content}</Markdown>}
                        </div>
                        {m.role === 'assistant' && m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                        {m.role === 'assistant' ? m.pending?.map((p, pi) => <ConfirmCard key={p.confirmationId} p={p} onDecide={(d) => void decide(i, pi, d)} />) : null}
                        {m.steps && m.steps.length > 0 ? (
                          <div className="osa-tools" aria-label="Governed tools invoked">
                            {m.steps.map((t, j) => (
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
                      <div className="bubble-role">{LAUNCHER_NAME}</div>
                      {live.length > 0 ? (
                        <div className="osa-tools" aria-label="Governed tools invoked so far">
                          {live.map((t, j) => (
                            <span key={j} className={`chip osa-tool${t.isError ? ' blocked' : ''}`}>
                              {t.parked ? '…' : t.isError ? '⚠︎' : '✓'} {t.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {draft ? <div className="bubble-body"><Markdown>{draft}</Markdown></div> : null}
                      <div className="bubble-body row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="spin" />
                        <span className="muted" role="status" style={{ fontSize: 12 }}>
                          {status || (uploading && !turnBusy ? 'Uploading attachments…' : draft ? 'Writing…' : 'Planning and calling governed tools…')}
                        </span>
                        {turnBusy ? (
                          <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>
                            Stop
                          </button>
                        ) : null}
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
                    aria-label={`Message ${LAUNCHER_NAME}`}
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
