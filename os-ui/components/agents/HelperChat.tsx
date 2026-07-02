/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * The agent-system helper (Task 8) — dual-mode #2. It turns a natural-language
 * instruction into a STRUCTURED edit of the SAME system.yaml the canvas + Monaco
 * edit (committed through the store's whitelisted file write), so a subsequent
 * Build runs the SAME orchestrator — no separate code path. Ingested instructions
 * are treated as DATA, and any synthesised sub-agent is narrowed to a subset of the
 * system grants (the compiler enforces narrow-only regardless).
 */

type Turn = { instruction: string; summary?: string; error?: string; stopped?: boolean };

const STARTERS = [
  'add a research sub-agent that hands off to the writer',
  'add a writer sub-agent',
];

export default function HelperChat({ systemId, canEdit, onApplied }: { systemId: string; canEdit: boolean; onApplied: () => void | Promise<void> }) {
  const [log, setLog] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const instruction = text.trim();
      if (!instruction || busy) return;
      setBusy(true);
      setInput('');
      const idx = log.length;
      setLog((l) => [...l, { instruction }]);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/agents/systems/${systemId}/assistant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instruction }),
          signal: ctrl.signal,
        });
        // Read defensively: a wedged model can return a non-JSON body, and
        // res.json() would throw "The string did not match the expected pattern."
        const raw = await res.text();
        let body: { error?: string; summary?: string } = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        if (!res.ok) {
          setLog((l) => l.map((t, i) => (i === idx ? { ...t, error: body.error ?? 'The helper could not apply that.' } : t)));
        } else {
          setLog((l) => l.map((t, i) => (i === idx ? { ...t, summary: body.summary ?? 'Applied.' } : t)));
          await onApplied();
        }
      } catch (e) {
        // A user-initiated Stop is a quiet cancel, not an error.
        if ((e as Error).name === 'AbortError') {
          setLog((l) => l.map((t, i) => (i === idx ? { ...t, stopped: true } : t)));
        } else {
          setLog((l) => l.map((t, i) => (i === idx ? { ...t, error: (e as Error).message } : t)));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, log.length, systemId, onApplied],
  );

  return (
    <div className="chat">
      <div className="chat-log" style={{ minHeight: 200 }}>
        {log.length === 0 ? (
          <div className="chat-empty">
            Ask the agent-system helper to edit this system. It writes the SAME system.yaml the canvas
            and Monaco edit — then press Build to execute + verify.
          </div>
        ) : (
          log.map((t, i) => (
            <div key={i}>
              <div className="bubble user"><div className="bubble-role">You</div><div className="bubble-body">{t.instruction}</div></div>
              {t.summary ? (
                <div className="bubble assistant" style={{ marginTop: 8 }}>
                  <div className="bubble-role">agent-system helper</div>
                  <div className="bubble-body">✓ {t.summary}</div>
                </div>
              ) : t.error ? (
                <div className="bubble assistant" style={{ marginTop: 8 }}>
                  <div className="bubble-role">agent-system helper</div>
                  <div className="bubble-body b-off">✗ {t.error}</div>
                </div>
              ) : t.stopped ? (
                <div className="bubble assistant" style={{ marginTop: 8 }}>
                  <div className="bubble-role">agent-system helper</div>
                  <div className="bubble-body muted">Stopped.</div>
                </div>
              ) : (
                <div className="bubble assistant" style={{ marginTop: 8 }}>
                  <div className="bubble-role">agent-system helper</div>
                  <div className="bubble-body row" style={{ gap: 8, alignItems: 'center' }}>
                    <span className="spin" />
                    <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>Stop</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {log.length === 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {STARTERS.map((s) => (
            <button key={s} type="button" className="chip" style={{ cursor: 'pointer', background: 'transparent' }} disabled={!canEdit} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      ) : null}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} style={{ marginTop: 12 }}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={canEdit ? 'e.g. add a research sub-agent that hands off to the writer' : 'Read-only — you cannot edit this system'}
          disabled={!canEdit}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); } }}
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send. Deterministic edits, governed like every agent.</div>
          {busy ? (
            <button className="btn ghost sm" type="button" onClick={stop}>Stop</button>
          ) : (
            <button className="btn sm" type="submit" disabled={!input.trim() || !canEdit}>Apply</button>
          )}
        </div>
      </form>
    </div>
  );
}
