/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { SCOPE_GROUPS, groupByScope, scopeCounts, rootsForScope, showDomainForScope, type ScopeKey, type FolderRoot } from '@/lib/core/scopes';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { TIER_BADGE, TIER_LABEL } from './shared';
import type { DashboardGroups, DashboardSummary } from './shared';
import DomainTag from '@/components/DomainTag';

/**
 * The dashboards LIST surface — every dashboard the user can see, grouped All · My · Shared ·
 * Marketplace via the OS-wide scope helper, now WITH the shared folder primitive (the same
 * `FolderTree` rail + one folder lifecycle Files / Data / Metrics use). Clicking a tile OPENS
 * its detail, where the native viewer (per-viewer RLS), Reports and Govern fold in.
 *
 * SCOPE-DRIVEN SINGLE ROOT: a dashboard's folder root is tier-bound (personal → personal
 * tree; domain/marketplace → domain tree). The rail + move picker show ONLY the root(s) that
 * match the active scope segment, so a move can only ever target a folder it can live in.
 */

/** Which folder ROOT a dashboard's folders live in — personal (mine) or domain (shared/mkt). */
function rootOf(d: DashboardSummary): FolderRoot {
  return d.tier === 'personal' ? 'personal' : 'domain';
}

function DashboardsInner({
  data,
  loading,
  error,
  onOpen,
  onReload,
  showArchived = false,
}: {
  data: DashboardGroups | null;
  loading: boolean;
  error: string;
  onOpen: (d: DashboardSummary) => void;
  onReload?: () => void;
  showArchived?: boolean;
}) {
  const { user } = useUser();
  const confirm = useConfirm();
  const [scope, setScope] = useState<ScopeKey>('all');
  const [err, setErr] = useState('');
  // Folder rail selection (root, path) — mirrors Data/Metrics. `null` = every dashboard.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  const { personalNodes, domainNodes, loadFolders } = useFolders('dashboards', showArchived);
  // Move picker: which dashboard ids are moving + their root; null = closed.
  const [moveIds, setMoveIds] = useState<{ ids: string[]; root: FolderRoot } | null>(null);
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  useEffect(() => { void loadFolders(); }, [loadFolders, data]);

  const uid = user?.id ?? '';
  const scoped = data ? groupByScope(data, uid) : null;
  const counts = data ? scopeCounts(data, uid) : null;
  const scopedAll = (scoped ? scoped[scope] : []) as DashboardSummary[];
  const active = scopedAll.filter((d) => !d.archived);
  const archived = scopedAll.filter((d) => d.archived);

  const canManage = useCallback(
    (d: DashboardSummary) => !!user && canManageArtifact(user, { owner: d.owner, domain: d.domain ?? '' }),
    [user],
  );

  const roots = rootsForScope(scope);

  // Folder rows fed to the tree = registry rows UNIONed with folders synthesised from the
  // visible dashboards' own paths, so implicit folders keep showing. Split by root.
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
    const personalPaths = active.filter((d) => rootOf(d) === 'personal').map((d) => d.folder);
    const domainPaths = active.filter((d) => rootOf(d) === 'domain').map((d) => d.folder);
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, active]);

  const treeItems = useMemo(
    // `scope` pins each item to its own root so a root-level dashboard shows under My OR
    // Domain folders, never BOTH (FolderTreeItem.scope contract).
    () => active.map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: rootOf(d) })),
    [active],
  );

  // Grid filter: a selected folder shows dashboards under it (incl. subfolders) in that root.
  const shown = sel
    ? itemsUnderFolder(sel.path, active.filter((d) => rootOf(d) === sel.root))
    : active;

  const reload = useCallback(() => { onReload?.(); void loadFolders(); }, [onReload, loadFolders]);

  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? 'Move failed');
      } catch (e) { setErr((e as Error).message); }
    }
    reload();
  }, [reload]);

  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    const res = await fetch('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'dashboards', scope: root, path }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not create folder'); return; }
    await loadFolders();
  }, [loadFolders]);

  const countUnder = useCallback((root: FolderRoot, path: string) =>
    itemsUnderFolder(path, active.filter((d) => rootOf(d) === root)).length, [active]);

  const folderAction = useCallback(async (ref: FolderRef, method: 'PATCH' | 'DELETE' | 'archive' | 'restore', path?: string) => {
    setErr('');
    try {
      // A synthetic (implicit) folder has no registry row → materialise one so any folder
      // the user sees can be archived/renamed/moved (delete/restore only ever reach a real
      // archived row, so ensureFolderId is a no-op there).
      const id = await ensureFolderId('dashboards', ref);
      const opts: RequestInit =
        method === 'DELETE' ? { method: 'DELETE' }
        : method === 'PATCH' ? { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: method }) };
      const res = await fetch(`/api/folders/${id}`, opts);
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Folder action failed'); return; }
      reload();
    } catch (e) { setErr((e as Error).message); }
  }, [reload]);

  const renameFolderRow = useCallback((ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    void folderAction(ref, 'PATCH', path);
  }, [folderAction]);

  const card = (d: DashboardSummary) => {
    const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
    return (
      <div
        key={d.id}
        role="button"
        tabIndex={0}
        className="card tile"
        onClick={() => onOpen(d)}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d); }}
        title="Open this dashboard — view, report, or govern it"
      >
        <div className="tile-top">
          <span className="tile-name">{d.name}</span>
          <div className="row" style={{ gap: 4, alignItems: 'center' }}>
            {showDomainForScope(scope) ? <DomainTag domain={d.domain} /> : null}
            <span className={`badge ${TIER_BADGE[d.tier]}`}>{TIER_LABEL[d.tier]}</span>
          </div>
        </div>
        <div className="tile-meta muted">
          <span className="mono">{d.view}</span>
          <span className="dot-sep">·</span>
          <span>{d.charts} chart{d.charts === 1 ? '' : 's'}</span>
        </div>
        <div className="tile-foot">
          <span className="hint" style={{ marginTop: 0 }}>owner {d.owner}</span>
          {canManage(d) ? (
            <button type="button" className="btn ghost sm" title="Move to folder"
              onClick={stop(() => setMoveIds({ ids: [d.id], root: rootOf(d) }))}>
              Move…
            </button>
          ) : (
            <span className="hint" style={{ marginTop: 0 }}>open ↗</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {(error || err) ? <div className="error" style={{ marginTop: 16 }}>{error || err}</div> : null}
      {loading && !data ? <div className="stub-page">Loading dashboards…</div> : null}

      {data ? (
        /* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace.
           Archived toggle + ＋ New live in the tab header row above (canonical). */
        <div className="seg" style={{ marginTop: 14 }}>
          {SCOPE_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              className={scope === g.key ? 'on' : ''}
              onClick={() => { setScope(g.key); setSel(null); }}
              {...(g.key === 'mine' ? anchorAttr(ANCHORS.dashboards.sandbox) : undefined)}
            >
              {g.label('Dashboards')}{counts ? ` (${counts[g.key]})` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {/* Move-dashboard picker (scope-driven single root). */}
      <FolderPickerModal
        open={moveIds !== null}
        tab="dashboards"
        roots={moveIds ? [moveIds.root] : roots}
        personalNodes={moveIds?.root === 'personal' ? personalTreeNodes : []}
        domainNodes={moveIds?.root === 'domain' ? domainTreeNodes : []}
        title={`Move ${moveIds && moveIds.ids.length > 1 ? `${moveIds.ids.length} dashboards` : 'dashboard'} to folder`}
        onConfirm={({ path }) => { if (moveIds) void moveInto(moveIds.ids, path); setMoveIds(null); }}
        onCancel={() => setMoveIds(null)}
        onCreate={async (root, path) => { await createFolder(root, path); }}
      />

      {/* Move-folder picker. */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="dashboards"
        roots={folderMove ? [folderMove.scope] : roots}
        personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
        title="Move folder"
        onConfirm={({ path }) => { const ref = folderMove; setFolderMove(null); if (ref) void folderAction(ref, 'PATCH', path); }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (root, path) => { await createFolder(root, path); }}
      />

      {data && active.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 16 }}>
          {scope === 'mine' || scope === 'all'
            ? 'No dashboards yet — build one with ＋ New dashboard.'
            : scope === 'shared' ? 'Nothing in your domain yet.' : 'Nothing at the company tier yet.'}
        </div>
      ) : null}

      {scoped && active.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <FolderLayout
            allLabel="All dashboards"
            allCount={active.length}
            allSelected={sel === null}
            onSelectAll={() => setSel(null)}
            rail={
              <FolderTree
                variant="nav"
                canCreateDomain={!!user && roleAtLeast(user.role, 'domain_admin')}
                roots={roots}
                personalNodes={roots.includes('personal') ? personalTreeNodes : []}
                domainNodes={roots.includes('domain') ? domainTreeNodes : []}
                items={treeItems.filter((i) => {
                  const r = active.find((d) => d.id === i.id);
                  return r ? roots.includes(rootOf(r)) : true;
                })}
                personalLabel="My folders"
                domainLabel="Domain folders"
                selectedPath={sel?.path}
                onSelect={(root, path) => setSel((cur) => (cur && cur.root === root && cur.path === path ? null : { root, path }))}
                onCreate={createFolder}
                onMove={(ref) => setFolderMove(ref)}
                onRename={renameFolderRow}
                onArchive={async (ref) => {
                  if (!(await confirm(archiveFolderCopy(folderName(ref.path), countUnder(ref.scope, ref.path))))) return;
                  void folderAction(ref, 'archive');
                }}
                onRestore={(ref) => void folderAction(ref, 'restore')}
                onDelete={async (ref) => {
                  if (!(await confirm(deleteFolderCopy(folderName(ref.path), countUnder(ref.scope, ref.path))))) return;
                  void folderAction(ref, 'DELETE');
                }}
                renderLeaf={(item) => item.name ?? item.id}
              />
            }
          >
            {shown.length === 0 ? (
              <div className="stub-page">This folder is empty.</div>
            ) : (
              <div className="tile-grid">{shown.map(card)}</div>
            )}
          </FolderLayout>
        </div>
      ) : null}

      {/* Archived — openable tiles; the opened detail exposes Restore + Delete. */}
      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived dashboards are hidden from the working lists (retained). Open one to Restore or Delete it.
            </p>
            <div className="tile-grid">{archived.map(card)}</div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived dashboards.</div>
        )
      ) : null}
    </>
  );
}

export default function Tiles(props: {
  data: DashboardGroups | null;
  loading: boolean;
  error: string;
  onOpen: (d: DashboardSummary) => void;
  onReload?: () => void;
  showArchived?: boolean;
}) {
  // Wrap in the shared confirm provider so the folder archive/delete confirms render.
  return (
    <ConfirmProvider>
      <DashboardsInner {...props} />
    </ConfirmProvider>
  );
}
