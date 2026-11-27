/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from '@core/ui/PageHeader';
import WorkflowTile from '@tabs/knowledge/ui/WorkflowTile';
import { useLifecycleTiles } from '@core/ui/lifecycle/useLifecycleView';
import WorkflowView from '@tabs/knowledge/ui/WorkflowView';
import type { WorkflowSummary } from '@tabs/knowledge/lib/store';
import { roleAtLeast, type Role } from '@core/kernel/session';
import { useTabNavReset } from '@core/kernel/tab-nav';
import { SCOPE_GROUPS, groupByScope, activeScopeCounts, rootsForScope, type ScopeKey, type FolderRoot } from '@core/kernel/scopes';
import { ConfirmProvider } from '@core/ui/lifecycle/ConfirmDialog';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import type { Visibility as LcVisibility } from '@core/kernel/lifecycle';
import FolderLayout from '@core/ui/core/FolderLayout';
import FolderTree, { FolderPickerModal } from '@core/ui/core/FolderTree';
import { useFolders } from '@core/folders/useFolders';
import { itemsUnderFolder, normaliseFolderPath, type FolderPathNode } from '@core/kernel/folders';
import { useTranslations } from '@core/i18n/client';

/** The scope segment's label (with its count once loaded), per scope group key. */
const SCOPE_KEYS = {
  all: 'scope.all', mine: 'scope.mine', shared: 'scope.shared', marketplace: 'scope.marketplace',
} as const satisfies Record<ScopeKey, string>;

/** Workflow visibility → OS-wide lifecycle visibility. */
const lcVis = (v: 'Personal' | 'Shared' | 'Marketplace'): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

/** Which folder ROOT a process's folders live in — its private tree (Personal) or the
 *  domain tree (Shared/Certified). Mirrors how the store groups by visibility. */
const rootOf = (w: WorkflowSummary): FolderRoot => (w.visibility === 'Personal' ? 'personal' : 'domain');

type WorkflowGroups = {
  mine: WorkflowSummary[];
  domain: WorkflowSummary[];
  marketplace: WorkflowSummary[];
};

type UserInfo = { id: string; role: Role; domains: string[] };

/** Stable id accessor for the shared lifecycle hook (a new closure would re-fetch). */
const workflowId = (w: { id: string }) => w.id;

export default function WorkflowsPage() {
  const t = useTranslations('workflows');
  const tc = useTranslations('common');
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Clicking the Workflows sidebar link while inside a detail returns to the list.
  useTabNavReset(() => { setSelectedWorkflowId(null); setView('list'); });

  const [groups, setGroups] = useState<WorkflowGroups | null>(null);
  const [wfScope, setWfScope] = useState<ScopeKey>('all');
  const [wfLoading, setWfLoading] = useState(true);
  const [wfError, setWfError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Folder rail (mirrors the Data tab): a (root, path) selection filters the grid.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  // Folder picker modal for a single-process move; null = closed.
  const [moveId, setMoveId] = useState<string | null>(null);
  const { personalNodes, domainNodes, loadFolders } = useFolders('workflows', showArchived);

  // New workflow form
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // User info for role-based UI
  const [user, setUser] = useState<UserInfo | null>(null);

  const loadWorkflows = useCallback(async () => {
    setWfLoading(true);
    setWfError('');
    try {
      const res = await fetch(`/api/knowledge/workflows${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      if (res.ok) { setGroups(await res.json()); void loadFolders(); }
      else setWfError(t('errors.loadFailed'));
    } catch {
      setWfError(t('errors.network'));
    } finally {
      setWfLoading(false);
    }
  }, [showArchived, loadFolders, t]);

  // Move one process into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (id: string, folder: string) => {
    try {
      const res = await fetch(`/api/knowledge/workflows/${id}/folder`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder }),
      });
      if (!res.ok) { setWfError((await res.json()).error ?? t('errors.moveFailed')); return; }
    } catch (e) { setWfError((e as Error).message); }
    setMoveId(null);
    await loadWorkflows();
  }, [loadWorkflows, t]);

  const createFolderRow = useCallback(async (root: FolderRoot, path: string) => {
    const res = await fetch('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'workflows', scope: root, path }),
    });
    if (!res.ok) { setWfError((await res.json()).error ?? t('errors.folderCreateFailed')); return; }
    await loadFolders();
  }, [loadFolders, t]);

  useEffect(() => {
    void loadWorkflows();
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && setUser(d.user))
      .catch(() => null);
  }, [loadWorkflows]);

  async function createWorkflow() {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/knowledge/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const d = await res.json();
      if (!res.ok) { setCreateError(d.error ?? t('errors.createFailed')); return; }
      setNewTitle('');
      await loadWorkflows();
      setSelectedWorkflowId(d.id);
      setView('detail');
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const canPublish = !!user && roleAtLeast(user.role, 'builder');
  const uid = user?.id ?? '';
  const allWorkflows = [
    ...(groups?.mine ?? []),
    ...(groups?.domain ?? []),
    ...(groups?.marketplace ?? []),
  ];
  const wfScoped = groups ? groupByScope(groups, uid) : null;
  const wfCounts = groups ? activeScopeCounts(groups, uid) : null;
  const scopedWorkflows = (wfScoped ? wfScoped[wfScope] : []).filter((w) => !w.archived);
  const archivedWorkflows = allWorkflows.filter((w) => w.archived);

  // Folder rail: which roots the current scope surfaces, plus the tree nodes (governed
  // registry rows UNIONed with folders synthesised from each visible process's own path,
  // so implicit folders keep showing). Split by root (personal / domain).
  const visibleRoots = rootsForScope(wfScope);
  const [treePersonal, treeDomain] = useMemo(() => {
    const synth = (rows: FolderPathNode[], paths: string[]): FolderPathNode[] => {
      const seen = new Set(rows.map((r) => normaliseFolderPath(r.path)));
      const out = [...rows];
      for (const p of paths) {
        const n = normaliseFolderPath(p);
        if (n !== '/' && !seen.has(n)) { seen.add(n); out.push({ path: n }); }
      }
      return out;
    };
    const pPaths = scopedWorkflows.filter((w) => rootOf(w) === 'personal').map((w) => w.folder ?? '/');
    const dPaths = scopedWorkflows.filter((w) => rootOf(w) === 'domain').map((w) => w.folder ?? '/');
    return [synth(personalNodes, pPaths), synth(domainNodes, dPaths)];
  }, [personalNodes, domainNodes, scopedWorkflows]);
  const treeItems = scopedWorkflows.map((w) => ({ id: w.id, folder: w.folder ?? '/', name: w.title }));
  // Grid filter: a folder selection narrows to processes under it (incl. subfolders) in
  // the selected root; else the whole scoped list.
  const inFolder = sel
    ? itemsUnderFolder(sel.path, scopedWorkflows.filter((w) => rootOf(w) === sel.root).map((w) => ({ ...w, folder: w.folder ?? '/' })))
    : scopedWorkflows;
  // LIFECYCLE: the ONE shared hook — Studio shows everything, Run only what is live.
  const { tiles: shownWorkflows } = useLifecycleTiles('knowledge', inFolder, workflowId);
  const moveScope: FolderRoot = groups && moveId
    ? rootOf(allWorkflows.find((w) => w.id === moveId) ?? scopedWorkflows[0] ?? { visibility: 'Personal' } as WorkflowSummary)
    : 'personal';

  const openWorkflow = (id: string) => { setSelectedWorkflowId(id); setView('detail'); };

  // Mirror the detail view's edit heuristic (GET route: owner OR builder+). Move is
  // re-checked server-side (canManageArtifact), so this only avoids dead controls.
  const canEditWf = (w: WorkflowSummary) => w.owner === uid || (!!user && roleAtLeast(user.role, 'builder'));

  const renderCell = (w: WorkflowSummary) => (
    <div key={w.id} className="k-wf-cell">
      <WorkflowTile workflow={w} onClick={openWorkflow} />
      <div className="k-wf-actions">
        {!w.archived && canEditWf(w) ? (
          <button className="btn ghost sm" title={t('list.moveTitle')} onClick={() => setMoveId(w.id)}>{t('list.move')}</button>
        ) : null}
        <LifecycleActions
          id={w.id}
          name={w.title}
          kind="knowledge"
          visibility={lcVis(w.visibility)}
          archived={!!w.archived}
          api={`/api/knowledge/workflows/${w.id}`}
          onChanged={() => void loadWorkflows()}
          compact
          surface={w.archived ? 'detail' : 'tile'}
        />
      </div>
    </div>
  );

  // ── Workflow detail ───────────────────────────────────────────────────────

  if (view === 'detail' && selectedWorkflowId) {
    return (
      <WorkflowView
        workflowId={selectedWorkflowId}
        onBack={() => { setSelectedWorkflowId(null); setView('list'); void loadWorkflows(); }}
      />
    );
  }

  return (
    <ConfirmProvider>
      <PageHeader title={t('page.title')} crumb={t('page.crumb')} />
      <div className="content">

        <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn ghost"
              style={{ opacity: showArchived ? 1 : 0.7 }}
              onClick={() => setShowArchived((s) => !s)}
              title={t('list.archivedToggleTitle')}
            >
              {showArchived ? t('list.hideArchived') : t('list.showArchived')}
            </button>
            <button
              className="btn"
              onClick={() => setView(view === 'new' ? 'list' : 'new')}
            >
              {view === 'new' ? tc('actions.cancel') : t('list.newProcess')}
            </button>
          </div>
        </div>

        {view === 'new' && (
          <div className="k-new-form">
            <form
              onSubmit={(e) => { e.preventDefault(); void createWorkflow(); }}
              className="row"
              style={{ gap: 10, marginTop: 14, alignItems: 'flex-start' }}
            >
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t('create.placeholder')}
                autoFocus
                style={{ flex: 1 }}
              />
              <button className="btn" type="submit" disabled={creating || !newTitle.trim()}>
                {creating ? <span className="spin" /> : t('create.submit')}
              </button>
            </form>
            {createError && <div className="error" style={{ marginTop: 8 }}>{createError}</div>}
          </div>
        )}

        {wfLoading ? (
          <div className="stub-page" style={{ marginTop: 24 }}>
            <span className="spin" /> {t('list.loading')}
          </div>
        ) : wfError ? (
          <div className="error" style={{ marginTop: 16 }}>{wfError}</div>
        ) : (
          <>
            {/* Scope switcher — All · My · Shared · Marketplace. */}
            <div className="seg" style={{ marginTop: 18 }}>
              {SCOPE_GROUPS.map((g) => (
                <button key={g.key} type="button" className={wfScope === g.key ? 'on' : ''} onClick={() => { setWfScope(g.key); setSel(null); }}>
                  {t(SCOPE_KEYS[g.key], { hasCount: wfCounts ? 'yes' : 'no', count: wfCounts ? wfCounts[g.key] : 0 })}
                </button>
              ))}
            </div>

            {/* Single-process move modal — scoped to the process's own tier root. */}
            <FolderPickerModal
              open={moveId !== null}
              tab="workflows"
              roots={[moveScope]}
              personalNodes={moveScope === 'personal' ? treePersonal : []}
              domainNodes={moveScope === 'domain' ? treeDomain : []}
              title={t('list.pickerTitle')}
              onConfirm={({ path }) => { if (moveId) void moveInto(moveId, path); }}
              onCancel={() => setMoveId(null)}
              onCreate={createFolderRow}
            />

            {scopedWorkflows.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <FolderLayout
                  allLabel={t('list.allLabel')}
                  allCount={scopedWorkflows.length}
                  allSelected={sel === null}
                  onSelectAll={() => setSel(null)}
                  rail={
                    <FolderTree
                      variant="nav"
                      canCreateDomain={!!user && roleAtLeast(user.role, 'domain_admin')}
                      roots={visibleRoots}
                      personalNodes={visibleRoots.includes('personal') ? treePersonal : []}
                      domainNodes={visibleRoots.includes('domain') ? treeDomain : []}
                      items={treeItems}
                      personalLabel={t('list.personalFolders')}
                      domainLabel={t('list.domainFolders')}
                      selectedPath={sel?.path}
                      onSelect={(root, path) => setSel({ root, path })}
                      onCreate={(root, parentPath) => {
                        const name = window.prompt(t('list.folderPrompt'));
                        if (!name || !name.trim()) return;
                        void createFolderRow(root, normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`));
                      }}
                      renderLeaf={(item) => item.name ?? item.id}
                    />
                  }
                >
                  {shownWorkflows.length === 0 ? (
                    <div className="stub-page">{t('list.folderEmpty')}</div>
                  ) : (
                    <div className="k-workflow-grid">{shownWorkflows.map(renderCell)}</div>
                  )}
                </FolderLayout>
              </div>
            ) : null}

            {scopedWorkflows.length === 0 && !showArchived && (
              <div className="stub-page" style={{ marginTop: 32 }}>
                {wfScope === 'mine' || wfScope === 'all'
                  ? t('list.empty.mine')
                  : wfScope === 'shared'
                    ? t('list.empty.domain')
                    : t('list.empty.company')}
              </div>
            )}

            {showArchived && (
              archivedWorkflows.length > 0 ? (
                <>
                  <div className="section-title" style={{ marginTop: 28 }}>{t('archived.title')}</div>
                  <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                    {t('archived.hint')}
                  </p>
                  <div className="k-workflow-grid">{archivedWorkflows.map(renderCell)}</div>
                </>
              ) : (
                <div className="hint" style={{ marginTop: 20 }}>{t('archived.none')}</div>
              )
            )}

            {!canPublish && allWorkflows.some((w) => w.status === 'draft') && (
              <div className="hint" style={{ marginTop: 16 }}>
                {t('list.draftHint')}
              </div>
            )}
          </>
        )}

      </div>

      <style>{WorkflowStyles}</style>
    </ConfirmProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped styles (match the design system palette; mirrors the workflow section
// that lived in KnowledgeStyles).
// ─────────────────────────────────────────────────────────────────────────────

const WorkflowStyles = `
.k-workflow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(256px, 1fr));
  gap: 14px;
  margin-top: 12px;
}
.k-wf-cell { display: flex; flex-direction: column; gap: 6px; }
.k-wf-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  opacity: 0.7;
  transition: opacity 0.14s;
}
.k-wf-cell:hover .k-wf-actions { opacity: 1; }
.k-wf-actions .k-danger { color: var(--danger, #d9534f); border-color: var(--danger, #d9534f); }

.k-new-form {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-top: 14px;
}

.workflow-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.14s, box-shadow 0.14s;
  color: var(--text);
  font-family: var(--font-body);
  width: 100%;
}
.workflow-tile:hover {
  border-color: var(--gold-line);
  box-shadow: 0 0 0 1px var(--gold-line), 0 4px 14px rgba(200,162,74,0.07);
}
.workflow-tile-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.workflow-tile-title {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.3px;
  line-height: 1.25;
  flex: 1;
}
.workflow-tile-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
`;
