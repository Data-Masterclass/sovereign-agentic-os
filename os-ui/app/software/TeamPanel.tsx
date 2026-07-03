/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };
type NodeStep = { tool: string; isError: boolean };
type NodeSummary = { node: string; model: string; steps: NodeStep[] };

/**
 * "Build with the Software Delivery Team" — the Software-tab launcher for the
 * governed 6-agent LangGraph team (orchestrator → planner → builder → tester →
 * deployer → communication). One card that expands into a turn-based chat: your
 * brief goes in, the team plans, builds and requests a deploy AS YOU (every tool
 * governed), and the communication agent narrates back. Deploy stays a human
 * Builder decision in Deploy reviews — the team only requests it.
 *
 * Same visual grammar as the build chat (sw-create card + chat-log/bubble) — no
 * new design system.
 */
export default function TeamPanel({ onBuilt }: { onBuilt?: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPath, setLastPath] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/software/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const body = (await res.json()) as { content?: string; error?: string; path?: string[]; nodes?: NodeSummary[] };
      const content = body.content ?? body.error ?? '(no reply)';
      setMessages((m) => [...m, { role: 'assistant', content }]);
      setLastPath(body.path ?? []);
      // If the builder created/committed anything, refresh the app tiles.
      const built = (body.nodes ?? []).some((n) => n.steps.some((s) => s.tool === 'create_software' || s.tool === 'commit'));
      if (built) onBuilt?.();
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `(team unreachable: ${(e as Error).message})` }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
    }
  }

  return (
    <div className={`sw-create sw-team${open ? ' is-open' : ''}`}>
      {open ? (
        <div className="sw-create-head">
          <div>
            <div className="sw-create-title">Build with the Software Delivery Team</div>
            <div className="sw-create-sub">
              A governed 6-agent team — plan, build, test, request deploy — runs as you.
              It commits real code to its own in-cluster repo; go-live still waits on a Builder review.
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="sw-create-head sw-create-trigger" onClick={() => setOpen(true)} aria-expanded={false}>
          <div>
            <div className="sw-create-title">Build with the Software Delivery Team</div>
            <div className="sw-create-sub">
              A governed 6-agent team — plan, build, test, request deploy — runs as you.
              It commits real code to its own in-cluster repo; go-live still waits on a Builder review.
            </div>
          </div>
          <span className="sw-create-go" aria-hidden="true">→</span>
        </button>
      )}

      {open ? (
        <div className="sw-create-form">
          {lastPath.length > 0 ? (
            <div className="sw-team-flow" aria-label="team phase order">
              {lastPath.map((p, i) => (
                <span key={p} className="sw-team-node">
                  {p}
                  {i < lastPath.length - 1 ? <span className="sw-team-arrow" aria-hidden="true"> → </span> : null}
                </span>
              ))}
            </div>
          ) : null}

          <div className="chat-log" ref={logRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                Describe what to build (e.g. “a renewals tracker with a table and a status filter”).
                The team plans it, builds it, and reports back — asking you questions if anything is unclear.
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  <div className="bubble-role">{m.role === 'user' ? 'You' : 'Delivery team'}</div>
                  <div className="bubble-body">{m.content}</div>
                </div>
              ))
            )}
            {busy ? (
              <div className="bubble assistant">
                <div className="bubble-role">Delivery team</div>
                <div className="bubble-body"><span className="spin" /> Planning, building and testing…</div>
              </div>
            ) : null}
          </div>

          <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'flex-end' }}>
            <textarea
              rows={2}
              value={input}
              placeholder="Describe the app to build…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
              style={{ flex: 1, resize: 'vertical' }}
              disabled={busy}
            />
            <button type="button" className="btn" onClick={send} disabled={busy || !input.trim()}>
              {busy ? <span className="spin" /> : 'Send'}
            </button>
          </div>
          <p className="sw-create-note">
            One turn at a time — reply to the team’s questions in the same chat. Deploy opens a Builder review card;
            it never goes live on its own.
          </p>
        </div>
      ) : null}
    </div>
  );
}
