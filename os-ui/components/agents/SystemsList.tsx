/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { useUser } from '@/lib/useUser';
import NewSystemPanel from './NewSystemPanel';
import { roleAtLeast } from '@/lib/session';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/scopes';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility } from '@/lib/lifecycle';

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
  /** A Personal→Shared promotion is filed but not yet approved (governed). */
  pendingShare?: boolean;
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
};
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[] };

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');

/** Systems visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (v: Summary['visibility']): Visibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

export default function SystemsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const [scope, setScope] = useState<ScopeKey>('all');
  const { data, loading, error, reload } = useApi<Groups>(`/api/agents/systems${showArchived ? '?archived=1' : ''}`);
  const { user } = useUser();
  // Installing a Marketplace template is a Builder+ action (mirrors the promotion
  // ladder). Show the gate up front instead of letting the click 403.
  const canInstall = !!user && roleAtLeast(user.role, 'builder');
  const [actErr, setActErr] = useState('');

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

  // A system is the caller's to manage when it's in the "Mine" group (owner) or
  // the caller is an in-domain Admin (the server enforces this either way).
  const canManage = (s: Summary) => !!user && (s.owner === user.id || (user.role === 'admin' && user.domains.includes(s.domain)));

  const card = (s: Summary, kind: 'open' | 'install') => (
    <div className="card" key={s.id}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, textTransform: 'none', letterSpacing: 0, color: 'var(--text)' }}>{s.name}</h3>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {s.archived ? <span className="badge muted">archived</span> : null}
          <span className={`badge ${visClass(s.visibility)}`}>{s.visibility}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <span className={`badge ${s.running ? 'ok' : 'muted'}`}>{s.running ? 'running' : 'stopped'}</span>
        {s.scheduled ? <span className="badge warn">scheduled</span> : null}
        {s.pendingShare ? (
          <span className="badge warn" title="You filed a Personal→Shared promotion — it stays Personal until a Builder or Admin approves it.">⏳ pending share approval</span>
        ) : null}
        <span className="badge muted">{s.agentCount} agent{s.agentCount === 1 ? '' : 's'}</span>
      </div>
      <div className="muted mono" style={{ marginTop: 10, fontSize: 11.5 }}>
        owner {s.owner} · {s.domain}
        {s.lastActivity ? <> · active {new Date(s.lastActivity).toLocaleDateString()}</> : ''}
      </div>
      <div className="comp-actions" style={{ marginTop: 12, flexWrap: 'wrap', gap: 6 }}>
        {kind === 'install' ? (
          canInstall ? (
            <button className="btn sm" onClick={() => fork(s.id)}>Install (fork-to-own)</button>
          ) : (
            <button className="btn sm" disabled title="Installing a template needs a Builder or Admin">Builder+ to install</button>
          )
        ) : (
          <>
            {!s.archived ? <button className="btn sm" onClick={() => onOpen(s.id)}>Open</button> : null}
            {canManage(s) ? (
              <LifecycleActions
                id={s.id}
                name={s.name}
                kind="agent"
                visibility={lcVis(s.visibility)}
                archived={!!s.archived}
                api={`/api/agents/systems/${s.id}`}
                onChanged={reload}
                compact
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  const uid = user?.id ?? '';
  const scoped = data ? groupByScope(data, uid) : null;
  const counts = data ? scopeCounts(data, uid) : null;
  const visible = scoped ? scoped[scope] : [];
  // A card is "install" (fork-to-own) only for a Marketplace system the caller
  // does NOT already own; everything else opens in place.
  const kindFor = (s: Summary): 'open' | 'install' =>
    s.visibility === 'Marketplace' && s.owner !== uid ? 'install' : 'open';

  return (
    <ConfirmProvider>
    <div className="systems-list">
      <div style={{ marginBottom: 18 }}>
        <NewSystemPanel onCreated={onOpen} />
      </div>

      {actErr ? <div className="error" style={{ marginBottom: 12 }}>{actErr}</div> : null}

      <div className="section-title">
        Systems
        <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
          <button
            className="btn ghost"
            style={{ padding: '4px 12px', opacity: showArchived ? 1 : 0.7 }}
            onClick={() => setShowArchived((v) => !v)}
            title="Archived systems are hidden by default"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <button className="btn ghost" style={{ padding: '4px 12px' }} onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {data ? (
        <>
          {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
          <div className="seg" style={{ marginBottom: 16 }}>
            {SCOPE_GROUPS.map((g) => (
              <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
                {g.label('Agents')}{counts ? ` (${counts[g.key]})` : ''}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <div className="stub-page" style={{ padding: 24 }}>
              {scope === 'mine' || scope === 'all'
                ? 'No agent systems yet — create one above.'
                : scope === 'shared' ? 'Nothing shared in your domain yet.' : 'Nothing in the marketplace yet.'}
            </div>
          ) : (
            <div className="grid">{visible.map((s) => card(s, kindFor(s)))}</div>
          )}
        </>
      ) : loading ? (
        <div className="stub-page"><span className="spin" /> Loading systems…</div>
      ) : null}
    </div>
    </ConfirmProvider>
  );
}
