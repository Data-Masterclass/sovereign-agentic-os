/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Sales Assistant worked-example pane (golden path §10). Runs the governed
 * supervisor and shows, for every turn: the answer, each sub-agent step with its
 * OPA decision + Langfuse trace id, the KPI (the same Cube metric the dashboard
 * uses), recalled/stored memory, held approvals and the run cost. Multi-turn —
 * the thread id is stable so short-term memory carries across turns.
 */

type Step = { node: string; tool: string; decision: 'allow' | 'deny' | 'requires_approval'; policy: string; summary: string; traceId?: string; costUsd: number };
type Approval = { id: string; title: string; status: string };
type Run = {
  answer: string;
  kpi: { label: string; value: number; source: string; measure: string };
  steps: Step[];
  approvals: Approval[];
  memoryRecalled: { kind: string; text: string }[];
  factStored: string | null;
  costUsd: number;
  turns: number;
  threadId: string;
};

const STARTERS = [
  'Draft a renewal email for ACME — use last quarter’s revenue and our discount policy.',
  'Now update the CRM with the renewal touch and send the email.',
  'What discount can I offer ACME again?',
];

function decisionBadge(d: Step['decision']) {
  if (d === 'allow') return <span className="badge ok">allow</span>;
  if (d === 'deny') return <span className="badge err">deny</span>;
  return <span className="badge warn">requires approval</span>;
}

export default function SalesAssistant() {
  const [runs, setRuns] = useState<{ q: string; r: Run }[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const threadId = useRef(`sales_${Math.random().toString(36).slice(2, 8)}`);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || loading) return;
      setError('');
      setInput('');
      setLoading(true);
      try {
        const res = await fetch('/api/agent/sales', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId: threadId.current, message }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Run failed');
        else setRuns((prev) => [...prev, { q: message, r: body as Run }]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        A working <strong>vertical slice</strong>: the Sales Assistant supervisor delegates to a
        data-analyst (Cube <code>metrics</code>), a librarian (<code>retrieve</code>) and a CRM
        liaison. Every step is OPA-authorized and Langfuse-traced; a CRM write is paused for a
        Builder to approve in <strong>Governance</strong>. Thread <code>{threadId.current}</code> —
        memory persists across turns.
      </p>

      {runs.length === 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {STARTERS.map((s) => (
            <button key={s} type="button" className="chip" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => send(s)}>
              {s.length > 60 ? `${s.slice(0, 60)}…` : s}
            </button>
          ))}
        </div>
      ) : null}

      {runs.map(({ q, r }, i) => (
        <div className="card" key={i} style={{ marginBottom: 16 }}>
          <div className="bubble user" style={{ marginBottom: 12 }}>
            <div className="bubble-role">You</div>
            <div className="bubble-body">{q}</div>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="badge ok">KPI {r.kpi.label}: €{r.kpi.value.toLocaleString('en-US')}</span>
            <span className="badge muted">source: {r.kpi.source}</span>
            <span className="badge muted">cost ${r.costUsd.toFixed(4)}</span>
            <span className="badge muted">memory turns: {r.turns}</span>
          </div>

          <div className="bubble assistant" style={{ marginBottom: 12 }}>
            <div className="bubble-role">Sales Assistant</div>
            <div className="bubble-body" style={{ whiteSpace: 'pre-wrap' }}>{r.answer}</div>
          </div>

          <div className="section-title" style={{ marginTop: 4 }}>Governed steps</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Sub-agent</th><th>Tool</th><th>OPA</th><th>Summary</th><th>Trace</th></tr>
              </thead>
              <tbody>
                {r.steps.map((s, j) => (
                  <tr key={j}>
                    <td className="mono">{s.node}</td>
                    <td className="mono">{s.tool}</td>
                    <td style={{ textAlign: 'center' }}>{decisionBadge(s.decision)}</td>
                    <td style={{ fontSize: 12 }}>{s.summary}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{s.traceId ? s.traceId.slice(-8) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {r.approvals.length > 0 ? (
            <div className="hint" style={{ marginTop: 10 }}>
              ⏸ Held for approval: {r.approvals.map((a) => `${a.title} (${a.id})`).join(', ')} — clear it in the Governance tab.
            </div>
          ) : null}

          {r.memoryRecalled.length > 0 ? (
            <div className="hint" style={{ marginTop: 6 }}>
              🧠 Recalled long-term memory: {r.memoryRecalled.map((m) => `[${m.kind}] ${m.text}`).join(' · ')}
            </div>
          ) : null}
          {r.factStored ? (
            <div className="hint" style={{ marginTop: 6 }}>💾 Stored (proposed) fact: {r.factStored}</div>
          ) : null}
        </div>
      ))}

      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} style={{ marginTop: 12 }}>
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the Sales Assistant… e.g. Draft a renewal email for ACME."
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); } }}
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send.</div>
          <button className="btn" type="submit" disabled={loading || !input.trim()}>
            {loading ? <span className="spin" /> : 'Run'}
          </button>
        </div>
      </form>
    </div>
  );
}
