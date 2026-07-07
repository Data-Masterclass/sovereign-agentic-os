/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/session';

/** Mirrors lib/data/store `DatasetSummary`. */
type Tile = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  visibility: string;
  freshness: string | null;
  quality: 'unknown' | 'passing' | 'failing';
  dots: { bronze: boolean; silver: boolean; gold: boolean };
  storage: string;
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
};
type Groups = { mine: Tile[]; domain: Tile[]; marketplace: Tile[] };

/** The per-card lifecycle controls (archive / restore / confirm-delete). */
type Manage = {
  archived: boolean;
  busy: boolean;
  confirmingDelete: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

function freshLabel(iso: string | null): string {
  if (!iso) return 'not built yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'recently';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 30) return `updated ${days}d ago`;
  return `updated ${d.toLocaleDateString()}`;
}

const TIER_BADGE: Record<Tile['tier'], string> = { dataset: 'vis-personal', asset: 'vis-shared', product: 'vis-certified' };
const TIER_WORD: Record<Tile['tier'], string> = { dataset: 'Dataset', asset: 'Data asset', product: 'Data product' };

/** The B/S/G refinement dots on a tile — one logical dataset, three versions. */
function Dots({ dots }: { dots: Tile['dots'] }) {
  return (
    <div className="bsg-dots" title="Bronze · Silver · Gold">
      <span className={`bsg-dot${dots.bronze ? ' on b' : ''}`} />
      <span className={`bsg-dot${dots.silver ? ' on s' : ''}`} />
      <span className={`bsg-dot${dots.gold ? ' on g' : ''}`} />
    </div>
  );
}

function TileCard({ t, onOpen, onImport, manage }: { t: Tile; onOpen: (id: string) => void; onImport?: (id: string) => void; manage?: Manage }) {
  // A role="button" DIV (not a <button>) so the optional Import / lifecycle controls
  // can be real nested <button>s without invalid button-in-button nesting. Every
  // nested control stops propagation so it never also opens the card.
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div
      role="button"
      tabIndex={0}
      className="card tile"
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}
      title="Click to open"
    >
      <div className="tile-top">
        <span className="tile-name">{t.name}</span>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {t.archived ? <span className="badge muted">archived</span> : null}
          <span className={`badge ${TIER_BADGE[t.tier]}`}>{TIER_WORD[t.tier]}</span>
        </div>
      </div>
      <div className="tile-meta">
        <span className="muted">{t.owner}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{freshLabel(t.freshness)}</span>
      </div>
      <div className="tile-foot">
        <span className={`quality-badge q-${t.quality}`}>
          {t.quality === 'passing' ? '✓ healthy' : t.quality === 'failing' ? '✗ failing' : 'no checks yet'}
        </span>
        <Dots dots={t.dots} />
      </div>
      {onImport ? (
        <button type="button" className="tile-action btn ghost sm"
          onClick={stop(() => onImport(t.id))}>
          Import
        </button>
      ) : null}
      {manage ? (
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {manage.archived ? (
            <>
              <button type="button" className="btn ghost sm" disabled={manage.busy} onClick={stop(manage.onRestore)}>
                {manage.busy ? <span className="spin" /> : 'Restore'}
              </button>
              {manage.confirmingDelete ? (
                <>
                  <button type="button" className="btn ghost sm" style={{ color: 'var(--danger, #b42318)', borderColor: 'var(--danger, #b42318)' }} disabled={manage.busy} onClick={stop(manage.onConfirmDelete)}>
                    {manage.busy ? <span className="spin" /> : 'Confirm delete'}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={manage.busy} onClick={stop(manage.onCancelDelete)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn ghost sm" disabled={manage.busy} onClick={stop(manage.onAskDelete)}>Delete</button>
              )}
            </>
          ) : (
            <button type="button" className="btn ghost sm" disabled={manage.busy} onClick={stop(manage.onArchive)} title="Archive hides the dataset (reversible)">
              {manage.busy ? <span className="spin" /> : 'Archive'}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Group({ title, tiles, onOpen, onImport, manageFor }: {
  title: string;
  tiles: Tile[];
  onOpen: (id: string) => void;
  onImport?: (id: string) => void;
  manageFor?: (t: Tile) => Manage | undefined;
}) {
  if (tiles.length === 0) return null;
  return (
    <>
      <div className="section-title">{title}<span className="count-pill">{tiles.length}</span></div>
      <div className="tile-grid">
        {tiles.map((t) => <TileCard key={t.id} t={t} onOpen={onOpen} onImport={onImport} manage={manageFor?.(t)} />)}
      </div>
    </>
  );
}

export default function DatasetTiles({ onOpen }: { onOpen: (id: string) => void }) {
  const { user } = useUser();
  // Importing a marketplace product grants the WHOLE domain read access, so the store
  // gates it to Builder/Admin (store.importProduct 403s others). Only surface Import to
  // those roles — no dead control (mirrors CertifyPanel's "no dead controls").
  const canImport = !!user && roleAtLeast(user.role, 'builder');
  const [groups, setGroups] = useState<Groups | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // Archive/lifecycle UI (mirrors the Knowledge tab's reference pattern).
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  const refresh = useCallback(async () => {
    setErr('');
    try {
      // ?archived=1 additionally returns soft-archived datasets (their own section).
      const res = await fetch(`/api/data/datasets${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load datasets'); return; }
      setGroups(data);
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived]);
  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setErr('');
    try {
      const res = await fetch('/api/data/datasets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not create'); return; }
      setNewName(''); setCreating(false);
      onOpen(data.dataset.id); // navigates to the new dataset's detail view
    } catch (e) { setErr((e as Error).message); }
  }, [newName, onOpen]);

  const importProduct = useCallback(async (id: string) => {
    setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${id}/import`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Import failed'); return; }
      refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh]);

  // archive / unarchive (POST {action}) or delete (DELETE), then refresh.
  const lifecycle = useCallback(async (id: string, req: RequestInit) => {
    setBusyId(id);
    setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${id}`, req);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Action failed');
      }
      setConfirmDeleteId('');
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusyId(''); }
  }, [refresh]);
  const setArchived = useCallback((id: string, archived: boolean) =>
    lifecycle(id, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: archived ? 'archive' : 'unarchive' }) }), [lifecycle]);
  const del = useCallback((id: string) => lifecycle(id, { method: 'DELETE' }), [lifecycle]);

  // A dataset is the caller's to manage when they own it or are an in-domain Admin
  // (the server enforces this either way — this only decides whether to show controls).
  const canManage = useCallback((t: Tile) =>
    !!user && (t.owner === user.id || (user.role === 'admin' && user.domains.includes(t.domain))), [user]);
  const manageFor = useCallback((t: Tile): Manage | undefined => {
    if (!canManage(t)) return undefined;
    return {
      archived: !!t.archived,
      busy: busyId === t.id,
      confirmingDelete: confirmDeleteId === t.id,
      onArchive: () => setArchived(t.id, true),
      onRestore: () => setArchived(t.id, false),
      onAskDelete: () => setConfirmDeleteId(t.id),
      onConfirmDelete: () => del(t.id),
      onCancelDelete: () => setConfirmDeleteId(''),
    };
  }, [canManage, busyId, confirmDeleteId, setArchived, del]);

  // Split active (working lists) from archived (their own section, like Knowledge).
  const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
  const archivedTiles = all.filter((t) => t.archived);
  const activeMine = groups?.mine.filter((t) => !t.archived) ?? [];
  const activeDomain = groups?.domain.filter((t) => !t.archived) ?? [];
  const activeMarketplace = groups?.marketplace.filter((t) => !t.archived) ?? [];
  const empty = groups && activeMine.length === 0 && activeDomain.length === 0 && activeMarketplace.length === 0;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <p className="lead" style={{ margin: 0, maxWidth: 560 }}>
          Your datasets. Open one to refine it through <strong>Bronze → Silver → Gold</strong>,
          define a metric, and share it — the tools stay in the engine room.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn ghost"
            style={{ opacity: showArchived ? 1 : 0.7 }}
            onClick={() => setShowArchived((v) => !v)}
            title="Archived datasets are hidden by default"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {creating ? (
            <div className="row" style={{ gap: 8 }}>
              <input autoFocus value={newName} placeholder="Dataset name" onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false); }} />
              <button className="btn" onClick={create} disabled={!newName.trim()}>Create</button>
              <button className="btn ghost" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
            </div>
          ) : (
            <button className="btn" onClick={() => setCreating(true)}>+ New dataset</button>
          )}
        </div>
      </div>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {empty ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          No datasets yet. <strong>+ New dataset</strong> starts one — bring a file in, and you’re at Bronze.
        </div>
      ) : null}

      {groups ? (
        <>
          <Group title="My data" tiles={activeMine} onOpen={onOpen} manageFor={manageFor} />
          <Group title="Shared Data" tiles={activeDomain} onOpen={onOpen} manageFor={manageFor} />
          <Group title="Marketplace Data" tiles={activeMarketplace} onOpen={onOpen} onImport={canImport ? importProduct : undefined} manageFor={manageFor} />

          {showArchived ? (
            archivedTiles.length > 0 ? (
              <>
                <div className="section-title">Archived<span className="count-pill">{archivedTiles.length}</span></div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  Archived datasets are hidden from the working lists. Restore brings one back; Delete removes it permanently.
                </p>
                <div className="tile-grid">
                  {archivedTiles.map((t) => <TileCard key={t.id} t={t} onOpen={onOpen} manage={manageFor(t)} />)}
                </div>
              </>
            ) : (
              <div className="hint" style={{ marginTop: 16 }}>No archived datasets.</div>
            )
          ) : null}
        </>
      ) : !err ? <div className="stub-page" style={{ marginTop: 20 }}>Loading datasets…</div> : null}
    </>
  );
}
