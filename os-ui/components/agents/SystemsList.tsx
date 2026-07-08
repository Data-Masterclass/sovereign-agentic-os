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

/** One row of a system's version history (from GET …/versions). */
type VersionRow = { version: number; at: string; author: string; summary: string };

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');

export default function SystemsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const [scope, setScope] = useState<ScopeKey>('all');
  const { data, loading, error, reload } = useApi<Groups>(`/api/agents/systems${showArchived ? '?archived=1' : ''}`);
  const { user } = useUser();
  // Installing a Marketplace template is a Builder+ action (mirrors the promotion
  // ladder). Show the gate up front instead of letting the click 403.
  const canInstall = !!user && roleAtLeast(user.role, 'builder');
  const [actErr, setActErr] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [historyId, setHistoryId] = useState('');
  const [versionsList, setVersionsList] = useState<VersionRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

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

  // archive / unarchive (POST {action}) or delete (DELETE), then refresh.
  const lifecycle = async (id: string, req: RequestInit) => {
    setBusyId(id);
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}`, req);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Action failed');
      }
      setConfirmDeleteId('');
      await reload();
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setBusyId('');
    }
  };
  const setArchived = (id: string, archived: boolean) =>
    lifecycle(id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: archived ? 'archive' : 'unarchive' }) });
  const del = (id: string) => lifecycle(id, { method: 'DELETE' });

  const fetchHistory = async (id: string) => {
    setLoadingHistory(true);
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}/versions`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Failed to load history');
      setVersionsList(body.versions ?? []);
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setLoadingHistory(false);
    }
  };
  const toggleHistory = async (id: string) => {
    if (historyId === id) { setHistoryId(''); return; }
    setHistoryId(id);
    setVersionsList([]);
    await fetchHistory(id);
  };
  const restoreVersion = async (id: string, version: number) => {
    setBusyId(id);
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}/versions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Restore failed');
      }
      await fetchHistory(id);
    } catch (e) {
      setActErr((e as Error).message);
    } finally {
      setBusyId('');
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
              <>
                <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => toggleHistory(s.id)}>
                  {historyId === s.id ? 'Hide history' : 'History'}
                </button>
                {s.archived ? (
                  <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => setArchived(s.id, false)}>
                    {busyId === s.id ? <span className="spin" /> : 'Restore'}
                  </button>
                ) : (
                  <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => setArchived(s.id, true)} title="Archive stops + hides the system (reversible)">
                    Archive
                  </button>
                )}
                {confirmDeleteId === s.id ? (
                  <>
                    <button className="btn sm" style={{ background: 'var(--danger, #b42318)' }} disabled={busyId === s.id} onClick={() => del(s.id)}>
                      {busyId === s.id ? <span className="spin" /> : 'Confirm delete'}
                    </button>
                    <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => setConfirmDeleteId('')}>Cancel</button>
                  </>
                ) : (
                  <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => setConfirmDeleteId(s.id)}>Delete</button>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
      {historyId === s.id ? (
        <div className="card" style={{ marginTop: 10, background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>Version history — restore any prior version (creates a new version).</div>
          {loadingHistory ? (
            <div className="muted"><span className="spin" /> Loading…</div>
          ) : versionsList.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No prior versions yet — the first edit captures one.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {versionsList.map((v) => (
                <div className="row" key={v.version} style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    v{v.version} · {v.summary} · {v.author} · {new Date(v.at).toLocaleString()}
                  </span>
                  <button className="btn sm ghost" disabled={busyId === s.id} onClick={() => restoreVersion(s.id, v.version)}>Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
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
  );
}
