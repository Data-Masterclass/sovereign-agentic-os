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
};
type Groups = { mine: Tile[]; domain: Tile[]; marketplace: Tile[] };

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

function TileCard({ t, onOpen, onImport }: { t: Tile; onOpen: (id: string) => void; onImport?: (id: string) => void }) {
  // A role="button" DIV (not a <button>) so the optional Import control can be a real
  // nested <button> without invalid button-in-button nesting.
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
        <span className={`badge ${TIER_BADGE[t.tier]}`}>{TIER_WORD[t.tier]}</span>
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
          onClick={(e) => { e.stopPropagation(); onImport(t.id); }}>
          Import
        </button>
      ) : null}
    </div>
  );
}

function Group({ title, tiles, onOpen, onImport }: { title: string; tiles: Tile[]; onOpen: (id: string) => void; onImport?: (id: string) => void }) {
  if (tiles.length === 0) return null;
  return (
    <>
      <div className="section-title">{title}<span className="count-pill">{tiles.length}</span></div>
      <div className="tile-grid">
        {tiles.map((t) => <TileCard key={t.id} t={t} onOpen={onOpen} onImport={onImport} />)}
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

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch('/api/data/datasets', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load datasets'); return; }
      setGroups(data);
    } catch (e) { setErr((e as Error).message); }
  }, []);
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

  const empty = groups && groups.mine.length === 0 && groups.domain.length === 0 && groups.marketplace.length === 0;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <p className="lead" style={{ margin: 0, maxWidth: 560 }}>
          Your datasets. Open one to refine it through <strong>Bronze → Silver → Gold</strong>,
          define a metric, and share it — the tools stay in the engine room.
        </p>
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

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {empty ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          No datasets yet. <strong>+ New dataset</strong> starts one — bring a file in, and you’re at Bronze.
        </div>
      ) : null}

      {groups ? (
        <>
          <Group title="My data" tiles={groups.mine} onOpen={onOpen} />
          <Group title="Shared Data" tiles={groups.domain} onOpen={onOpen} />
          <Group title="Marketplace Data" tiles={groups.marketplace} onOpen={onOpen} onImport={canImport ? importProduct : undefined} />
        </>
      ) : !err ? <div className="stub-page" style={{ marginTop: 20 }}>Loading datasets…</div> : null}
    </>
  );
}
