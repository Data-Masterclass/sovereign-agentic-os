/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { SCOPE_GROUPS, groupByScope, scopeCounts, rootsForScope, showDomainForScope, type ScopeKey, type FolderRoot } from '@/lib/core/scopes';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import {
  itemsUnderFolder,
  normaliseFolderPath,
  folderName,
  type FolderPathNode,
} from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import {
  type MetricGroups,
  type MetricSummary,
  TIER_BADGE,
  TIER_WORD,
} from './shared';

/**
 * The governed metric registry — every measure the user can see, grouped All · My ·
 * Shared · Marketplace via the OS-wide scope helper, now WITH the shared folder primitive
 * (the same `FolderTree` rail + one folder lifecycle Files / Data / Knowledge use). A
 * metric is a measure on a governed dataset, so its folder path rides the metric
 * lifecycle overlay; otherwise the UX is identical to the other foldered tabs.
 *
 * SCOPE-DRIVEN SINGLE ROOT: an item's folder root is tier-bound (personal metric →
 * personal tree; shared/marketplace metric → domain tree). The rail + move picker show
 * ONLY the root(s) that match the active scope segment, so a move can only ever target a
 * folder the metric can actually live in.
 */

/** Which folder ROOT a metric's folders live in — personal (mine) or domain (shared/mkt). */
function rootOf(m: MetricSummary): FolderRoot {
  return m.tier === 'personal' ? 'personal' : 'domain';
}

function MetricCard({
  m, onOpen, scope, canManage, onMove, picked, onPick,
}: {
  m: MetricSummary; onOpen: (m: MetricSummary) => void; scope: ScopeKey;
  canManage: boolean; onMove?: (m: MetricSummary) => void;
  picked?: boolean; onPick?: (checked: boolean) => void;
}) {
  const showDomain = showDomainForScope(scope);
  // FAIL-SOFT: one metric's model couldn't load — render its reason inline, non-clickable,
  // so the rest of the registry stays live (one bad cube never 500s the whole surface).
  if (m.error) {
    return (
      <div
        className="card tile"
        style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120, boxSizing: 'border-box', opacity: 0.85 }}
        title="This metric's model could not be loaded"
      >
        <div className="tile-top">
          <span className="tile-name">{m.name}</span>
          <span className="badge warn">unavailable</span>
        </div>
        <div className="error" style={{ marginTop: 4, fontSize: 12 }}>{m.error}</div>
      </div>
    );
  }
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(m)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(m); }}
      className="card tile"
      style={{
        cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 120, boxSizing: 'border-box',
        ...(picked ? { borderColor: 'var(--gold-line)', boxShadow: '0 0 0 1px var(--gold-line)' } : {}),
      }}
      title="Open this metric — explore, govern, or set an alert"
    >
      <div className="tile-top">
        <div className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
          {onPick ? (
            // Multi-select for bulk archive. Stop the click so ticking a card
            // doesn't also open it.
            <input
              type="checkbox" className="file-pick" aria-label={`Select ${m.name}`}
              checked={!!picked}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onPick(e.target.checked)}
            />
          ) : null}
          <span className="tile-name">{m.name}</span>
        </div>
        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
          {showDomain ? <DomainTag domain={m.domain} /> : null}
          <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_WORD[m.tier]}</span>
        </div>
      </div>
      <div className="muted mono" style={{ fontSize: 12 }}>{m.member}</div>
      <div className="tile-meta" style={{ marginTop: 'auto' }}>
        <span className="muted">{m.owner}</span>
        <span className="dot-sep">·</span>
        <span className="muted">{m.datasetName}</span>
        <span className="dot-sep">·</span>
        <span className="badge muted">{m.type}</span>
      </div>
      {canManage && onMove ? (
        <div className="row" style={{ gap: 6, marginTop: 4, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn ghost sm" title="Move to folder" onClick={stop(() => onMove(m))}>
            Move…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MetricsRegistryInner({
  groups,
  loading,
  error,
  onOpen,
  onDefine,
  onReload,
  showArchived = false,
  onToggleArchived,
}: {
  groups: MetricGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: MetricSummary) => void;
  onDefine: () => void;
  onReload?: () => void;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}) {
  const { user } = useUser();
  const confirm = useConfirm();
  const [scope, setScope] = useState<ScopeKey>('all');
  const [err, setErr] = useState('');
  // Folder rail selection (root, path) — mirrors Files/Data. `null` = every metric.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  const { personalNodes, domainNodes, loadFolders } = useFolders('metrics', showArchived);
  // Move picker: which metric ids are moving; null = closed.
  const [moveIds, setMoveIds] = useState<{ ids: string[]; root: FolderRoot } | null>(null);
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  // Multi-select in the grid → bulk archive. `picked` is the ticked metric ids.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // A bulk op is running (disable the bar); a concise honest result notice
  // ("N archived / K failed / S skipped") shown until the next selection change.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState('');

  useEffect(() => { void loadFolders(); }, [loadFolders, groups]);

  const uid = user?.id ?? '';
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const scopedAll = (scoped ? scoped[scope] : []) as MetricSummary[];
  const active = scopedAll.filter((m) => !m.archived);
  const archived = scopedAll.filter((m) => m.archived);

  const canManage = useCallback(
    (m: MetricSummary) => !!user && canManageArtifact(user, { owner: m.owner, domain: m.domain ?? '' }),
    [user],
  );

  const roots = rootsForScope(scope);

  // Folder rows fed to the tree = registry rows UNIONed with folders synthesised from the
  // visible metrics' own paths, so implicit folders keep showing. Split by root.
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
    const personalPaths = active.filter((m) => rootOf(m) === 'personal').map((m) => m.folder);
    const domainPaths = active.filter((m) => rootOf(m) === 'domain').map((m) => m.folder);
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, active]);

  const treeItems = useMemo(
    () => active.map((m) => ({ id: m.id, folder: m.folder, name: m.name })),
    [active],
  );

  // Grid filter: a selected folder shows metrics under it (incl. subfolders) in that root.
  const shown = sel
    ? itemsUnderFolder(sel.path, active.filter((m) => rootOf(m) === sel.root))
    : active;

  // Bulk selection helpers: the ticked metrics (resolved from the visible set) and
  // whether the whole current view is already selected — drives the select-all toggle.
  const pickedMetrics = shown.filter((m) => picked.has(m.id));
  const allInViewPicked = shown.length > 0 && shown.every((m) => picked.has(m.id));

  const reload = useCallback(() => { onReload?.(); void loadFolders(); }, [onReload, loadFolders]);

  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/metrics/${encodeURIComponent(id)}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? 'Move failed');
      } catch (e) { setErr((e as Error).message); }
    }
    reload();
  }, [reload]);

  // Bulk ARCHIVE — reuses the SAME per-metric archive endpoint the single-metric
  // lifecycle uses (POST /api/metrics/{id} {action:'archive'}), looped per id.
  // Confirmed once via the shared ConfirmDialog. Only metrics the user can manage
  // are attempted; the rest are reported as skipped. Honest per-run summary.
  const bulkArchive = useCallback(async (metrics: MetricSummary[]) => {
    const eligible = metrics.filter((m) => !m.error && canManage(m));
    const skipped = metrics.length - eligible.length;
    if (eligible.length === 0) {
      setBulkNotice(`Nothing to archive — ${skipped} not yours to manage.`);
      return;
    }
    if (!(await confirm(archiveFolderCopy(`${eligible.length} metric${eligible.length > 1 ? 's' : ''}`, eligible.length)))) return;
    setBulkBusy(true); setBulkNotice(''); setErr('');
    let archivedCount = 0; let failed = 0;
    for (const m of eligible) {
      try {
        const res = await fetch(`/api/metrics/${encodeURIComponent(m.id)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'archive' }),
        });
        if (res.ok) archivedCount += 1; else failed += 1;
      } catch { failed += 1; }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(`${archivedCount} archived${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}.`);
    reload();
  }, [canManage, confirm, reload]);

  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    const res = await fetch('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'metrics', scope: root, path }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not create folder'); return; }
    await loadFolders();
  }, [loadFolders]);

  const countUnder = useCallback((root: FolderRoot, path: string) =>
    itemsUnderFolder(path, active.filter((m) => rootOf(m) === root)).length, [active]);

  const folderAction = useCallback(async (ref: FolderRef, method: 'PATCH' | 'DELETE' | 'archive' | 'restore', path?: string) => {
    setErr('');
    try {
      // A synthetic (implicit) folder has no registry row → materialise one so any
      // folder the user sees can be archived/renamed/moved (delete/restore only ever
      // reach a real archived row, so ensureFolderId is a no-op there).
      const id = await ensureFolderId('metrics', ref);
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

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <p className="lead" style={{ marginTop: 4, flex: 1, minWidth: 280 }}>
          Every business metric, defined once. Each card carries its single canonical
          definition — the Cube <strong>member</strong> the explorer, dashboards and the agent
          all resolve. Open one to explore it under your own identity, govern its tier, or set an alert.
        </p>
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          {onToggleArchived ? (
            <button className="btn ghost" style={{ opacity: 1 }} onClick={onToggleArchived}
              title="Archived metrics are hidden by default">
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
          ) : null}
          <button className="btn" onClick={onDefine}>＋ Define metric</button>
        </div>
      </div>

      {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
      <div className="seg" style={{ marginTop: 14 }}>
        {SCOPE_GROUPS.map((g) => (
          <button key={g.key} type="button" className={scope === g.key ? 'on' : ''}
            onClick={() => { setScope(g.key); setSel(null); setPicked(new Set()); setBulkNotice(''); }}>
            {g.label('Metrics')}{counts ? ` (${counts[g.key]})` : ''}
          </button>
        ))}
      </div>

      {(error || err) ? <div className="error" style={{ marginTop: 14 }}>{error || err}</div> : null}

      {/* Move-metric picker (scope-driven single root). */}
      <FolderPickerModal
        open={moveIds !== null}
        tab="metrics"
        roots={moveIds ? [moveIds.root] : roots}
        personalNodes={moveIds?.root === 'personal' ? personalTreeNodes : []}
        domainNodes={moveIds?.root === 'domain' ? domainTreeNodes : []}
        title={`Move ${moveIds && moveIds.ids.length > 1 ? `${moveIds.ids.length} metrics` : 'metric'} to folder`}
        onConfirm={({ path }) => { if (moveIds) void moveInto(moveIds.ids, path); setMoveIds(null); }}
        onCancel={() => setMoveIds(null)}
        onCreate={async (root, path) => { await createFolder(root, path); }}
      />

      {/* Move-folder picker. */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="metrics"
        roots={folderMove ? [folderMove.scope] : roots}
        personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
        title="Move folder"
        onConfirm={({ path }) => { const ref = folderMove; setFolderMove(null); if (ref) void folderAction(ref, 'PATCH', path); }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (root, path) => { await createFolder(root, path); }}
      />

      {groups && active.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          {scope === 'mine' || scope === 'all'
            ? <>No metrics yet. <strong>Define</strong> one on a governed Gold dataset to see it here.</>
            : scope === 'shared'
              ? 'Nothing in your domain yet — promote a metric to share it.'
              : 'Nothing at the company tier yet.'}
        </div>
      ) : null}

      {scoped ? (
        active.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <FolderLayout
              allLabel="All metrics"
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
                    const r = active.find((m) => m.id === i.id);
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
                <>
                  {/* Select-all: ticks (or clears) every metric in the current view
                      (the active scope + folder filter — the `shown` set). */}
                  <div className="files-selectall">
                    <label>
                      <input
                        type="checkbox" className="file-pick"
                        checked={allInViewPicked}
                        ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !allInViewPicked; }}
                        onChange={(e) => setPicked((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) for (const m of shown) next.add(m.id);
                          else for (const m of shown) next.delete(m.id);
                          return next;
                        })}
                        aria-label={allInViewPicked ? 'Deselect all metrics' : 'Select all metrics'}
                      />
                      {allInViewPicked ? 'Deselect all' : 'Select all'}
                    </label>
                  </div>
                  {/* Bulk actions — appear once ≥1 card is ticked. Archive reuses the
                      SAME per-metric archive endpoint the detail view uses. Bulk MOVE
                      to a domain is intentionally absent: a metric is a measure ON a
                      dataset and inherits the dataset's domain, so it isn't independently
                      movable (cross-domain move is excluded for metrics by design). The
                      note says so honestly; move the dataset in Data to move the metric. */}
                  {pickedMetrics.length > 0 ? (
                    <div className="files-bulk" aria-busy={bulkBusy}>
                      <span>{pickedMetrics.length} selected</span>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => void bulkArchive(pickedMetrics)}
                        title="Archive the selected metrics (reversible)">
                        Archive
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => { setPicked(new Set()); setBulkNotice(''); }}>Clear</button>
                      <span className="hint" style={{ margin: 0 }}>
                        Metrics move with their dataset — move the dataset in Data.
                      </span>
                      {bulkBusy ? <span className="muted"><span className="spin" /> Working…</span> : null}
                      {bulkNotice ? <span className="muted">{bulkNotice}</span> : null}
                    </div>
                  ) : bulkNotice ? (
                    <div className="files-bulk"><span className="muted">{bulkNotice}</span></div>
                  ) : null}
                  <div className="tile-grid">
                    {shown.map((m) => (
                      <MetricCard
                        key={m.id} m={m} onOpen={onOpen} scope={scope}
                        canManage={canManage(m)}
                        onMove={canManage(m) ? (mm) => setMoveIds({ ids: [mm.id], root: rootOf(mm) }) : undefined}
                        picked={picked.has(m.id)}
                        onPick={(checked) => setPicked((cur) => {
                          const next = new Set(cur);
                          if (checked) next.add(m.id); else next.delete(m.id);
                          return next;
                        })}
                      />
                    ))}
                  </div>
                </>
              )}
            </FolderLayout>
          </div>
        ) : null
      ) : loading && !error ? <div className="stub-page" style={{ marginTop: 20 }}>Loading metrics…</div> : null}

      {/* Archived — openable tiles; the opened detail exposes Restore + Delete. */}
      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived metrics are hidden from the working registry (their definitions are retained).
              Open one to Restore it, or Delete it permanently.
            </p>
            <div className="tile-grid">
              {archived.map((m) => <MetricCard key={m.id} m={m} onOpen={onOpen} scope={scope} canManage={false} />)}
            </div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived metrics.</div>
        )
      ) : null}
    </>
  );
}

export default function MetricsRegistry(props: {
  groups: MetricGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: MetricSummary) => void;
  onDefine: () => void;
  onReload?: () => void;
  showArchived?: boolean;
  onToggleArchived?: () => void;
}) {
  // Wrap in the shared confirm provider so the folder archive/delete confirms render.
  return (
    <ConfirmProvider>
      <MetricsRegistryInner {...props} />
    </ConfirmProvider>
  );
}
