/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import { useApi } from '@core/ui/useApi';
import { useUser } from '@core/ui/useUser';
import { canManageArtifact } from '@core/policy/edit-scope';
import NewSystemPanel from '@tabs/agents/ui/NewSystemPanel';
import { roleAtLeast } from '@core/kernel/session';
import { SCOPE_GROUPS, groupByScope, scopeCounts, visibilityScope, rootsForScope, type ScopeKey, type FolderRoot } from '@core/kernel/scopes';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@core/kernel/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@core/ui/core/FolderTree';
import FolderLayout from '@core/ui/core/FolderLayout';
import TileBadges from '@core/ui/lifecycle/TileBadges';
import { useLifecycleTiles } from '@core/ui/lifecycle/useLifecycleView';
import { ensureFolderId, renamedPath } from '@core/folders/client';
import { useFolders } from '@core/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import type { ConfirmCopy } from '@core/kernel/lifecycle';
import { useTranslations, useFormat } from '@core/i18n/client';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import type { Visibility } from '@core/kernel/lifecycle';
import { visibilityForTier } from '@core/kernel/artifact-model';
import DomainTag from '@core/ui/DomainTag';

/**
 * Level 1 — the systems list (landing). Grouped Mine / My domain / Marketplace,
 * each card showing status (running/stopped/scheduled), agent count, owner and
 * visibility. New system lands under Mine; a Marketplace install is a fork-to-own
 * independent copy you then open and edit.
 *
 * Folders (Wave-2 parity, mirrors the Data tab): a (root, path) selection in the rail
 * filters the grid; "Move to folder…" reparents a system via the edit-gated folder
 * route; folder rows are managed through the governed `/api/folders` registry.
 */

type Summary = {
  id: string; name: string; domain: string; owner: string;
  visibility: 'Personal' | 'Shared' | 'Marketplace';
  origin: 'authored' | 'forked';
  running: boolean; scheduled: boolean; agentCount: number; lastActivity: string | null;
  /** The folder this system lives in (normalised path; `'/'` = root). */
  folder: string;
  /** A Personal→Shared promotion is filed but not yet approved (governed). */
  pendingShare?: boolean;
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
};
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[] };

/** Stable id accessor for the shared lifecycle hook (a new closure would re-fetch). */
const systemId = (s: { id: string }) => s.id;

type AgentsT = ReturnType<typeof useTranslations<'agents'>>;

const visClass = (v: string) => (v === 'Shared' ? 'vis-shared' : v === 'Marketplace' ? 'vis-certified' : 'vis-personal');
// Display label from the OS-wide scope vocabulary: Shared→Domain, Marketplace→Company, Personal→My.
const VIS_KEYS = { mine: 'list.visibility.personal', shared: 'list.visibility.shared', marketplace: 'list.visibility.marketplace', all: 'list.visibility.personal' } as const;
const visLabel = (v: string, t: AgentsT) => t(VIS_KEYS[visibilityScope(v)]);

/** The shared folder-archive confirm, in the user's language (same words as the core copy in English). */
function archiveCopy(name: string, count: number, t: AgentsT): ConfirmCopy {
  return { title: t('list.confirm.archiveTitle', { name }), body: t('list.confirm.archiveBody', { name, count }), confirmLabel: t('list.confirm.archiveConfirm'), danger: false };
}
/** The shared folder physical-delete confirm — permanent, cascades to the items inside. */
function deleteCopy(name: string, count: number, t: AgentsT): ConfirmCopy {
  return { title: t('list.confirm.deleteTitle', { name }), body: t('list.confirm.deleteBody', { name, count }), confirmLabel: t('list.confirm.deleteConfirm'), danger: true };
}

/** The scope segment's label with its count, per scope group key. */
const SCOPE_KEYS = {
  all: 'list.scope.all', mine: 'list.scope.mine', shared: 'list.scope.shared', marketplace: 'list.scope.marketplace',
} as const satisfies Record<ScopeKey, string>;

/** Systems visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (v: Summary['visibility']): Visibility => visibilityForTier(v);

/** Which folder ROOT a system's folders live in — its private tree (Personal) or the
 *  domain tree (Shared/Marketplace). Mirrors how the store groups by visibility. */
function rootOf(s: Summary): FolderRoot {
  return s.visibility === 'Personal' ? 'personal' : 'domain';
}

function SystemsListInner({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations('agents');
  const f = useFormat();
  const [showArchived, setShowArchived] = useState(false);
  const [scope, setScope] = useState<ScopeKey>('all');
  const { data, loading, error, reload } = useApi<Groups>(`/api/agents/systems${showArchived ? '?archived=1' : ''}`);
  const { user } = useUser();
  const confirm = useConfirm();
  // Installing a Marketplace template is a Builder+ action (mirrors the promotion
  // ladder). Show the gate up front instead of letting the click 403.
  const canInstall = !!user && roleAtLeast(user.role, 'builder');
  const [actErr, setActErr] = useState('');

  // Folder rail (Wave-2 primitive, mirrors Data): a (root, path) selection filters the
  // grid to systems under that folder. `null` = every system in the scope.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  // Folder picker modal for system moves: the id being moved; null = closed.
  const [pickerId, setPickerId] = useState<string | null>(null);
  // Folder picker modal for folder moves: the folder ref being moved; null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  // Explicit folder rows from the governed registry, per root (unioned below with
  // folders synthesised from the visible systems' own paths so implicit ones show).
  const { personalNodes, domainNodes, loadFolders } = useFolders('agents', showArchived);

  const refresh = useCallback(() => { reload(); void loadFolders(); }, [reload, loadFolders]);

  const fork = async (id: string) => {
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}/fork`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t('list.installFailed'));
      onOpen(body.id);
    } catch (e) {
      setActErr((e as Error).message);
    }
  };

  // Move one system into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (id: string, folder: string) => {
    setActErr('');
    try {
      const res = await fetch(`/api/agents/systems/${id}/folder`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder }),
      });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.moveFailed')); return; }
      refresh();
    } catch (e) { setActErr((e as Error).message); }
  }, [refresh, t]);

  // Create a folder row in the registry, then re-load the rail.
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt(t('list.folderPrompt'));
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setActErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'agents', scope: root, path }),
      });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.createFolderFailed')); return; }
      await loadFolders();
    } catch (e) { setActErr((e as Error).message); }
  }, [loadFolders, t]);

  // A system is the caller's to manage when they are the owner, an in-domain
  // domain_admin, or an admin (the server enforces this either way).
  const canManage = (s: Summary) => !!user && canManageArtifact(user, { owner: s.owner, domain: s.domain });

  // Folder lifecycle handlers — archive, restore, delete, rename, move a folder row via
  // the governed registry API. All refresh both the systems list and the rail.
  const activeAll = useCallback((): Summary[] =>
    data ? [...(data.mine ?? []), ...(data.domain ?? []), ...(data.marketplace ?? [])].filter((s) => !s.archived) : [],
  [data]);

  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    const count = itemsUnderFolder(ref.path, activeAll().filter((s) => rootOf(s) === ref.scope)).length;
    const ok = await confirm(archiveCopy(folderName(ref.path), count, t));
    if (!ok) return;
    setActErr('');
    try {
      const id = await ensureFolderId('agents', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.archiveFailed')); return; }
      refresh();
    } catch (e) { setActErr((e as Error).message); }
  }, [confirm, activeAll, refresh, t]);

  const handleFolderRename = useCallback(async (ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    setActErr('');
    try {
      const id = await ensureFolderId('agents', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.renameFailed')); return; }
      refresh();
    } catch (e) { setActErr((e as Error).message); }
  }, [refresh, t]);

  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setActErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.restoreFailed')); return; }
      refresh();
    } catch (e) { setActErr((e as Error).message); }
  }, [refresh, t]);

  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    const count = itemsUnderFolder(ref.path, activeAll().filter((s) => rootOf(s) === ref.scope)).length;
    const ok = await confirm(deleteCopy(folderName(ref.path), count, t));
    if (!ok) return;
    setActErr('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setActErr((await res.json()).error ?? t('list.deleteFailed')); return; }
      refresh();
    } catch (e) { setActErr((e as Error).message); }
  }, [confirm, activeAll, refresh, t]);

  const card = (s: Summary, kind: 'open' | 'install') => (
    <div className="card" key={s.id}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, textTransform: 'none', letterSpacing: 0, color: 'var(--text)' }}>{s.name}</h3>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {(s.visibility === 'Shared' || s.visibility === 'Marketplace') ? <DomainTag domain={s.domain} /> : null}
          {s.archived ? <span className="badge muted">{t('list.archived')}</span> : null}
          <TileBadges kind="agent" id={s.id} audience={false} />
          <span className={`badge ${visClass(s.visibility)}`}>{visLabel(s.visibility, t)}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <span className={`badge ${s.running ? 'ok' : 'muted'}`}>{s.running ? t('list.running') : t('list.stopped')}</span>
        {s.scheduled ? <span className="badge warn">{t('list.scheduled')}</span> : null}
        {s.pendingShare ? (
          <span className="badge warn" title={t('list.pendingShareTitle')}>{t('list.pendingShare')}</span>
        ) : null}
        <span className="badge muted">{t('list.agentCount', { count: s.agentCount })}</span>
      </div>
      <div className="muted mono" style={{ marginTop: 10, fontSize: 11.5 }}>
        {s.lastActivity
          ? t('list.ownerActive', { owner: s.owner, domain: s.domain, date: f.date(s.lastActivity, { year: 'numeric', month: 'numeric', day: 'numeric' }) })
          : t('list.owner', { owner: s.owner, domain: s.domain })}
      </div>
      <div className="comp-actions" style={{ marginTop: 12, flexWrap: 'wrap', gap: 6 }}>
        {kind === 'install' ? (
          canInstall ? (
            <button className="btn sm" onClick={() => fork(s.id)}>{t('list.install')}</button>
          ) : (
            <button className="btn sm" disabled title={t('list.installGatedTitle')}>{t('list.installGated')}</button>
          )
        ) : (
          <>
            {/* Archived systems open too — Restore/Delete live inside the opened detail. */}
            <button className="btn sm" onClick={() => onOpen(s.id)}>{t('list.open')}</button>
            {canManage(s) && !s.archived ? (
              <button className="btn ghost sm" title={t('list.moveTitle')} onClick={() => setPickerId(s.id)}>{t('list.move')}</button>
            ) : null}
            {canManage(s) ? (
              <LifecycleActions
                id={s.id}
                name={s.name}
                kind="agent"
                visibility={lcVis(s.visibility)}
                archived={!!s.archived}
                api={`/api/agents/systems/${s.id}`}
                onChanged={refresh}
                compact
                surface="tile"
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

  // Which folder roots to surface in the rail + picker — driven by the active scope so
  // only the relevant tree is shown (mine→personal, shared/marketplace→domain, all→both).
  const visibleRoots = rootsForScope(scope);

  // Folder rows fed to the tree = the governed registry rows UNIONed with folders
  // synthesised from the visible systems' own paths, so implicit (pre-registry) folders
  // keep showing with zero migration. Split by root (personal/domain).
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
    const personalPaths = visible.filter((s) => rootOf(s) === 'personal').map((s) => s.folder);
    const domainPaths = visible.filter((s) => rootOf(s) === 'domain').map((s) => s.folder);
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, visible]);

  const treePersonalNodes = visibleRoots.includes('personal') ? personalTreeNodes : [];
  const treeDomainNodes = visibleRoots.includes('domain') ? domainTreeNodes : [];
  const treeItems = useMemo(() => visible.map((s) => ({ id: s.id, folder: s.folder ?? '/', name: s.name, scope: rootOf(s) })), [visible]);

  // Grid filter: when a folder is selected, show the systems under it (incl. subfolders)
  // that live in the selected root. Else the whole scope list.
  const inFolder = sel
    ? itemsUnderFolder(sel.path, visible.filter((s) => rootOf(s) === sel.root)).map((i) => visible.find((s) => s.id === i.id)!).filter(Boolean)
    : visible;
  // LIFECYCLE: the ONE shared hook — Studio shows everything, Run only what is live.
  const { tiles: shown } = useLifecycleTiles('agent', inFolder, systemId);

  return (
    <div className="systems-list">
      <div style={{ marginBottom: 18 }}>
        <NewSystemPanel onCreated={onOpen} />
      </div>

      {actErr ? <div className="error" style={{ marginBottom: 12 }}>{actErr}</div> : null}

      {/* System picker modal — move one system into a folder. Only shows roots valid
          for the current scope. */}
      <FolderPickerModal
        open={pickerId !== null}
        tab="agents"
        roots={visibleRoots}
        personalNodes={visibleRoots.includes('personal') ? personalTreeNodes : []}
        domainNodes={visibleRoots.includes('domain') ? domainTreeNodes : []}
        title={t('list.moveSystemTitle')}
        onConfirm={({ path }) => {
          if (pickerId) void moveInto(pickerId, path);
          setPickerId(null);
        }}
        onCancel={() => setPickerId(null)}
        onCreate={async (scopeRoot, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'agents', scope: scopeRoot, path }),
          });
          if (!res.ok) { setActErr((await res.json()).error ?? t('list.createFolderFailed')); return; }
          await loadFolders();
        }}
      />

      {/* Folder move modal — reparents a folder row via PATCH /api/folders/{id}. */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="agents"
        roots={folderMove ? [folderMove.scope] : visibleRoots}
        personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
        title={t('list.moveFolderTitle')}
        onConfirm={async ({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (!ref) return;
          setActErr('');
          try {
            const id = await ensureFolderId('agents', ref);
            const res = await fetch(`/api/folders/${id}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!res.ok) { setActErr((await res.json()).error ?? t('list.moveFailed')); return; }
            refresh();
          } catch (e) { setActErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scopeRoot, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'agents', scope: scopeRoot, path }),
          });
          if (!res.ok) { setActErr((await res.json()).error ?? t('list.createFolderFailed')); return; }
          await loadFolders();
        }}
      />

      <div className="section-title">
        {t('list.systems')}
        <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
          <button
            className="btn ghost"
            style={{ opacity: 1 }}
            onClick={() => setShowArchived((v) => !v)}
            title={t('list.archivedTitle')}
          >
            {showArchived ? t('list.hideArchived') : t('list.showArchived')}
          </button>
          <button className="btn ghost" onClick={refresh} disabled={loading}>
            {loading ? <span className="spin" /> : t('list.refresh')}
          </button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {data ? (
        <>
          {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
          <div className="seg" style={{ marginBottom: 16 }}>
            {SCOPE_GROUPS.map((g) => (
              <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => { setScope(g.key); setSel(null); }}>
                {counts ? t(SCOPE_KEYS[g.key], { count: counts[g.key] }) : null}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <div className="stub-page" style={{ padding: 24 }}>
              {scope === 'mine' || scope === 'all'
                ? t('list.emptyMine')
                : scope === 'shared' ? t('list.emptyDomain') : t('list.emptyCompany')}
            </div>
          ) : (
            <FolderLayout
              allLabel={t('list.allSystems')}
              allCount={visible.length}
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
                  personalLabel={t('list.myFolders')}
                  domainLabel={t('list.domainFolders')}
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
              {shown.length === 0 ? (
                <div className="stub-page">{t('list.folderEmpty')}</div>
              ) : (
                <div className="grid">{shown.map((s) => card(s, kindFor(s)))}</div>
              )}
            </FolderLayout>
          )}
        </>
      ) : loading ? (
        <div className="stub-page"><span className="spin" /> {t('list.loading')}</div>
      ) : null}
    </div>
  );
}

export default function SystemsList({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <ConfirmProvider>
      <SystemsListInner onOpen={onOpen} />
    </ConfirmProvider>
  );
}
