/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

/**
 * Level 1 — the systems list (landing). Grouped Mine / My domain / Marketplace,
 * each card showing status (running/stopped/scheduled), agent count, owner and
 * visibility. New system lands under Mine; a Marketplace install is a fork-to-own
 * independent copy you then open and edit.
 */

type Summary = {
  id: string; name: string; domain: string; owner: string;
  visibility: 'Personal' | 'Shared' | 'Marketplace';
  origin: 'authored' | 'forked';
  running: boolean; scheduled: boolean; agentCount: number; lastActivity: string | null;
};
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[] };

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');

export default function SystemsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, loading, error, reload } = useApi<Groups>('/api/agents/systems');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [actErr, setActErr] = useState('');

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setActErr('');
    try {
      const res = await fetch('/api/agents/systems', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not create the system');
      setName('');
      onOpen(body.id);
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const fork = async (id: string) => {
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}/fork`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Install failed');
      onOpen(body.id);
    } catch (e) {
      setActErr((e as Error).message);
    }
  };

  const card = (s: Summary, kind: 'open' | 'install') => (
    <div className="card" key={s.id}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0, fontSize: 14, textTransform: 'none', letterSpacing: 0, color: 'var(--text)' }}>{s.name}</h3>
        <span className={`badge ${visClass(s.visibility)}`}>{s.visibility}</span>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <span className={`badge ${s.running ? 'ok' : 'muted'}`}>{s.running ? 'running' : 'stopped'}</span>
        {s.scheduled ? <span className="badge warn">scheduled</span> : null}
        <span className="badge muted">{s.agentCount} agent{s.agentCount === 1 ? '' : 's'}</span>
      </div>
      <div className="muted mono" style={{ marginTop: 10, fontSize: 11.5 }}>
        owner {s.owner} · {s.domain}
        {s.lastActivity ? <> · active {new Date(s.lastActivity).toLocaleDateString()}</> : ''}
      </div>
      <div className="comp-actions" style={{ marginTop: 12 }}>
        {kind === 'install' ? (
          <button className="btn sm" onClick={() => fork(s.id)}>Install (fork-to-own)</button>
        ) : (
          <button className="btn sm" onClick={() => onOpen(s.id)}>Open</button>
        )}
      </div>
    </div>
  );

  const group = (title: string, sub: string, items: Summary[], kind: 'open' | 'install') => (
    <>
      <div className="group-head">
        <span className="group-heading">{title}</span>
        <span className="group-sub">{sub}</span>
      </div>
      {items.length === 0 ? (
        <div className="stub-page" style={{ padding: 24 }}>Nothing here yet.</div>
      ) : (
        <div className="grid">{items.map((s) => card(s, kind))}</div>
      )}
    </>
  );

  return (
    <div className="systems-list">
      <div className="card" style={{ marginBottom: 18 }} {...anchorAttr(ANCHORS.agents.define)}>
        <h3 style={{ marginTop: 0 }}>New agent system</h3>
        <p className="hint" style={{ marginTop: 0 }}>A solo agent is just a system of one. It lands under Mine with a starter graph.</p>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            placeholder="e.g. Renewals desk"
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={create} disabled={creating || !name.trim()}>{creating ? <span className="spin" /> : 'Create'}</button>
        </div>
      </div>

      {actErr ? <div className="error" style={{ marginBottom: 12 }}>{actErr}</div> : null}

      <div className="section-title">
        Systems
        <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 12px' }} onClick={reload} disabled={loading}>
          {loading ? <span className="spin" /> : 'Refresh'}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {data ? (
        <>
          {group('Mine', 'systems you own', data.mine, 'open')}
          {group('My domain', 'shared with your domain', data.domain, 'open')}
          {group('Marketplace', 'install a copy you own', data.marketplace, 'install')}
        </>
      ) : loading ? (
        <div className="stub-page"><span className="spin" /> Loading systems…</div>
      ) : null}
    </div>
  );
}
