/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { SCOPE_GROUPS, groupByScope, scopeCounts, showDomainForScope, type ScopeKey } from '@/lib/core/scopes';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import {
  TIER_BADGE,
  TIER_LABEL,
  TASK_LABEL,
  BUILD_STATE,
  type ModelGroups,
  type ModelSummary,
} from './shared';

/**
 * The models LIST surface — every model the user can see, grouped All · My · Shared ·
 * Marketplace via the OS-wide scope helper (identical to Dashboards' Tiles). Each tile
 * shows the task-type chip, a coloured buildState status dot, and the tier badge.
 * Clicking a tile OPENS its detail. The ＋ New model button + archived toggle live in
 * the tab header row above (canonical).
 *
 * FOLDERS (Wave-2 parity, mirrors DatasetTiles): a FolderTree nav rail filters the grid
 * to models under a folder, with a per-tile "Move…" affordance + a FolderPickerModal.
 * SCOPE JUDGMENT CALL: models are DOMAIN-scoped (a Personal-tier model is owner-only but
 * still homed in its owning domain — there is no cross-tenant personal lane like the Data
 * tab's `personal_<uid>` schema). So the tree renders ONLY the domain root
 * (`roots={['domain']}`) and every model's folders live in the domain tree.
 */

/** Models are domain-scoped → their folders always live in the DOMAIN tree. */
const MODEL_ROOTS = ['domain'] as const;

function ModelTilesInner({
  data,
  loading,
  error,
  onOpen,
  onChanged,
  showArchived = false,
}: {
  data: ModelGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: ModelSummary) => void;
  onChanged?: () => void;
  showArchived?: boolean;
}) {
  const [scope, setScope] = useState<ScopeKey>('all');
  const { user } = useUser();
  const confirm = useConfirm();
  const [err, setErr] = useState('');
  // Folder rail selection: a path filters the grid to models under it; null = all.
  const [sel, setSel] = useState<{ path: string } | null>(null);
  // Folder picker modal for model moves: ids being moved; null = closed.
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  // Folder picker modal for folder moves: the folder ref being moved; null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  const { domainNodes, loadFolders } = useFolders('science', showArchived);

  const uid = user?.id ?? '';
  const groups = data ? { mine: data.mine, domain: data.domain, marketplace: data.marketplace } : null;
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const scopedAll = scoped ? scoped[scope] : [];
  const visible = scopedAll.filter((m) => !m.archived);
  const archived = scopedAll.filter((m) => m.archived);

  // A model is the caller's to manage under the ONE canonical edit-scope rule the
  // move/archive routes enforce: owner, in-domain domain_admin, or admin.
  const canManage = useCallback(
    (m: ModelSummary) => !!user && canManageArtifact(user, { owner: m.owner, domain: m.domain }),
    [user],
  );

  // Folder rows fed to the tree = the governed registry rows UNIONed with folders
  // synthesised from the visible models' own paths, so implicit ones keep showing.
  const domainTreeNodes = useMemo(() => {
    const seen = new Set(domainNodes.map((r) => normaliseFolderPath(r.path)));
    const out: FolderPathNode[] = [...domainNodes];
    for (const m of visible) {
      const n = normaliseFolderPath(m.folder ?? '/');
      if (n !== '/' && !seen.has(n)) { seen.add(n); out.push({ path: n }); }
    }
    return out;
  }, [domainNodes, visible]);

  const treeItems = useMemo(
    // Models are domain-scoped only (no personal root), so every item pins to 'domain' —
    // keeps them out of the personal tree per the FolderTreeItem.scope contract.
    () => visible.map((m) => ({ id: m.model, folder: m.folder ?? '/', name: m.name, scope: 'domain' as const })),
    [visible],
  );

  // Grid filter: when a folder is selected, show models under it (incl. subfolders).
  const shown = sel ? itemsUnderFolder(sel.path, visible.map((m) => ({ ...m, folder: m.folder ?? '/' }))) : visible;

  // Move one or many models into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/science/model/${encodeURIComponent(id)}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) { setErr((await res.json()).error ?? 'Move failed'); }
      } catch (e) { setErr((e as Error).message); }
    }
    await loadFolders();
    // The parent owns the model list — reload it so the grid re-derives each model's
    // new folder (the tiles read `data.mine/domain/marketplace` from the parent).
    onChanged?.();
  }, [loadFolders, onChanged]);

  const createFolderRow = useCallback(async (_root: 'personal' | 'domain', parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'science', scope: 'domain', path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders]);

  const handleFolderRename = useCallback(async (ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    setErr('');
    try {
      const id = await ensureFolderId('science', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Rename failed'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders]);

  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    const count = itemsUnderFolder(ref.path, visible.map((m) => ({ ...m, folder: m.folder ?? '/' }))).length;
    const ok = await confirm(archiveFolderCopy(folderName(ref.path), count));
    if (!ok) return;
    setErr('');
    try {
      const id = await ensureFolderId('science', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Archive failed'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, visible, loadFolders]);

  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Restore failed'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders]);

  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    const count = itemsUnderFolder(ref.path, visible.map((m) => ({ ...m, folder: m.folder ?? '/' }))).length;
    const ok = await confirm(deleteFolderCopy(folderName(ref.path), count));
    if (!ok) return;
    setErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setErr((await res.json()).error ?? 'Delete failed'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [confirm, visible, loadFolders]);

  const card = (m: ModelSummary) => {
    const bs = m.buildState ? BUILD_STATE[m.buildState] : null;
    const manage = canManage(m);
    return (
      <div key={m.model} style={{ position: 'relative' }}>
        <button
          type="button"
          className="card tile"
          onClick={() => onOpen(m)}
          title="Open this model — overview, predict, promote or govern it"
        >
          <div className="tile-top">
            <span className="tile-name">{m.name}</span>
            <div className="row" style={{ gap: 4, alignItems: 'center' }}>
              {showDomainForScope(scope) ? <DomainTag domain={m.domain} /> : null}
              <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_LABEL[m.tier]}</span>
            </div>
          </div>
          <div className="tile-meta muted" style={{ alignItems: 'center', gap: 6 }}>
            {m.spec ? <span className="badge muted">{TASK_LABEL[m.spec.taskType]}</span> : null}
            {bs ? (
              <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                <span className={`status-dot ${bs.dot}`} />
                <span>{bs.label}</span>
              </span>
            ) : null}
          </div>
          <div className="tile-foot">
            <span className="hint" style={{ marginTop: 0 }}>owner {m.owner}</span>
            <span className="hint" style={{ marginTop: 0 }}>open ↗</span>
          </div>
        </button>
        {manage && !m.archived ? (
          <div
            className="row"
            style={{ position: 'absolute', bottom: 10, right: 10, gap: 6 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="btn ghost sm" title="Move to folder" onClick={() => setPickerIds([m.model])}>
              Move…
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      {(error || err) ? <div className="error" style={{ marginTop: 16 }}>{error || err}</div> : null}
      {loading && !data ? <div className="stub-page">Loading models…</div> : null}

      {data ? (
        <div className="seg" style={{ marginTop: 14 }}>
          {SCOPE_GROUPS.map((g) => (
            <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => { setScope(g.key); setSel(null); }}>
              {g.label('Models')}{counts ? ` (${counts[g.key]})` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {/* Move-to-folder picker (single- or multi-model). Domain root only. */}
      <FolderPickerModal
        open={pickerIds !== null}
        tab="science"
        roots={MODEL_ROOTS as unknown as ('personal' | 'domain')[]}
        personalNodes={[]}
        domainNodes={domainTreeNodes}
        title={`Move ${pickerIds && pickerIds.length > 1 ? `${pickerIds.length} models` : 'model'} to folder`}
        onConfirm={({ path }) => { if (pickerIds) void moveInto(pickerIds, path); setPickerIds(null); }}
        onCancel={() => setPickerIds(null)}
        onCreate={async (scopeArg, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'science', scope: scopeArg, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      {/* Folder move modal — reparents a folder row via PATCH /api/folders/{id}. */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="science"
        roots={MODEL_ROOTS as unknown as ('personal' | 'domain')[]}
        personalNodes={[]}
        domainNodes={domainTreeNodes}
        title="Move folder"
        onConfirm={async ({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (!ref) return;
          setErr('');
          try {
            const id = await ensureFolderId('science', ref);
            const res = await fetch(`/api/folders/${id}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!res.ok) { setErr((await res.json()).error ?? 'Move failed'); return; }
            await loadFolders();
          } catch (e) { setErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scopeArg, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'science', scope: scopeArg, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      {data && visible.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 16 }}>
          {scope === 'mine' || scope === 'all'
            ? 'No models yet — register one with ＋ New model.'
            : scope === 'shared' ? 'Nothing in your domain yet.' : 'Nothing at the company tier yet.'}
        </div>
      ) : null}

      {visible.length ? (
        <div style={{ marginTop: 16 }}>
          <FolderLayout
            allLabel="All models"
            allCount={visible.length}
            allSelected={sel === null}
            onSelectAll={() => setSel(null)}
            rail={
              <FolderTree
                variant="nav"
                canCreateDomain={!!user && roleAtLeast(user.role, 'domain_admin')}
                roots={MODEL_ROOTS as unknown as ('personal' | 'domain')[]}
                personalNodes={[]}
                domainNodes={domainTreeNodes}
                items={treeItems}
                personalLabel="My folders"
                domainLabel="Domain folders"
                selectedPath={sel?.path}
                onSelect={(_root, path) => setSel({ path })}
                onCreate={createFolderRow}
                onMove={(ref) => setFolderMove(ref)}
                onRename={handleFolderRename}
                onArchive={handleFolderArchive}
                onRestore={handleFolderRestore}
                onDelete={handleFolderDelete}
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

      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived models are hidden from the working lists (retained). Open one to Restore or Delete it.
            </p>
            <div className="tile-grid">{archived.map(card)}</div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived models.</div>
        )
      ) : null}
    </>
  );
}

export default function ModelTiles(props: {
  data: ModelGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: ModelSummary) => void;
  onChanged?: () => void;
  showArchived?: boolean;
}) {
  return (
    <ConfirmProvider>
      <ModelTilesInner {...props} />
    </ConfirmProvider>
  );
}
