/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { type BetView, type BetComponent, type Tab, api } from '../types';

const TABS: Tab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];

const LIFECYCLE_LABEL: Record<string, string> = {
  building: 'In development',
  draft: 'Draft',
  certified: 'Certified',
  promoted: 'Promoted',
  published: 'Published',
  deployed: 'Deployed',
  live: 'Live',
  production: 'In production',
  'tested-governed': 'Tested & governed',
};

const TAB_LABEL: Record<Tab, string> = {
  data: 'Data product',
  metric: 'Metric',
  dashboard: 'Dashboard',
  software: 'Software app',
  agent: 'Agent',
  ml: 'ML model',
  knowledge: 'Knowledge',
  files: 'Files',
  connection: 'Connection',
};

export default function Components({ view, onMutate }: { view: BetView; onMutate: () => void }) {
  const betId = view.bet.id;
  return (
    <div>
      <div style={{ display: 'grid', gap: 10 }}>
        {view.components.map((c) => {
          const betRef = view.bet.components.find((r) => r.id === c.status.refId);
          const origin = (betRef?.origin ?? 'linked') as 'scaffolded' | 'linked';
          return (
            <ComponentRow key={c.status.refId} betId={betId} c={c} canEdit={view.canEdit} onMutate={onMutate} origin={origin} />
          );
        })}
      </div>
      {view.canEdit ? <AddComponent betId={betId} onMutate={onMutate} /> : null}
    </div>
  );
}

function ComponentRow({
  betId, c, canEdit, onMutate, origin,
}: { betId: string; c: BetComponent; canEdit: boolean; onMutate: () => void; origin: 'scaffolded' | 'linked' }) {
  const router = useRouter();
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
              ⚑ {c.status.override.note}
              {c.status.override.asserts ? <span className="muted"> (asserts {c.status.override.asserts})</span> : null}
            </div>
          ) : null}
        </div>
        {art ? <span className={`badge vis-${art.visibility}`}>{art.lifecycle}</span> : null}
      </div>

      {canEdit && art ? (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {candidates.length > 0 ? (
            <>
              <span className="muted" style={{ fontSize: 11.5 }}>Set lifecycle:</span>
              <div
                className="bb-seg"
                title="Moves the artifact through its governed lifecycle. Reaching the final stage requires Builder or Admin."
              >
                {candidates.map((l) => {
                  const isReady = l === art.readyVerb;
                  return (
                    <button
                      key={l}
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => {
                        // Reaching the ready verb ships the component AND widens a
                        // members-only artifact to the domain (OPA opens it up) —
                        // irreversible, so confirm first. Non-ready moves are one-click.
                        if (isReady && !confirm(
                          `Promote to “${LIFECYCLE_LABEL[l] ?? l}”? This ships the component and opens a members-only artifact to your domain — moving back does not re-hide it.`,
                        )) return;
                        run('adv:' + l, () => api(`/api/big-bets/${betId}/components/${ref}/advance`, 'POST', { to: l }));
                      }}
                    >
                      {busy === 'adv:' + l ? <span className="spin" /> : (LIFECYCLE_LABEL[l] ?? l)}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {origin === 'scaffolded' && art.tab === 'agent' && c.status.derived !== 'completed' ? (
            <button
              className="btn ghost sm"
              style={{ color: 'var(--teal)' }}
              onClick={() => router.push('/agents?system=new&name=' + encodeURIComponent(art.title))}
            >
              Set up in Agents →
            </button>
          ) : null}
          <button className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Add note…'}
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
          <p className="muted" style={{ fontSize: 11.5, margin: '0 0 8px' }}>A note shown alongside the derived status — it does not change the authoritative lifecycle state.</p>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (e.g. waiting on design sign-off)" />
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
              {busy === 'ovr' ? <span className="spin" /> : 'Save note'}
            </button>
            <button
              className="btn ghost sm"
              disabled={busy !== ''}
              onClick={() => run('clr', async () => {
                await api(`/api/big-bets/${betId}/components/${ref}`, 'PATCH', { override: null });
                setNote(''); setAsserts(''); setEditing(false);
              })}
            >
              Clear note
            </button>
          </div>
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 8 }}>{err}</div> : null}
    </div>
  );
}

type ArtifactOption = { id: string; title: string; lifecycle: string };

function AddComponent({ betId, onMutate }: { betId: string; onMutate: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'scaffold' | 'link'>('scaffold');
  const [tab, setTab] = useState<Tab>('data');
  const [title, setTitle] = useState('');
  const [plannedReady, setPlannedReady] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Link-mode picker state — loaded on demand from the canView-scoped endpoint.
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ArtifactOption[]>([]);
  const [fetchingCandidates, setFetchingCandidates] = useState(false);
  const [selected, setSelected] = useState<ArtifactOption | null>(null);

  // Fetch available artifacts for the current tab when in link mode.
  useEffect(() => {
    if (mode !== 'link' || !open) return;
    let live = true;
    setSelected(null);
    setSearch('');
    setCandidates([]);
    setFetchingCandidates(true);
    fetch(`/api/big-bets/${betId}/components/available?tab=${tab}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { artifacts?: ArtifactOption[] }) => { if (live) setCandidates(data.artifacts ?? []); })
      .catch(() => { if (live) setCandidates([]); })
      .finally(() => { if (live) setFetchingCandidates(false); });
    return () => { live = false; };
  }, [mode, tab, open, betId]);

  const filtered = search.trim()
    ? candidates.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : candidates;

  const valid = Boolean(
    plannedReady && (mode === 'scaffold' ? title.trim() : selected !== null),
  );

  const close = () => {
    setOpen(false);
    setTitle(''); setSelected(null); setPlannedReady('');
    setSearch(''); setErr('');
  };

  const submit = async () => {
    if (!valid || busy) return;
    setErr(''); setBusy(true);
    try {
      const body = mode === 'scaffold'
        ? { tab, scaffold: { title }, plannedReady }
        : { tab, artifactId: selected!.id, plannedReady };
      await api(`/api/big-bets/${betId}/components`, 'POST', body);
      close();
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
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
        Link a real artifact — a dataset, dashboard, agent, or model — that this bet delivers or depends on.
      </p>

      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <div className="bb-seg">
          <button type="button" className={mode === 'scaffold' ? 'active' : ''} onClick={() => setMode('scaffold')}>
            Scaffold new
          </button>
          <button type="button" className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>
            Link existing
          </button>
        </div>
        <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>
          {mode === 'scaffold'
            ? 'Creates a governed draft in its tab, tagged to this bet.'
            : 'Attaches an artifact you can already see — no copy made.'}
        </span>
      </div>

      <div style={{
        display: 'grid',
        gap: 10,
        gridTemplateColumns: mode === 'scaffold' ? '160px 1fr 170px' : '160px 170px',
      }}>
        <label style={{ display: 'block' }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Type</span>
          <select
            value={tab}
            onChange={(e) => {
              setTab(e.target.value as Tab);
              setSelected(null);
              setSearch('');
            }}
            style={{ width: '100%' }}
          >
            {TABS.map((t) => <option key={t} value={t}>{TAB_LABEL[t]}</option>)}
          </select>
        </label>

        {mode === 'scaffold' ? (
          <label style={{ display: 'block' }}>
            <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Churn data product"
            />
          </label>
        ) : null}

        <label style={{ display: 'block' }}>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Planned ready</span>
          <input type="date" value={plannedReady} onChange={(e) => setPlannedReady(e.target.value)} style={{ width: '100%' }} />
        </label>
      </div>

      {mode === 'link' ? (
        <div style={{ marginTop: 10 }}>
          {selected ? (
            <div
              className="row"
              style={{
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                background: 'var(--bg-input)',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}
            >
              <span style={{ flex: 1, fontSize: 13 }}>{selected.title}</span>
              <span className="chip" style={{ fontSize: 10 }}>{selected.lifecycle}</span>
              <button
                type="button"
                className="btn ghost sm"
                style={{ fontSize: 11 }}
                onClick={() => setSelected(null)}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${TAB_LABEL[tab].toLowerCase()}s by name…`}
                style={{ width: '100%', marginBottom: 6 }}
                autoFocus
              />
              <div style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                maxHeight: 180,
                overflowY: 'auto',
                background: 'var(--panel)',
              }}>
                {fetchingCandidates ? (
                  <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>Loading…</div>
                ) : filtered.length === 0 ? (
                  <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                    {candidates.length === 0
                      ? `No ${TAB_LABEL[tab].toLowerCase()}s visible to you yet — scaffold one instead.`
                      : 'No matches for this search.'}
                  </div>
                ) : (
                  filtered.map((a, i) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelected(a)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        padding: '7px 12px',
                        background: 'none',
                        border: 'none',
                        borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 13, color: 'var(--text)' }}>{a.title}</span>
                      <span className="chip" style={{ fontSize: 10 }}>{a.lifecycle}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}

      <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn ghost sm" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn sm" onClick={submit} disabled={!valid || busy}>
          {busy ? <span className="spin" /> : 'Add'}
        </button>
      </div>
    </div>
  );
}
