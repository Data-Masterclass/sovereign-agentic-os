/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { DATASET_SCOPES, tilesForScope, scopeCounts, type DatasetScope } from '@/lib/data/dataset-scopes';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import DomainTag from '@/components/DomainTag';
import type { Visibility } from '@/lib/core/lifecycle';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import WarehouseImportPanel, { type WarehouseConn } from './WarehouseImportPanel';

/** Mirrors lib/data/store `DatasetSummary`. */
type Tile = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  visibility: string;
  folder: string;
  freshness: string | null;
  quality: 'unknown' | 'passing' | 'failing';
  dots: { bronze: boolean; silver: boolean; gold: boolean };
  storage: string;
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
};
type Groups = { mine: Tile[]; domain: Tile[]; marketplace: Tile[] };

/** Which folder ROOT a dataset's folders live in — its private tree (dataset) or the
 *  domain tree (shared/certified). Mirrors how the store groups by tier. */
type FolderRoot = 'personal' | 'domain';
function rootOf(t: Tile): FolderRoot {
  return t.tier === 'dataset' ? 'personal' : 'domain';
}

/** Which folder roots are relevant for the active scope. Used to trim the rail and
 *  the folder picker so the user only sees roots that contain items in-scope. */
function rootsForScope(scope: DatasetScope): FolderRoot[] {
  if (scope === 'mine') return ['personal'];
  if (scope === 'shared') return ['domain'];
  if (scope === 'marketplace') return ['domain'];
  return ['personal', 'domain']; // 'all'
}

/** Tile tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: Tile['tier']): Visibility =>
  tier === 'asset' ? 'shared' : tier === 'product' ? 'certified' : 'personal';

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

function TileCard({ t, onOpen, onImport, onMove, canManage, onChanged, showDomain }: { t: Tile; onOpen: (id: string) => void; onImport?: (id: string) => void; onMove?: (id: string) => void; canManage?: boolean; onChanged: () => void; showDomain?: boolean }) {
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
        {/* Source-domain provenance — shown in Shared/Marketplace where two datasets
            from different domains can share a name. Renders nothing without a domain. */}
        {showDomain ? <DomainTag domain={t.domain} style={{ marginLeft: 4 }} /> : null}
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
      {canManage ? (
        <div
          className="row"
          style={{ gap: 6, marginTop: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}
          onClick={(e) => e.stopPropagation()}
        >
          {onMove ? (
            <button type="button" className="btn ghost sm" title="Move to folder" onClick={stop(() => onMove(t.id))}>
              Move…
            </button>
          ) : null}
          <LifecycleActions
            id={t.id}
            name={t.name}
            kind="dataset"
            visibility={lcVis(t.tier)}
            archived={!!t.archived}
            api={`/api/data/datasets/${t.id}`}
            onChanged={onChanged}
            compact
            showVersions={false}
            // OS-wide rule: live tiles stay clean (Archive/Delete live in the detail).
            // An ARCHIVED tile is the one place the list promises Restore/Delete inline —
            // so it renders the real cluster (Restore + Delete) right here, matching the
            // Archived-section copy and the Agents tab's archived-item affordance.
            surface={t.archived ? 'detail' : 'tile'}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The real body — lives INSIDE <ConfirmProvider> so useConfirm() is in-context. */
function DatasetTilesInner({ onOpen }: { onOpen: (id: string) => void }) {
  const { user } = useUser();
  const confirm = useConfirm();
  // Importing a marketplace product grants the WHOLE domain read access, so the store
  // gates it to Builder/Admin (store.importProduct 403s others). Only surface Import to
  // those roles — no dead control (mirrors CertifyPanel's "no dead controls").
  const canImport = !!user && roleAtLeast(user.role, 'builder');
  const [groups, setGroups] = useState<Groups | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // Scope switcher — the Files-tab mental model: All · My · Shared · Marketplace.
  const [scope, setScope] = useState<DatasetScope>('all');
  // Folder rail (Wave 1 primitive, mirrors Files): a (root, path) selection filters
  // the grid to datasets under that folder. `null` = every dataset in the scope.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  // Explicit folder rows from the governed registry, per root — unioned with folders
  // synthesised from the visible datasets' own paths so implicit folders keep showing.
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);
  // Multi-select in the grid → bulk "Move selected…".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Folder picker modal for dataset moves: ids being moved; null = closed.
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  // Folder picker modal for folder moves: the folder ref being moved; null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  // Archive/lifecycle UI (mirrors the Knowledge tab's reference pattern).
  const [showArchived, setShowArchived] = useState(false);
  // Import-from-warehouse affordance: registered warehouse connections a builder can
  // materialize a table from. Lazily loaded from the same /api/connections endpoint the
  // Connections tab uses; only offered when there's at least one warehouse connection.
  const [warehouses, setWarehouses] = useState<WarehouseConn[]>([]);
  const [importing, setImporting] = useState(false);
  const canImportWarehouse = !!user && roleAtLeast(user.role, 'builder');

  useEffect(() => {
    if (!canImportWarehouse) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/connections', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { connections?: Array<{ id: string; name: string; domain: string; template: string; archived?: boolean; warehouse?: { platform: string; catalog: string } }> };
        const whs = (body.connections ?? [])
          .filter((c) => c.template === 'warehouse' && c.warehouse && !c.archived)
          .map((c) => ({ id: c.id, name: c.name, domain: c.domain, catalog: c.warehouse!.catalog, platform: c.warehouse!.platform }));
        if (!cancelled) setWarehouses(whs);
      } catch { /* the affordance just stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [canImportWarehouse]);

  const loadFolders = useCallback(async () => {
    try {
      const suffix = showArchived ? '&archived=1' : '';
      const [pRes, dRes] = await Promise.all([
        fetch(`/api/folders?tab=data&scope=personal${suffix}`, { cache: 'no-store' }),
        fetch(`/api/folders?tab=data&scope=domain${suffix}`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPersonalNodes(((await pRes.json()).folders ?? []) as FolderPathNode[]);
      if (dRes.ok) setDomainNodes(((await dRes.json()).folders ?? []) as FolderPathNode[]);
    } catch { /* the synthesised rail still renders without the registry */ }
  }, [showArchived]);

  const refresh = useCallback(async () => {
    setErr('');
    try {
      // ?archived=1 additionally returns soft-archived datasets (their own section).
      const res = await fetch(`/api/data/datasets${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load datasets'); return; }
      setGroups(data);
      void loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived, loadFolders]);
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

  // Create a folder row in the registry, then re-load the rail. New-folder + the •••
  // "Move folder" both live on the FolderTree; move-folder reuses create-at-path
  // (mirrors the Files browser exactly — one primitive, consistent behaviour).
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'data', scope: root, path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders]);

  // Move one or many datasets into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/data/datasets/${id}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) { setErr((await res.json()).error ?? 'Move failed'); }
      } catch (e) { setErr((e as Error).message); }
    }
    setPicked(new Set());
    refresh();
  }, [refresh]);

  const promptMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
  }, []);

  // Folder lifecycle handlers — archive, restore, delete a folder row via the
  // governed registry API. All three refresh both the dataset tiles and the rail.
  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    const active = groups ? [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])] : [];
    const count = itemsUnderFolder(ref.path, active.filter((t) => rootOf(t) === ref.scope)).length;
    const ok = await confirm(archiveFolderCopy(folderName(ref.path), count));
    if (!ok) return;
    setErr('');
    try {
      // Synthetic (implicit) folder → materialise a row first, then archive it.
      const id = await ensureFolderId('data', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Archive failed'); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, groups, refresh]);

  const handleFolderRename = useCallback(async (ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    setErr('');
    try {
      const id = await ensureFolderId('data', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Rename failed'); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh]);

  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Restore failed'); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh]);

  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    const active = groups ? [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])] : [];
    const count = itemsUnderFolder(ref.path, active.filter((t) => rootOf(t) === ref.scope)).length;
    const ok = await confirm(deleteFolderCopy(folderName(ref.path), count));
    if (!ok) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setErr((await res.json()).error ?? 'Delete failed'); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, groups, refresh]);

  // A dataset is the caller's to manage under the ONE canonical edit-scope rule the
  // DELETE/archive routes enforce: owner, domain_admin of the owning domain, or admin.
  // Using the shared predicate (not a hand-rolled owner-or-admin check) keeps the
  // list's affordances consistent with the route — the same gate every other tab uses.
  const canManage = useCallback((t: Tile) =>
    !!user && canManageArtifact(user, { owner: t.owner, domain: t.domain }), [user]);

  // Scope slice (Files mental model): All Data · My Data · Shared Data · Marketplace
  // Data, working tiles + archived (soft-hidden) split per scope.
  const uid = user?.id ?? '';
  const scoped = groups ? tilesForScope(groups, scope, uid) : { active: [], archived: [] };
  const counts = groups ? scopeCounts(groups, uid) : null;
  const empty = groups && scoped.active.length === 0;
  // Source-domain tag rides along in the cross-domain scopes (Shared / Marketplace),
  // where a dataset's origin domain disambiguates same-named assets. DomainTag itself
  // no-ops on a missing domain, so this is always safe.
  const showDomain = scope === 'shared' || scope === 'marketplace';

  // Which folder roots to surface in the nav rail and picker — driven by the active
  // scope so only the relevant tree is shown (mine→personal, shared/marketplace→domain,
  // all→both). This also ensures a moved dataset lands under a valid root.
  const visibleRoots = rootsForScope(scope);

  // Folder rows fed to the tree = the governed registry rows UNIONed with folders
  // synthesised from the visible datasets' own paths, so implicit (pre-registry)
  // folders keep showing with zero migration. Split by root (personal/domain).
  const active = scoped.active as Tile[];
  const [personalTreeNodes, domainTreeNodes] = useMemo(() => {
    const synth = (rows: FolderPathNode[], paths: string[]): FolderPathNode[] => {
      const seen = new Set(rows.map((r) => normaliseFolderPath(r.path)));
      const out = [...rows];
      for (const p of paths) {
        const n = normaliseFolderPath(p);
        if (n !== '/' && !seen.has(n)) { seen.add(n); out.push({ path: n }); }
      }
      return out;
    };
    const personalPaths = active.filter((t) => rootOf(t) === 'personal').map((t) => t.folder);
    const domainPaths = active.filter((t) => rootOf(t) === 'domain').map((t) => t.folder);
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, active]);

  // When a root is not visible for the current scope, pass [] so the tree column
  // renders empty (a single-root layout).
  const treePersonalNodes = visibleRoots.includes('personal') ? personalTreeNodes : [];
  const treeDomainNodes = visibleRoots.includes('domain') ? domainTreeNodes : [];

  // The items the tree lays out under each root (leaves live inside their folder).
  const treeItems = useMemo(
    () => active.map((t) => ({ id: t.id, folder: t.folder, name: t.name })),
    [active],
  );

  // Grid filter: when a folder is selected, show the datasets under it (incl. subfolders,
  // via itemsUnderFolder) that live in the selected root. Else the whole scope list.
  const shown = sel
    ? itemsUnderFolder(sel.path, active.filter((t) => rootOf(t) === sel.root))
    : active;
  const canBulkMove = shown.filter((t) => picked.has(t.id) && canManage(t)).map((t) => t.id);

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
            style={{ opacity: 1 }}
            onClick={() => setShowArchived((v) => !v)}
            title="Archived datasets are hidden by default"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {canImportWarehouse && warehouses.length > 0 ? (
            <button className="btn ghost" onClick={() => setImporting((v) => !v)}>
              {importing ? 'Close import' : 'Import from warehouse'}
            </button>
          ) : null}
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

      {/* Import from warehouse — materialize a registered warehouse table into a
          governed dataset. Opens the browse → name → import panel; on success it
          refreshes the tiles and (when a dataset id comes back) opens it. */}
      {importing && canImportWarehouse ? (
        <WarehouseImportPanel
          connections={warehouses}
          domains={user?.domains ?? []}
          onClose={() => { setImporting(false); refresh(); }}
          onImported={(datasetId) => { refresh(); if (datasetId) onOpen(datasetId); }}
        />
      ) : null}

      {/* Scope switcher — same grouping logic as the Files tab, plus All Data. */}
      <div className="seg" style={{ marginTop: 14 }}>
        {DATASET_SCOPES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={scope === s.key ? 'on' : ''}
            onClick={() => { setScope(s.key); setSel(null); setPicked(new Set()); }}
          >
            {s.label}{counts ? ` (${counts[s.key]})` : ''}
          </button>
        ))}
      </div>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {/* Dataset picker modal — bulk move of selected tiles into a folder.
          Only shows roots valid for the current scope. */}
      <FolderPickerModal
        open={pickerIds !== null}
        tab="data"
        roots={visibleRoots}
        personalNodes={visibleRoots.includes('personal') ? personalTreeNodes : []}
        domainNodes={visibleRoots.includes('domain') ? domainTreeNodes : []}
        title={`Move ${pickerIds && pickerIds.length > 1 ? `${pickerIds.length} datasets` : 'dataset'} to folder`}
        onConfirm={({ path }) => {
          if (pickerIds) void moveInto(pickerIds, path);
          setPickerIds(null);
        }}
        onCancel={() => setPickerIds(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'data', scope, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      {/* Folder move modal — reparents a folder row via PATCH /api/folders/{id}.
          Scoped to the folder's own root only (personal or domain). */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="data"
        roots={folderMove ? [folderMove.scope] : visibleRoots}
        personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
        title="Move folder"
        onConfirm={async ({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (!ref) return;
          setErr('');
          try {
            const id = await ensureFolderId('data', ref);
            const res = await fetch(`/api/folders/${id}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!res.ok) { setErr((await res.json()).error ?? 'Move failed'); return; }
            await refresh();
          } catch (e) { setErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'data', scope, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      {empty ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          {scope === 'mine' || scope === 'all'
            ? <>No datasets yet. <strong>+ New dataset</strong> starts one — bring a file in, and you're at Bronze.</>
            : scope === 'shared'
              ? 'Nothing in Domain yet — promote a dataset to share it with your domain.'
              : 'Nothing in Company yet — an Admin certifies assets into data products.'}
        </div>
      ) : null}

      {groups ? (
        <>
          {active.length > 0 ? (
            <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 16 }}>
              {/* ---- folder rail (the Wave 1 primitive, one component across tabs) ---- */}
              <nav style={{ flex: '0 0 260px', minWidth: 220 }}>
                <button
                  type="button"
                  className={`folder-row${sel === null ? ' is-selected' : ''}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    height: 32, padding: '0 8px', marginBottom: 6, borderRadius: 8,
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: sel === null ? 'var(--gold-soft)' : 'transparent',
                    color: sel === null ? 'var(--gold-text)' : 'var(--text)',
                  }}
                  onClick={() => setSel(null)}
                >
                  <span aria-hidden style={{ opacity: 0.85 }}>🗂️</span>
                  <span style={{ flex: 1 }}>All datasets</span>
                  <span className="muted" style={{ fontSize: 12 }}>{active.length}</span>
                </button>
                <FolderTree
                  variant="nav"
                  roots={visibleRoots}
                  personalNodes={treePersonalNodes}
                  domainNodes={treeDomainNodes}
                  items={treeItems}
                  personalLabel="My folders"
                  domainLabel="Domain folders"
                  selectedPath={sel?.path}
                  onSelect={(root, path) => setSel({ root, path })}
                  onCreate={createFolder}
                  onMove={(ref) => setFolderMove(ref)}
                  onRename={handleFolderRename}
                  onArchive={handleFolderArchive}
                  onRestore={handleFolderRestore}
                  onDelete={handleFolderDelete}
                  renderLeaf={(item) => item.name ?? item.id}
                />
              </nav>

              {/* ---- the dataset grid, filtered to the selected folder ---- */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {canBulkMove.length > 0 ? (
                  <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
                    <span className="muted">{canBulkMove.length} selected</span>
                    <button className="btn ghost sm" onClick={() => promptMove(canBulkMove)}>Move selected…</button>
                    <button className="btn ghost sm" onClick={() => setPicked(new Set())}>Clear</button>
                  </div>
                ) : null}
                {shown.length === 0 ? (
                  <div className="stub-page">This folder is empty.</div>
                ) : (
                  <div className="tile-grid">
                    {shown.map((t) => (
                      <div key={t.id} style={{ position: 'relative' }}>
                        {canManage(t) ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${t.name}`}
                            checked={picked.has(t.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                                return next;
                              });
                            }}
                            style={{ position: 'absolute', top: 12, left: 12, zIndex: 2, accentColor: 'var(--gold-deep)', cursor: 'pointer' }}
                          />
                        ) : null}
                        <TileCard
                          t={t}
                          onOpen={onOpen}
                          // Import applies to marketplace products only (Builder+; store re-checks).
                          onImport={canImport && t.tier === 'product' && t.owner !== uid ? importProduct : undefined}
                          onMove={canManage(t) ? (id) => promptMove([id]) : undefined}
                          canManage={canManage(t)}
                          onChanged={refresh}
                          showDomain={showDomain}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {showArchived ? (
            scoped.archived.length > 0 ? (
              <>
                <div className="section-title">Archived<span className="count-pill">{scoped.archived.length}</span></div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  Archived datasets are hidden from the working lists (their tables are retained).
                  Restore brings one back; Delete removes it permanently — including its physical tables.
                </p>
                <div className="tile-grid">
                  {scoped.archived.map((t) => <TileCard key={t.id} t={t} onOpen={onOpen} canManage={canManage(t)} onChanged={refresh} showDomain={showDomain} />)}
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

export default function DatasetTiles({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <ConfirmProvider>
      <DatasetTilesInner onOpen={onOpen} />
    </ConfirmProvider>
  );
}
