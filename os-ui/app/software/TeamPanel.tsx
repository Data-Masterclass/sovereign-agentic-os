/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * "Build with the Software Delivery Team" — the Software-tab launcher for the
 * governed team, rebuilt as an INTERACTIVE, phase-driven conversation. One turn
 * runs ONE role-agent (the phase router picks it): the team asks clarifying
 * questions BEFORE building, you approve a plan, it commits real code, and you
 * iterate as diff commits — every tool governed, run AS YOU. Progress STREAMS
 * (SSE) live: the current phase + each tool step, so it never looks silent, and a
 * failure shows its REAL cause (timeout · budget · model · offline), never a
 * catch-all. Deploy stays a human Builder decision in Deploy reviews.
 *
 * Same visual grammar as the build chat (sw-create card + chat-log/bubble) — no
 * new design system.
 */
const PHASE_LABEL: Record<string, string> = {
  intake: 'Understanding the brief',
  plan: 'Proposing a plan',
  build: 'Building & committing',
  feedback: 'Applying your feedback',
  deploy: 'Requesting deploy review',
  done: 'Done',
};

export default function TeamPanel({ onBuilt }: { onBuilt?: () => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [progress, setProgress] = useState<string>('');
  const logRef = useRef<HTMLDivElement>(null);

  function scrollLog() {
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }

  async function turn(text: string) {
    if (!text || busy) return;
    // A fresh conversation resets the persisted server session (phase → intake),
    // so a new brief never lands mid-phase from a previous build.
    const reset = messages.length === 0;
    const next: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setProgress('');
    let builtSomething = false;
    try {
      const res = await fetch('/api/software/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next, reset }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        setMessages((m) => [...m, { role: 'assistant', content: `(team unreachable: ${body.error ?? res.status})` }]);
        return;
      }
      // Parse the SSE stream event-by-event so the user sees live progress.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!evLine || !dataLine) continue;
          const event = evLine.slice(6).trim();
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (event === 'phase') {
            setPhase(String(data.phase ?? ''));
            setProgress(PHASE_LABEL[String(data.phase)] ?? String(data.role ?? '') + '…');
          } else if (event === 'step') {
            const tool = String(data.tool ?? '');
            if (tool === 'create_software' || tool === 'commit') builtSomething = true;
            setProgress(`${data.isError ? '⚠︎' : '✓'} ${tool}`);
          } else if (event === 'message') {
            setPhase(String(data.phase ?? ''));
            setMessages((m) => [...m, { role: 'assistant', content: String(data.content ?? '(no reply)') }]);
          } else if (event === 'error') {
            const kind = String(data.kind ?? 'error');
            setMessages((m) => [...m, { role: 'assistant', content: `⚠︎ ${data.message} (${kind})` }]);
          }
          scrollLog();
        }
      }
      if (builtSomething) onBuilt?.();
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `(team unreachable: ${(e as Error).message})` }]);
    } finally {
      setBusy(false);
      setProgress('');
      scrollLog();
    }
  }

  return (
    <div className={`sw-create sw-team${open ? ' is-open' : ''}`}>
      {open ? (
        <div className="sw-create-head">
          <div>
            <div className="sw-create-title">Build with the Software Delivery Team</div>
            <div className="sw-create-sub">
              A governed team — it asks questions, plans, builds and requests deploy — runs as you.
              It commits real code to its own in-cluster repo; go-live still waits on a Builder review.
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="sw-create-head sw-create-trigger" onClick={() => setOpen(true)} aria-expanded={false}>
          <div>
            <div className="sw-create-title">Build with the Software Delivery Team</div>
            <div className="sw-create-sub">
              A governed team — it asks questions, plans, builds and requests deploy — runs as you.
              It commits real code to its own in-cluster repo; go-live still waits on a Builder review.
            </div>
          </div>
          <span className="sw-create-go" aria-hidden="true">→</span>
        </button>
      )}

      {open ? (
        <div className="sw-create-form">
          {phase ? (
            <div className="sw-team-flow" aria-label="current phase">
              <span className="sw-team-node">{PHASE_LABEL[phase] ?? phase}</span>
            </div>
          ) : null}

          <div className="chat-log" ref={logRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                Describe what to build (e.g. “a renewals tracker with a table and a status filter”).
                The team asks anything unclear first, proposes a plan for you to approve, then builds it.
                <br />
                <em>Preview and live deploy are pending the in-cluster runner (next release); build + commit are real.</em>
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
                <div className="bubble-body"><span className="spin" /> {progress || 'Working…'}</div>
              </div>
            ) : null}
          </div>

          {phase === 'plan' && !busy ? (
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button type="button" className="btn" onClick={() => turn('Approve — build it')}>
                Approve plan & build
              </button>
              <span className="sw-create-note" style={{ margin: 0 }}>or reply below with changes to the plan.</span>
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'flex-end' }}>
            <textarea
              rows={2}
              value={input}
              placeholder="Describe the app, answer a question, or give feedback…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) turn(input.trim());
              }}
              style={{ flex: 1, resize: 'vertical' }}
              disabled={busy}
            />
            <button type="button" className="btn" onClick={() => turn(input.trim())} disabled={busy || !input.trim()}>
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
