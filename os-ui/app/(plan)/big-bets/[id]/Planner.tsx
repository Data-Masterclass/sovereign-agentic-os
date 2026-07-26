/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { type ProposedPlan, api } from '../types';
import { Segmented } from '../ui';

type Mode = 'in-tab' | 'autonomous';

/**
 * The Big Bet planner. It proposes a dated breakdown, then — on human approval —
 * scaffolds each step as a governed draft via its tab. It never self-promotes:
 * a human Builder/Admin advances drafts to ready.
 */
export default function Planner({ betId, onMutate }: { betId: string; onMutate: () => void }) {
  const [goal, setGoal] = useState('');
  const [plan, setPlan] = useState<ProposedPlan | null>(null);
  const [mode, setMode] = useState<Mode>('in-tab');
  const [kickoff, setKickoff] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  const propose = async () => {
    if (!goal.trim()) return;
    setErr(''); setDone(''); setBusy('propose');
    try {
      setPlan((await api(`/api/big-bets/${betId}/planner`, 'POST', { action: 'propose', goal })) as ProposedPlan);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  };

  const approve = async () => {
    if (!plan) return;
    setErr(''); setDone(''); setBusy('approve');
    try {
      await api(`/api/big-bets/${betId}/planner`, 'POST', { action: 'approve', plan, mode, kickoff: kickoff || undefined });
      setDone(`Scaffolded ${plan.steps.length} draft component${plan.steps.length === 1 ? '' : 's'}. Promote each from the roadmap when ready.`);
      setPlan(null); setGoal('');
      onMutate();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        The planner <strong>proposes and scaffolds drafts</strong> through each tab&rsquo;s governed flow.
        It never promotes — a human Builder or Admin advances a draft to ready.
      </p>

      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 260 }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Goal</span>
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Reduce churn for at-risk DACH accounts"
            onKeyDown={(e) => { if (e.key === 'Enter') propose(); }}
          />
        </label>
        <button className="btn" onClick={propose} disabled={busy !== '' || !goal.trim()}>
          {busy === 'propose' ? <span className="spin" /> : 'Propose plan'}
        </button>
      </div>

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}
      {done ? <div className="badge ok" style={{ marginTop: 12, display: 'inline-block' }}>{done}</div> : null}

      {plan ? (
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Proposed roadmap · template <span className="mono">{plan.template}</span>
          </div>
          {plan.steps.map((s, i) => (
            <div className="bb-step" key={i}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <div>
                  <span className="mono muted" style={{ fontSize: 11 }}>{i + 1}.</span>{' '}
                  <strong style={{ fontSize: 13 }}>{s.title}</strong>{' '}
                  <span className="chip">{s.tab}</span>
                </div>
                <span className="muted mono" style={{ fontSize: 11 }}>+{s.offsetDays}d</span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{s.rationale}</div>
              {s.dependsOn.length ? (
                <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                  after step{s.dependsOn.length > 1 ? 's' : ''} {s.dependsOn.map((d) => d + 1).join(', ')}
                </div>
              ) : null}
            </div>
          ))}

          <div className="row" style={{ gap: 14, marginTop: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Mode</span>
              <Segmented<Mode>
                value={mode}
                onChange={setMode}
                options={[{ value: 'in-tab', label: 'In-tab' }, { value: 'autonomous', label: 'Autonomous' }]}
              />
            </div>
            <label>
              <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Kickoff</span>
              <input type="date" value={kickoff} onChange={(e) => setKickoff(e.target.value)} />
            </label>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={approve} disabled={busy !== ''}>
              {busy === 'approve' ? <span className="spin" /> : 'Approve & scaffold'}
            </button>
          </div>
          <p className="hint">
            {mode === 'in-tab'
              ? 'In-tab: drafts open in each tab for a human to build.'
              : 'Autonomous: each tab’s agent builds the draft, then waits for human promotion.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
