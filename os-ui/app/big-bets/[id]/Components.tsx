/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { type BetView, type BetComponent, type Tab, api } from '../types';

const TABS: Tab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];

export default function Components({ view, onMutate }: { view: BetView; onMutate: () => void }) {
  const betId = view.bet.id;
  return (
    <div>
      <div style={{ display: 'grid', gap: 10 }}>
        {view.components.map((c) => (
          <ComponentRow key={c.status.refId} betId={betId} c={c} canEdit={view.canEdit} onMutate={onMutate} />
        ))}
      </div>
      {view.canEdit ? <AddComponent betId={betId} onMutate={onMutate} /> : null}
    </div>
  );
}

function ComponentRow({
  betId, c, canEdit, onMutate,
}: { betId: string; c: BetComponent; canEdit: boolean; onMutate: () => void }) {
  const ref = c.status.refId;
  const art = c.artifact;
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(c.status.override?.note ?? '');
  const [asserts, setAsserts] = useState(c.status.override?.asserts ?? '');

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setErr(''); setBusy(key);
    try { await fn(); onMutate(); } catch (e) { setErr((e as Error).message); setBusy(''); }
  };

  const candidates = art
    ? Array.from(new Set(['building', 'draft', art.readyVerb])).filter((l) => l !== c.status.lifecycle)
    : [];
  const [to, setTo] = useState(candidates[0] ?? '');

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px', background: 'var(--panel)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{art?.title ?? '🔒 members only'}</div>
          <div className="muted mono" style={{ fontSize: 10.5, marginTop: 2 }}>
            {(art?.tab ?? '') as string} · {c.status.label}
            {c.status.blocked && c.status.blockedBy.length ? ` · blocked by ${c.status.blockedBy.length}` : ''}
          </div>
          {c.status.override?.note ? (
            <div style={{ fontSize: 11, color: 'var(--gold-text)', marginTop: 4 }}>
              ⚑ owner override: {c.status.override.note}
              {c.status.override.asserts ? <span className="muted"> (asserts {c.status.override.asserts})</span> : null}
            </div>
          ) : null}
        </div>
        {art ? <span className={`badge vis-${art.visibility}`}>{art.lifecycle}</span> : null}
      </div>

      {canEdit && art ? (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={to} onChange={(e) => setTo(e.target.value)} style={{ minWidth: 130 }}>
            {candidates.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button
            className="btn sm"
            disabled={busy !== '' || !to}
            onClick={() => run('adv', () => api(`/api/big-bets/${betId}/components/${ref}/advance`, 'POST', { to }))}
          >
            {busy === 'adv' ? <span className="spin" /> : 'Advance'}
          </button>
          <button className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close override' : 'Override…'}
          </button>
          <button
            className="btn ghost sm"
            style={{ marginLeft: 'auto' }}
            disabled={busy !== ''}
            onClick={() => {
              if (confirm('Remove this component from the bet? The artifact itself is kept.')) {
                run('del', () => api(`/api/big-bets/${betId}/components/${ref}`, 'DELETE'));
              }
            }}
          >
            Remove from bet — keeps the artifact
          </button>
        </div>
      ) : null}

      {editing && canEdit ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Override note (shown beside the derived state)" />
          <input type="text" value={asserts} onChange={(e) => setAsserts(e.target.value)} placeholder="Asserts (optional, e.g. a readiness it claims)" />
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn sm"
              disabled={busy !== '' || !note.trim()}
              onClick={() => run('ovr', async () => {
                await api(`/api/big-bets/${betId}/components/${ref}`, 'PATCH', { override: { note, asserts: asserts || undefined } });
                setEditing(false);
              })}
            >
              {busy === 'ovr' ? <span className="spin" /> : 'Save override'}
            </button>
            <button
              className="btn ghost sm"
              disabled={busy !== ''}
              onClick={() => run('clr', async () => {
                await api(`/api/big-bets/${betId}/components/${ref}`, 'PATCH', { override: null });
                setNote(''); setAsserts(''); setEditing(false);
              })}
            >
              Clear override
            </button>
          </div>
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 8 }}>{err}</div> : null}
    </div>
  );
}

function AddComponent({ betId, onMutate }: { betId: string; onMutate: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'scaffold' | 'link'>('scaffold');
  const [tab, setTab] = useState<Tab>('data');
  const [title, setTitle] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [plannedReady, setPlannedReady] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const valid = Boolean(plannedReady && (mode === 'scaffold' ? title.trim() : artifactId.trim()));

  const submit = async () => {
    if (!valid || busy) return;
    setErr(''); setBusy(true);
    try {
      const body = mode === 'scaffold'
        ? { tab, scaffold: { title }, plannedReady }
        : { tab, artifactId, plannedReady };
      await api(`/api/big-bets/${betId}/components`, 'POST', body);
      setOpen(false); setTitle(''); setArtifactId(''); setPlannedReady('');
      onMutate();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button className="btn ghost" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        + Add component
      </button>
    );
  }

  return (
    <div style={{ marginTop: 12, border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', padding: 14 }}>
      <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <div className="bb-seg">
          <button type="button" className={mode === 'scaffold' ? 'active' : ''} onClick={() => setMode('scaffold')}>Scaffold new</button>
          <button type="button" className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Link existing</button>
        </div>
        <span className="hint" style={{ margin: 0 }}>
          {mode === 'scaffold' ? 'Creates a governed draft in its tab, tagged to this bet.' : 'Reuses an existing artifact — never forks.'}
        </span>
      </div>

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '160px 1fr 170px' }}>
        <label style={{ display: 'block' }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Tab</span>
          <select value={tab} onChange={(e) => setTab(e.target.value as Tab)} style={{ width: '100%' }}>
            {TABS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={{ display: 'block' }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
            {mode === 'scaffold' ? 'Title' : 'Artifact id'}
          </span>
          {mode === 'scaffold'
            ? <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Churn data product" />
            : <input type="text" value={artifactId} onChange={(e) => setArtifactId(e.target.value)} placeholder="data_churn_mart" />}
        </label>
        <label style={{ display: 'block' }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Planned ready</span>
          <input type="date" value={plannedReady} onChange={(e) => setPlannedReady(e.target.value)} style={{ width: '100%' }} />
        </label>
      </div>

      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}

      <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn ghost sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <button className="btn sm" onClick={submit} disabled={!valid || busy}>
          {busy ? <span className="spin" /> : 'Add'}
        </button>
      </div>
    </div>
  );
}
