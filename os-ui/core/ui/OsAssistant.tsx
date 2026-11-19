/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
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
import { parseConfirmCards, type ConfirmCard } from '@core/runtime/confirm-card';
import ConfirmActionCard, { type ConfirmCardState, type ConfirmDecision } from '@core/ui/ConfirmActionCard';

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
 * The panel is transparent: each answer shows which governed tools were invoked,
 * flags any the governance layer blocked, and renders the typed ARTIFACTS those
 * tools returned (C9) — the rows, the SQL or metric member behind them, the
 * backend's own truncation banner verbatim, and a chip naming the governed record
 * the answer is grounded in. It never hides what it did.
 *
 * CHANGES WAIT FOR YOU. When the assistant calls a tool that changes something, the server does
 * not run it: the turn comes back with a Confirm card per held call (`pending[]`), rendered by
 * `ConfirmActionCard` from the server's record. Confirm / Cancel / Allow-for-this-conversation
 * post only the card's id and the decision word to /api/assistant/confirm. After a Confirm the
 * drawer sends ONE follow-up turn so a multi-step task carries on (its next change gets its own
 * card); after a Cancel it sends nothing. The line the drawer adds to the conversation ("I
 * pressed Confirm…") is for the reader — the server tells the model what was decided from its
 * own record and does not trust that line.
 *
 * The artifact payload is the tools' own MCP `structuredContent`, so the drawer and
 * an external MCP client render the identical bytes. No model-authored markup is
 * ever rendered: see `core/ui/AskArtifacts.tsx` and its guard test.
 */

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

type ToolTrace = { name: string; isError: boolean; awaiting?: boolean; skipped?: boolean };
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolTrace[];
  artifacts?: ChatArtifact[];
  /** Confirm cards for what this turn parked — from the server's record. */
  pending?: ConfirmCard[];
  /** A line the drawer wrote for a button press (not typed by the user); shown as a quiet note. */
  decisionNote?: boolean;
};

/** The chip for one tool call: ran, was blocked, waits for the user, or was not attempted. */
function toolChip(t: ToolTrace): { cls: string; label: string } {
  if (t.awaiting) return { cls: ' awaiting', label: `⏳ ${t.name} · awaiting you` };
  if (t.skipped) return { cls: ' skipped', label: `– ${t.name} · not run` };
  if (t.isError) return { cls: ' blocked', label: `⚠︎ ${t.name}` };
  return { cls: '', label: `✓ ${t.name}` };
}

export default function OsAssistant() {
  const pathname = usePathname() || '/';
  const { user } = useUser();
  // What the user is looking at right now (open artifact + stage), published by the
  // active tab surface. Sent with every message so the assistant is grounded on it
  // — it's null when no surface published one, and the request is unchanged then.
  const page = usePageContext();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The server mints the conversation id on the first turn; the drawer echoes it. It scopes the
  // cards and "Allow for this conversation" to this drawer — it is not a credential.
  const conversationRef = useRef<string>('');
  // Always the latest messages / busy flag, so a follow-up sent from a button handler that
  // awaited a request does not build on a stale copy.
  const messagesRef = useRef<Msg[]>([]);
  const loadingRef = useRef(false);
  // Where each card stands, by confirmation id (the same card can sit under two messages).
  const [cardStates, setCardStates] = useState<Record<string, ConfirmCardState>>({});

  useEffect(() => { messagesRef.current = messages; }, [messages]);

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
    async (text: string, opts: { decisionNote?: boolean } = {}) => {
      const content = text.trim();
      if (!content || loadingRef.current) return;
      setError('');
      const next: Msg[] = [...messagesRef.current, { role: 'user', content, ...(opts.decisionNote ? { decisionNote: true } : {}) }];
      messagesRef.current = next;
      setMessages(next);
      if (!opts.decisionNote) setInput('');
      loadingRef.current = true;
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: pathname,
            // Text only: the cards and artifacts are the server's and are not sent back.
            messages: next.map((m) => ({ role: m.role, content: m.content })),
            pageContext: page,
            ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
          }),
          signal: ctrl.signal,
        });
        const raw = await res.text();
        const parsed = parseAgentChatResponse(res.ok, res.status, raw);
        if ('error' in parsed) {
          setError(parsed.error);
        } else {
          let tools: ToolTrace[] | undefined;
          let artifacts: ChatArtifact[] | undefined;
          let pending: ConfirmCard[] | undefined;
          try {
            const j = JSON.parse(raw);
            if (Array.isArray(j.tools)) tools = j.tools as ToolTrace[];
            if (typeof j.conversationId === 'string' && j.conversationId) conversationRef.current = j.conversationId;
            // Validated here too; a card this build cannot read is dropped, never half-rendered.
            const cards = parseConfirmCards(j.pending);
            if (cards.length > 0) pending = cards;
            // Validated client-side too: the last place that can refuse to render a kind
            // this build does not understand. An absent/malformed field degrades to none.
            const list = parseArtifacts(j);
            if (list.length > 0) artifacts = list;
          } catch {
            /* content already parsed; tools and artifacts are optional */
          }
          setMessages((m) => [...m, { role: 'assistant', content: parsed.content, tools, artifacts, pending }]);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        abortRef.current = null;
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [pathname, page],
  );

  /**
   * The user pressed a button on a Confirm card. Posts ONLY the id and the decision word; the
   * server runs its own stored copy of the call. Confirm → one follow-up turn. Cancel → none.
   */
  const decide = useCallback(
    async (card: ConfirmCard, decision: ConfirmDecision) => {
      const id = card.confirmationId;
      setCardStates((s) => ({ ...s, [id]: { kind: 'deciding', decision } }));
      const settle = (state: ConfirmCardState) => setCardStates((s) => ({ ...s, [id]: state }));
      try {
        const res = await fetch('/api/assistant/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationId: id, decision }),
        });
        const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string; summary?: string; allowedForConversation?: boolean };
        if (!res.ok) {
          if (res.status === 410) settle({ kind: 'expired' });
          else if (res.status === 404) settle({ kind: 'error', note: 'This confirmation is no longer available. Nothing was changed — ask again if you still want it.' });
          else settle({ kind: 'error', note: `${data.error || `Could not record your decision (${res.status}).`} Nothing was changed.` });
          return;
        }
        if (data.status === 'declined') {
          settle({ kind: 'declined' });
          // Kept in the conversation so the next message has it in view; nothing is sent now.
          setMessages((m) => [...m, { role: 'user', content: `I pressed Cancel on \`${card.tool}\`. It was not run.`, decisionNote: true }]);
          return;
        }
        if (data.status === 'executed') settle({ kind: 'executed', allowed: data.allowedForConversation === true });
        else if (data.status === 'failed') settle({ kind: 'failed', note: data.summary });
        else {
          settle({ kind: 'error', note: 'The server answered something this page does not understand. Check the result before asking again.' });
          return;
        }
        // ONE follow-up turn, so the assistant can report the result and carry on with the task.
        void send(`I pressed Confirm on \`${card.tool}\`. Continue.`, { decisionNote: true });
      } catch (e) {
        settle({ kind: 'error', note: `Could not reach the server (${(e as Error).message}). It may or may not have run — check before confirming again.` });
      }
    },
    [send],
  );

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
                    messages.map((m, i) => m.decisionNote ? (
                      <div key={i} className="osa-decision-note">
                        {m.content.replace(/^I pressed /, 'You pressed ').replace(/ Continue\.$/, '').replace(/`/g, '')}
                      </div>
                    ) : (
                      <div key={i} className={`bubble ${m.role}`}>
                        <div className="bubble-role">{m.role === 'user' ? 'You' : 'OS Assistant'}</div>
                        <div className="bubble-body">
                          {m.role === 'user'
                            ? m.content
                            : <Markdown>{m.content}</Markdown>}
                        </div>
                        {m.role === 'assistant' && m.artifacts ? <AskArtifacts artifacts={m.artifacts} /> : null}
                        {m.tools && m.tools.length > 0 ? (
                          <div className="osa-tools" aria-label="Governed tools invoked">
                            {m.tools.map((t, j) => {
                              const chip = toolChip(t);
                              return (
                                <span key={j} className={`chip osa-tool${chip.cls}`}>
                                  {chip.label}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                        {m.pending?.map((card) => (
                          <ConfirmActionCard
                            key={card.confirmationId}
                            card={card}
                            state={cardStates[card.confirmationId] ?? { kind: 'pending' }}
                            onDecide={(decision) => void decide(card, decision)}
                            disabled={loading}
                          />
                        ))}
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
