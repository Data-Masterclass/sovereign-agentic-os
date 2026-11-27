/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { canManageArtifact } from '@core/policy/edit-scope';
import { DATASET_SCOPES, tilesForScope, scopeCounts, type DatasetScope } from '@tabs/data/lib/dataset-scopes';
import { rootsForScope, TIER_BADGE_CLASS, type FolderRoot } from '@core/kernel/scopes';
import { visibilityForTier } from '@core/kernel/artifact-model';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@core/kernel/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@core/ui/core/FolderTree';
import FolderLayout from '@core/ui/core/FolderLayout';
import TileBadges from '@core/ui/lifecycle/TileBadges';
import { useLifecycleTiles } from '@core/ui/lifecycle/useLifecycleView';
import { ensureFolderId, renamedPath } from '@core/folders/client';
import { useFolders } from '@core/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { useToast } from '@core/ui/core/Toast';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import DomainTag from '@core/ui/DomainTag';
import type { Visibility, ConfirmCopy } from '@core/kernel/lifecycle';
import WarehouseImportPanel, { type WarehouseConn } from '@tabs/data/ui/WarehouseImportPanel';
import AdoptConnectionPanel from '@tabs/data/ui/AdoptConnectionPanel';

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
  /** Born curated (composed from existing datasets) — the transparency badge. */
  curated?: boolean;
  /** Adopted from a warehouse connection — drives the "connected" badge + live status. */
  connected?: { mode: 'live' | 'sync'; status: 'ok' | 'drifted' | 'source-revoked' };
};
type Groups = { mine: Tile[]; domain: Tile[]; marketplace: Tile[] };

/** Which folder ROOT a dataset's folders live in — its private tree (dataset) or the
 *  domain tree (shared/certified). Mirrors how the store groups by tier. */
function rootOf(t: Tile): FolderRoot {
  return t.tier === 'dataset' ? 'personal' : 'domain';
}

/** Tile tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: Tile['tier']): Visibility => visibilityForTier(tier);

type DataT = ReturnType<typeof useTranslations<'data'>>;

function freshLabel(iso: string | null, t: DataT, f: Formatters): string {
  if (!iso) return t('tiles.fresh.notBuilt');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t('tiles.fresh.recently');
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return t('tiles.fresh.today');
  if (days === 1) return t('tiles.fresh.yesterday');
  if (days < 30) return t('tiles.fresh.daysAgo', { days });
  // `{}` = the locale's short numeric date (en: "11/27/2026", what toLocaleDateString() gave).
  return t('tiles.fresh.onDate', { date: f.date(d, {}) });
}

/** The shared folder-archive confirm, in the user's language (same words as the core copy in English). */
function archiveCopy(name: string, count: number, t: DataT): ConfirmCopy {
  return { title: t('tiles.confirm.archiveTitle', { name }), body: t('tiles.confirm.archiveBody', { name, count }), confirmLabel: t('tiles.confirm.archiveConfirm'), danger: false };
}
/** The shared folder physical-delete confirm — permanent, cascades to the items inside. */
function deleteCopy(name: string, count: number, t: DataT): ConfirmCopy {
  return { title: t('tiles.confirm.deleteTitle', { name }), body: t('tiles.confirm.deleteBody', { name, count }), confirmLabel: t('tiles.confirm.deleteConfirm'), danger: true };
}

const TIER_BADGE: Record<Tile['tier'], string> = { dataset: TIER_BADGE_CLASS.personal, asset: TIER_BADGE_CLASS.shared, product: TIER_BADGE_CLASS.certified };

/** The B/S/G refinement dots on a tile — one logical dataset, three versions. */
function Dots({ dots }: { dots: Tile['dots'] }) {
  const t = useTranslations('data');
  return (
    <div className="bsg-dots" title={t('tiles.dotsTitle')}>
      <span className={`bsg-dot${dots.bronze ? ' on b' : ''}`} />
      <span className={`bsg-dot${dots.silver ? ' on s' : ''}`} />
      <span className={`bsg-dot${dots.gold ? ' on g' : ''}`} />
    </div>
  );
}

/** Stable id accessor for the shared lifecycle hook (a new closure would re-fetch). */
const tileId = (t: Tile) => t.id;

function TileCard({ t, onOpen, onImport, onMove, canManage, onChanged, showDomain }: { t: Tile; onOpen: (id: string) => void; onImport?: (id: string) => void; onMove?: (id: string) => void; canManage?: boolean; onChanged: () => void; showDomain?: boolean }) {
  // A role="button" DIV (not a <button>) so the optional Import / lifecycle controls
  // can be real nested <button>s without invalid button-in-button nesting. Every
  // nested control stops propagation so it never also opens the card.
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const tr = useTranslations('data');
  const f = useFormat();
  return (
    <div
      role="button"
      tabIndex={0}
      className="card tile"
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}
      title={tr('tiles.openTitle')}
    >
      <div className="tile-top">
        <span className="tile-name">{t.name}</span>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <TileBadges kind="dataset" id={t.id} audience={false} />
          {t.archived ? <span className="badge muted">{tr('tiles.badge.archived')}</span> : null}
          {t.curated ? <span className="badge muted" title={tr('tiles.badge.curatedTitle')}>{tr('tiles.badge.curated')}</span> : null}
          {t.connected ? (
            t.connected.status === 'source-revoked'
              ? <span className="badge" style={{ background: 'var(--danger, #a44)' }} title={tr('tiles.badge.revokedTitle')}>{tr('tiles.badge.revoked')}</span>
              : t.connected.status === 'drifted'
                ? <span className="badge" style={{ background: 'var(--warn, #a86)' }} title={tr('tiles.badge.driftedTitle')}>{tr('tiles.badge.drifted')}</span>
                : <span className="badge muted" title={tr('tiles.badge.connectedTitle')}>{tr('tiles.badge.connected')}</span>
          ) : null}
          <span className={`badge ${TIER_BADGE[t.tier]}`}>{tr(`tiles.tier.${t.tier}`)}</span>
        </div>
      </div>
      <div className="tile-meta">
        <span className="muted">{t.owner}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{freshLabel(t.freshness, tr, f)}</span>
        {/* Source-domain provenance — shown in Shared/Marketplace where two datasets
            from different domains can share a name. Renders nothing without a domain. */}
        {showDomain ? <DomainTag domain={t.domain} style={{ marginLeft: 4 }} /> : null}
      </div>
      <div className="tile-foot">
        <span className={`quality-badge q-${t.quality}`}>
          {tr(`tiles.quality.${t.quality}`)}
        </span>
        <Dots dots={t.dots} />
      </div>
      {onImport ? (
        <button type="button" className="tile-action btn ghost sm"
          onClick={stop(() => onImport(t.id))}>
          {tr('tiles.import')}
        </button>
      ) : null}
      {canManage ? (
        <div
          className="row"
          style={{ gap: 6, marginTop: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}
          onClick={(e) => e.stopPropagation()}
        >
          {onMove ? (
            <button type="button" className="btn ghost sm" title={tr('tiles.moveTitle')} onClick={stop(() => onMove(t.id))}>
              {tr('tiles.move')}
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
  const toast = useToast();
  const t = useTranslations('data');
  const tc = useTranslations('common');
  // Importing a marketplace product grants the WHOLE domain read access, so the store
  // gates it to Builder/Admin (store.importProduct 403s others). Only surface Import to
  // those roles — no dead control (mirrors CertifyPanel's "no dead controls").
  const canImport = !!user && roleAtLeast(user.role, 'builder');
  const [groups, setGroups] = useState<Groups | null>(null);
  const [err, setErr] = useState('');
  // TWO-PATH create. `+ New dataset` opens a calm two-card chooser FIRST:
  //   'choose'  — pick a path (📥 ingest new data · 🔗 curate from existing datasets)
  //   'ingest'  — name it, create, land in the builder at Ingest (today's path, unchanged)
  //   'curated' — name it, create with origin:'curated', land in the builder with a toast
  //               pointing at the Harmonize stage (where the existing Gold join builder lives)
  const [creating, setCreating] = useState<false | 'choose' | 'ingest' | 'curated' | 'connected'>(false);
  const [newName, setNewName] = useState('');
  // "From a connection" adopt path (lakehouse-import-exposure.md, Phase 2): available only
  // when the caller is domain_admin AND there is at least one table exposed to their
  // domain(s). The endpoint itself gates the flag + role and returns [] otherwise, so this
  // single fetch decides whether the third card is offered (no dead affordance).
  const [adoptAvailable, setAdoptAvailable] = useState(false);
  const canAdopt = !!user && roleAtLeast(user.role, 'domain_admin');
  /** A taken name (409): the friendly duplicate notice + one-click open of the existing dataset. */
  const [dupe, setDupe] = useState<{ name: string; id?: string } | null>(null);
  // Scope switcher — the Files-tab mental model: All · My · Shared · Marketplace.
  const [scope, setScope] = useState<DatasetScope>('all');
  // Folder rail (Wave 1 primitive, mirrors Files): a (root, path) selection filters
  // the grid to datasets under that folder. `null` = every dataset in the scope.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  // Multi-select in the grid → bulk "Move selected…".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Folder picker modal for dataset moves: ids being moved; null = closed.
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  // Folder picker modal for folder moves: the folder ref being moved; null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  // Archive/lifecycle UI (mirrors the Knowledge tab's reference pattern).
  const [showArchived, setShowArchived] = useState(false);
  // Explicit folder rows from the governed registry, per root (unioned below with
  // folders synthesised from the visible datasets' own paths so implicit ones show).
  const { personalNodes, domainNodes, loadFolders } = useFolders('data', showArchived);
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

  useEffect(() => {
    if (!canAdopt) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/data/exposed-tables', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json() as { connections?: unknown[] };
        if (!cancelled) setAdoptAvailable((body.connections ?? []).length > 0);
      } catch { /* the card just stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, [canAdopt]);

  const refresh = useCallback(async () => {
    setErr('');
    try {
      // ?archived=1 additionally returns soft-archived datasets (their own section).
      const res = await fetch(`/api/data/datasets${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? t('tiles.errors.load')); return; }
      setGroups(data);
      void loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived, loadFolders, t]);
  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async () => {
    const name = newName.trim();
    // Only the ingest/curated naming path uses this create endpoint; 'connected' adopts
    // through its own panel (AdoptConnectionPanel → /api/data/adopt), never here.
    if (!name || (creating !== 'ingest' && creating !== 'curated')) return;
    const curated = creating === 'curated';
    setErr('');
    setDupe(null);
    try {
      const res = await fetch('/api/data/datasets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // The curated birth is recorded on the record (nil-safe; absent ⇒ ingest).
        body: JSON.stringify({ name, ...(curated ? { origin: 'curated' } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        // FRIENDLY duplicate handling: names are unique per domain by design (one name =
        // one gold table + one Cube model). Instead of a raw refusal, point at the
        // existing dataset with a one-click open — the tiles already carry its id.
        if (res.status === 409) {
          const lower = name.toLowerCase();
          const match = [...(groups?.mine ?? []), ...(groups?.domain ?? [])]
            .find((t) => t.name.trim().toLowerCase() === lower);
          setDupe({ name, id: match?.id });
          return;
        }
        setErr(data.error ?? t('tiles.errors.create'));
        return;
      }
      setNewName(''); setCreating(false);
      // The builder lands a fresh dataset at Ingest (its stage derives from real state,
      // no preselect hook exists) — so the curated path gets a clear signpost to the
      // Harmonize stage, where the existing join-existing-datasets builder lives.
      if (curated) {
        toast.info(t('tiles.curatedCreated'));
      }
      onOpen(data.dataset.id); // navigates to the new dataset's detail view
    } catch (e) { setErr((e as Error).message); }
  }, [newName, creating, onOpen, toast, groups, t]);

  const importProduct = useCallback(async (id: string) => {
    setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${id}/import`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? t('tiles.errors.import')); return; }
      refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh, t]);

  // Create a folder row in the registry, then re-load the rail. New-folder + the •••
  // "Move folder" both live on the FolderTree; move-folder reuses create-at-path
  // (mirrors the Files browser exactly — one primitive, consistent behaviour).
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt(t('tiles.folderPrompt'));
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'data', scope: root, path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.createFolder')); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders, t]);

  // Move one or many datasets into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/data/datasets/${id}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.move')); }
      } catch (e) { setErr((e as Error).message); }
    }
    setPicked(new Set());
    refresh();
  }, [refresh, t]);

  const promptMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
  }, []);

  // Folder lifecycle handlers — archive, restore, delete a folder row via the
  // governed registry API. All three refresh both the dataset tiles and the rail.
  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    const active = groups ? [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])] : [];
    const count = itemsUnderFolder(ref.path, active.filter((t) => rootOf(t) === ref.scope)).length;
    const ok = await confirm(archiveCopy(folderName(ref.path), count, t));
    if (!ok) return;
    setErr('');
    try {
      // Synthetic (implicit) folder → materialise a row first, then archive it.
      const id = await ensureFolderId('data', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.archive')); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, groups, refresh, t]);

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
      if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.rename')); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh, t]);

  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.restore')); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [refresh, t]);

  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    const active = groups ? [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])] : [];
    const count = itemsUnderFolder(ref.path, active.filter((t) => rootOf(t) === ref.scope)).length;
    const ok = await confirm(deleteCopy(folderName(ref.path), count, t));
    if (!ok) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.delete')); return; }
      await refresh();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, groups, refresh, t]);

  // A dataset is the caller's to manage under the ONE canonical edit-scope rule the
  // DELETE/archive routes enforce: owner, domain_admin of the owning domain, or admin.
  // Using the shared predicate (not a hand-rolled owner-or-admin check) keeps the
  // list's affordances consistent with the route — the same gate every other tab uses.
  const canManage = useCallback((tile: Tile) =>
    !!user && canManageArtifact(user, { owner: tile.owner, domain: tile.domain }), [user]);

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
  // Each item PINNED to its own root (the 0.6.40 folder-scope rule): without an explicit
  // scope, FolderTree renders the item under BOTH "My folders" and "Domain folders" —
  // the leak seen live 2026-08-02 (domain datasets under My folders in the All scope).
  const treeItems = useMemo(
    () => active.map((t) => ({ id: t.id, folder: t.folder, name: t.name, scope: rootOf(t) })),
    [active],
  );

  // Grid filter: when a folder is selected, show the datasets under it (incl. subfolders,
  // via itemsUnderFolder) that live in the selected root. Else the whole scope list.
  const inFolder = sel
    ? itemsUnderFolder(sel.path, active.filter((t) => rootOf(t) === sel.root))
    : active;
  // LIFECYCLE: the ONE shared hook — Studio shows everything, Run only what is live.
  const { tiles: shown } = useLifecycleTiles('dataset', inFolder, tileId);
  const canBulkMove = shown.filter((t) => picked.has(t.id) && canManage(t)).map((t) => t.id);

  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'flex-end' }}>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn ghost"
            style={{ opacity: 1 }}
            onClick={() => setShowArchived((v) => !v)}
            title={t('tiles.toolbar.archivedTitle')}
          >
            {showArchived ? t('tiles.toolbar.hideArchived') : t('tiles.toolbar.showArchived')}
          </button>
          {canImportWarehouse && warehouses.length > 0 ? (
            <button className="btn ghost" onClick={() => setImporting((v) => !v)}>
              {importing ? t('tiles.toolbar.closeImport') : t('tiles.toolbar.importWarehouse')}
            </button>
          ) : null}
          {creating ? (
            <button className="btn ghost" onClick={() => { setCreating(false); setNewName(''); }}>{tc('actions.cancel')}</button>
          ) : (
            <button className="btn" onClick={() => setCreating('choose')}>{t('tiles.toolbar.newDataset')}</button>
          )}
        </div>
      </div>

      {/* TWO-PATH create — the chooser comes FIRST (before any naming). Two big, calm
          cards on the Agents tmpl-card primitive: bring NEW data in (today's ingest
          path, unchanged), or CURATE a new dataset from existing governed ones (the
          reuse path — the Harmonize-stage join builder). Pick one, then name it. */}
      {creating === 'choose' ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0, marginBottom: 2 }}>{t('tiles.choose.title')}</h3>
          <p className="hint" style={{ marginTop: 0 }}>{t('tiles.choose.hint')}</p>
          <div className="tmpl-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', maxWidth: 680, gap: 12 }}>
            <button type="button" className="tmpl-card" style={{ padding: '18px 20px', gap: 6 }} onClick={() => setCreating('ingest')}>
              <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>📥</span>
              <span className="tmpl-label" style={{ fontSize: 14 }}>{t('tiles.choose.ingestLabel')}</span>
              <span className="tmpl-blurb" style={{ fontSize: 12 }}>{t('tiles.choose.ingestBlurb')}</span>
            </button>
            <button type="button" className="tmpl-card" style={{ padding: '18px 20px', gap: 6 }} onClick={() => setCreating('curated')}>
              <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>🔗</span>
              <span className="tmpl-label" style={{ fontSize: 14 }}>{t('tiles.choose.curatedLabel')}</span>
              <span className="tmpl-blurb" style={{ fontSize: 12 }}>{t('tiles.choose.curatedBlurb')}</span>
            </button>
            {/* Third card — adopt an exposed table from a warehouse connection (Phase 2).
                Only when the caller is domain_admin AND a table is actually exposed to their
                domain (adoptAvailable), so it never appears as a dead affordance. */}
            {canAdopt && adoptAvailable ? (
              <button type="button" className="tmpl-card" style={{ padding: '18px 20px', gap: 6 }} onClick={() => setCreating('connected')}>
                <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>🛰️</span>
                <span className="tmpl-label" style={{ fontSize: 14 }}>{t('tiles.choose.connectedLabel')}</span>
                <span className="tmpl-blurb" style={{ fontSize: 12 }}>{t('tiles.choose.connectedBlurb')}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Adopt-from-connection flow — browse exposed tables, name + describe, adopt.
          Creates the dataset at Domain tier (origin:'connected') and opens it. */}
      {creating === 'connected' ? (
        <AdoptConnectionPanel
          onClose={() => setCreating('choose')}
          onAdopted={(datasetId) => { setCreating(false); refresh(); onOpen(datasetId); }}
        />
      ) : null}

      {/* Path picked → name it. Same create endpoint for both; the curated path adds
          origin:'curated' and, on create, a toast signpost to the Harmonize stage. */}
      {creating === 'ingest' || creating === 'curated' ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <button className="btn ghost" onClick={() => setCreating('choose')}>{t('tiles.name.back')}</button>
            <strong>{creating === 'curated' ? t('tiles.name.curatedHeading') : t('tiles.name.ingestHeading')}</strong>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            {creating === 'curated' ? t('tiles.name.curatedHint') : t('tiles.name.ingestHint')}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <input autoFocus value={newName} placeholder={t('tiles.name.placeholder')} style={{ flex: 1, maxWidth: 380 }}
              onChange={(e) => { setNewName(e.target.value); if (dupe) setDupe(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setDupe(null); setCreating('choose'); } }} />
            <button className="btn" onClick={create} disabled={!newName.trim()}>{t('tiles.name.create')}</button>
          </div>
          {/* Friendly duplicate handling — names are unique per domain by design (one
              name = one gold table + one Cube model). Point at the existing dataset
              instead of a raw refusal. */}
          {dupe ? (
            <div className="passthrough-note" style={{ marginTop: 10, maxWidth: 520 }}>
              <span>{t('tiles.dupe.exists', { name: dupe.name })} </span>
              {dupe.id ? (
                <button className="btn ghost sm" style={{ margin: '0 6px' }}
                  onClick={() => { const id = dupe.id!; setDupe(null); setNewName(''); setCreating(false); onOpen(id); }}>
                  {t('tiles.dupe.open', { name: dupe.name })}
                </button>
              ) : null}
              <span>{dupe.id ? t('tiles.dupe.orRename', { name: dupe.name }) : t('tiles.dupe.rename', { name: dupe.name })}</span>
            </div>
          ) : null}
        </div>
      ) : null}

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
            {counts ? t('tiles.scopeWithCount', { label: t(s.labelKey), count: counts[s.key] }) : t(s.labelKey)}
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
        title={t('tiles.moveDatasetsTitle', { count: pickerIds?.length ?? 1 })}
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
          if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.createFolder')); return; }
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
        title={t('tiles.moveFolderTitle')}
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
            if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.move')); return; }
            await refresh();
          } catch (e) { setErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'data', scope, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? t('tiles.errors.createFolder')); return; }
          await loadFolders();
        }}
      />

      {empty ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          {scope === 'mine' || scope === 'all'
            ? t.rich('tiles.empty.mine', { strong: (c) => <strong>{c}</strong> })
            : scope === 'shared'
              ? t('tiles.empty.shared')
              : t('tiles.empty.company')}
        </div>
      ) : null}

      {groups ? (
        <>
          {active.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <FolderLayout
                allLabel={t('tiles.allDatasets')}
                allCount={active.length}
                allSelected={sel === null}
                onSelectAll={() => setSel(null)}
                rail={
                  <FolderTree
                    variant="nav"
                    canCreateDomain={!!user && roleAtLeast(user.role, 'domain_admin')}
                    roots={visibleRoots}
                    personalNodes={treePersonalNodes}
                    domainNodes={treeDomainNodes}
                    items={treeItems}
                    personalLabel={t('tiles.myFolders')}
                    domainLabel={t('tiles.domainFolders')}
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
                }
              >
                {canBulkMove.length > 0 ? (
                  <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
                    <span className="muted">{t('tiles.selected', { count: canBulkMove.length })}</span>
                    <button className="btn ghost sm" onClick={() => promptMove(canBulkMove)}>{t('tiles.moveSelected')}</button>
                    <button className="btn ghost sm" onClick={() => setPicked(new Set())}>{t('tiles.clear')}</button>
                  </div>
                ) : null}
                {shown.length === 0 ? (
                  <div className="stub-page">{t('tiles.folderEmpty')}</div>
                ) : (() => {
                  // Ingested vs Curated SUBSECTIONS (the origin split, visible in the list).
                  // Headers only when both kinds are present — a single-kind list stays flat.
                  const curatedTiles = shown.filter((x) => x.curated);
                  const ingestedTiles = shown.filter((x) => !x.curated);
                  const renderGrid = (list: Tile[]) => (
                    <div className="tile-grid">
                    {list.map((tile) => (
                      <div key={tile.id} style={{ position: 'relative' }}>
                        {canManage(tile) ? (
                          <input
                            type="checkbox"
                            aria-label={t('tiles.selectAria', { name: tile.name })}
                            checked={picked.has(tile.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (next.has(tile.id)) next.delete(tile.id); else next.add(tile.id);
                                return next;
                              });
                            }}
                            style={{ position: 'absolute', top: 14, left: 12, zIndex: 2, accentColor: 'var(--gold-deep)', cursor: 'pointer' }}
                          />
                        ) : null}
                        {/* Reserve room for the checkbox so it never sits ON the title. */}
                        <div style={canManage(tile) ? { paddingLeft: 26 } : undefined} className="tile-pick-pad">
                        <TileCard
                          t={tile}
                          onOpen={onOpen}
                          // Import applies to marketplace products only (Builder+; store re-checks).
                          onImport={canImport && tile.tier === 'product' && tile.owner !== uid ? importProduct : undefined}
                          onMove={canManage(tile) ? (id) => promptMove([id]) : undefined}
                          canManage={canManage(tile)}
                          onChanged={refresh}
                          showDomain={showDomain}
                        />
                        </div>
                      </div>
                    ))}
                  </div>
                  );
                  if (curatedTiles.length === 0 || ingestedTiles.length === 0) return renderGrid(shown);
                  return (
                    <>
                      <div className="section-title" style={{ marginTop: 4 }}>{t('tiles.ingestedSection')}</div>
                      {renderGrid(ingestedTiles)}
                      <div className="section-title" style={{ marginTop: 18 }}>{t('tiles.curatedSection')}</div>
                      {renderGrid(curatedTiles)}
                    </>
                  );
                })()}
              </FolderLayout>
            </div>
          ) : null}

          {showArchived ? (
            scoped.archived.length > 0 ? (
              <>
                <div className="section-title">{t('tiles.archivedSection')}<span className="count-pill">{scoped.archived.length}</span></div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  {t('tiles.archivedHint')}
                </p>
                <div className="tile-grid">
                  {scoped.archived.map((tile) => <TileCard key={tile.id} t={tile} onOpen={onOpen} canManage={canManage(tile)} onChanged={refresh} showDomain={showDomain} />)}
                </div>
              </>
            ) : (
              <div className="hint" style={{ marginTop: 16 }}>{t('tiles.noArchived')}</div>
            )
          ) : null}
        </>
      ) : !err ? <div className="stub-page" style={{ marginTop: 20 }}>{t('tiles.loading')}</div> : null}
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
