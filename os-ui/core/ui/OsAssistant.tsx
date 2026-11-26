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
 * I18N:       converted (wave 2) — strings from the `home` namespace (`home.assistant.*`, `home.launcherBtn.*`).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import { usePathname } from 'next/navigation';
import { useUser } from '@core/ui/useUser';
import { usePageContext } from '@core/ui/core/PageContext';
import Markdown from '@core/ui/Markdown';
import AskArtifacts from '@core/ui/AskArtifacts';
import ConfirmCard, { sendDecision, shownText } from '@core/ui/ConfirmCard';
import { useChatSession, chatSession } from '@core/ui/useChatSession';
import { launcherView } from '@core/ui/chat-launcher';
import type { ChatContext } from '@core/ui/chat-session';
import { useChatAttachments, AttachButton, AttachmentTray } from '@core/ui/ChatAttachments';
import { composeWithAttachments, type AttachmentResult } from '@core/runtime/chat-attachments';

// The tab in focus (mirrors the server's path→tab map), as its `home.assistant.tabs.<key>` label. Used
// only for the little "Context:" hint in the header; the server is authoritative.
const TAB_KEYS = {
  data: 'data',
  knowledge: 'knowledge',
  agents: 'agents',
  software: 'software',
  unstructured: 'files',
  metrics: 'metrics',
  dashboards: 'dashboards',
  connections: 'connections',
  governance: 'governance',
  monitoring: 'monitoring',
} as const;
type TabKey = (typeof TAB_KEYS)[keyof typeof TAB_KEYS] | 'fallback';

function tabKey(pathname: string): TabKey {
  const seg = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return Object.hasOwn(TAB_KEYS, seg) ? TAB_KEYS[seg as keyof typeof TAB_KEYS] : 'fallback';
}

export default function OsAssistant() {
  const t = useTranslations('home');
  const pathname = usePathname() || '/';
  const { user, reload: reloadUser } = useUser();
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

  // Sign-out: the guarantee is the full-page navigation sign-out does, which drops this in-memory
  // session with the page. `useUser` reads /api/auth/me once, so as a second line, when the window
  // regains focus we re-read who is signed in; if the session ended or another user signed in
  // (e.g. in another tab), the turn stops and the conversation is forgotten. A failed read
  // (network blip) changes nothing — only an answer from the server does.
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
    const onFocus = async () => {
      if (lastUserId.current === null) return;
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!res.ok && res.status !== 401) return;
        const body = (await res.json().catch(() => ({}))) as { user?: { id?: string } | null };
        const now = res.status === 401 ? null : body.user?.id ?? null;
        if (now !== lastUserId.current) {
          chatSession.signOut();
          setOpen(false);
          void reloadUser();
        }
      } catch { /* unreachable: keep the session; the next focus checks again */ }
    };
    const handler = () => { void onFocus(); };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [reloadUser]);

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
    // Dropped while a turn runs (e.g. started from the other surface): keep what the user typed.
    if (!text.trim() || loading || !chatSession.canSend()) return;
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
    const message = composeWithAttachments(input, results);
    // A turn started meanwhile (the other surface): the files are uploaded, so keep the composed
    // message in the box instead of dropping it — the user sends it when the answer is done.
    if (!chatSession.canSend()) { setInput(message); return; }
    setInput('');
    void chatSession.send(message);
  }, [att, input, loading, send]);

  const decide = useCallback(async (mi: number, pi: number, decision: 'confirm' | 'decline') => {
    const p = messages[mi]?.pending?.[pi];
    if (!p) return;
    // Bound to THIS conversation (the id this render's closure captured at the click) and card: if the
    // user starts another conversation meanwhile, the late result is not applied to whatever card now
    // sits at the same position.
    chatSession.patchPending(conversationId, p.confirmationId, { state: 'running' });
    chatSession.patchPending(conversationId, p.confirmationId, await sendDecision(p, conversationId, decision));
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

  const context = t(`assistant.tabs.${tabKey(pathname)}`);
  const name = t('launcherBtn.name');
  const launcher = launcherView({ busy: turnBusy, ready }, pathname, open);

  return (
    <>
      {/* Always mounted, so a change is announced — including "working…" the moment the user leaves
          Home mid-turn. Polite: it never steals focus. Empty on Home and while the panel is open. */}
      <span className="osa-sr" role="status" aria-live="polite">{launcher.visible && launcher.announce ? t(launcher.announce) : ''}</span>
      {/* On Home the page IS the assistant; the floating launcher would only cover its input. */}
      {launcher.visible && (
        <>
          <button
            type="button"
            className={`osa-launcher${launcher.state === 'working' ? ' is-working' : ''}`}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-label={t(launcher.ariaLabel)}
          >
            <span aria-hidden className="osa-spark">✦</span>
            <span className="osa-launcher-label">{name}</span>
            {launcher.badge ? <span className="osa-launcher-badge" aria-hidden>· {t(launcher.badge)}</span> : null}
            {launcher.state === 'ready' ? <span className="osa-ready-dot" aria-hidden /> : null}
          </button>
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
            aria-label={name}
          >
            <div className="drawer-head">
              <div>
                <h2>{name}</h2>
                <p className="osa-context">
                  <span aria-hidden className="osa-dot" /> {t.rich('assistant.context', { context, user: user.name, b: (c) => <strong>{c}</strong> })}
                </p>
              </div>
              <button className="drawer-x" onClick={() => setOpen(false)} aria-label={t('assistant.close')}>×</button>
            </div>

            <div className="drawer-body osa-body">
              <div className="chat">
                <div className="chat-log osa-log" ref={scrollRef}>
                  {messages.length === 0 ? (
                    <div className="chat-empty">
                      {t.rich('assistant.empty', { context, b: (c) => <strong>{c}</strong> })}
                    </div>
                  ) : (
                    messages.map((m, i) => (
                      <div key={i} className={`bubble ${m.role}`}>
                        <div className="bubble-role">{m.role === 'user' ? t('assistant.you') : name}</div>
                        <div className="bubble-body">
                          {m.role === 'user'
                            ? m.content
                            : <Markdown>{m.content}</Markdown>}
                        </div>
                        {m.role === 'assistant' && m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                        {m.role === 'assistant' ? m.pending?.map((p, pi) => <ConfirmCard key={p.confirmationId} p={p} onDecide={(d) => void decide(i, pi, d)} />) : null}
                        {m.steps && m.steps.length > 0 ? (
                          <div className="osa-tools" aria-label={t('assistant.toolsAria')}>
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
                      <div className="bubble-role">{name}</div>
                      {live.length > 0 ? (
                        <div className="osa-tools" aria-label={t('assistant.toolsSoFarAria')}>
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
                          {status || (uploading && !turnBusy ? t('assistant.uploading') : draft ? t('assistant.writing') : t('assistant.planning'))}
                        </span>
                        {turnBusy ? (
                          <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>
                            {t('assistant.stop')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                {error ? <div className="error" style={{ marginTop: 10 }}>{shownText(t, error)}</div> : null}

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
                    aria-label={t('chat.inputAria', { name })}
                    placeholder={t('assistant.placeholder', { context })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
                    }}
                  />
                  <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <AttachButton att={att} disabled={loading} className="btn ghost sm" />
                      <div className="hint" style={{ marginTop: 0 }}>{t('assistant.hint')}</div>
                    </div>
                    {loading ? (
                      <button className="btn ghost" type="button" onClick={stop}>{t('assistant.stop')}</button>
                    ) : (
                      <button className="btn" type="submit" disabled={att.busy || (!input.trim() && !att.ready)}>{t('assistant.send')}</button>
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
