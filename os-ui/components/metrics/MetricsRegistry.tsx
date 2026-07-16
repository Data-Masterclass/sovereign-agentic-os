/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/core/scopes';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import {
  itemsUnderFolder,
  normaliseFolderPath,
  folderName,
  type FolderPathNode,
} from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
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
type FolderRoot = 'personal' | 'domain';
function rootOf(m: MetricSummary): FolderRoot {
  return m.tier === 'personal' ? 'personal' : 'domain';
}

/** The single folder root(s) a scope segment addresses (scope-driven single root). */
function rootsForScope(scope: ScopeKey): FolderRoot[] {
  if (scope === 'mine') return ['personal'];
  if (scope === 'shared' || scope === 'marketplace') return ['domain'];
  return ['personal', 'domain']; // 'all'
}

function MetricCard({
  m, onOpen, scope, canManage, onMove,
}: {
  m: MetricSummary; onOpen: (m: MetricSummary) => void; scope: ScopeKey;
  canManage: boolean; onMove?: (m: MetricSummary) => void;
}) {
  const showDomain = scope === 'shared' || scope === 'marketplace' || scope === 'all';
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
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 120, boxSizing: 'border-box' }}
      title="Open this metric — explore, govern, or set an alert"
    >
      <div className="tile-top">
        <span className="tile-name">{m.name}</span>
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
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);
  // Move picker: which metric ids are moving; null = closed.
  const [moveIds, setMoveIds] = useState<{ ids: string[]; root: FolderRoot } | null>(null);
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  const loadFolders = useCallback(async () => {
    try {
      const q = showArchived ? '&archived=1' : '';
      const [pRes, dRes] = await Promise.all([
        fetch(`/api/folders?tab=metrics&scope=personal${q}`, { cache: 'no-store' }),
        fetch(`/api/folders?tab=metrics&scope=domain${q}`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPersonalNodes(((await pRes.json()).folders ?? []) as FolderPathNode[]);
      if (dRes.ok) setDomainNodes(((await dRes.json()).folders ?? []) as FolderPathNode[]);
    } catch { /* the synthesised rail still renders without the registry */ }
  }, [showArchived]);
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
    const opts: RequestInit =
      method === 'DELETE' ? { method: 'DELETE' }
      : method === 'PATCH' ? { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: method }) };
    const res = await fetch(`/api/folders/${ref.id}`, opts);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Folder action failed'); return; }
    reload();
  }, [reload]);

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
            onClick={() => { setScope(g.key); setSel(null); }}>
            {g.label('Metrics')}{counts ? ` (${counts[g.key]})` : ''}
          </button>
        ))}
      </div>

      {(error || err) ? <div className="error" style={{ marginTop: 14 }}>{error || err}</div> : null}

      {/* Move-metric picker (scope-driven single root). */}
      <FolderPickerModal
        open={moveIds !== null}
        tab="metrics"
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
        personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
        title="Move folder"
        onConfirm={({ path }) => { const ref = folderMove; setFolderMove(null); if (ref?.id) void folderAction(ref, 'PATCH', path); }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (root, path) => { await createFolder(root, path); }}
      />

      {groups && active.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 20 }}>
          {scope === 'mine' || scope === 'all'
            ? <>No metrics yet. <strong>Define</strong> one on a governed Gold dataset to see it here.</>
            : scope === 'shared'
              ? 'Nothing shared in your domain yet — promote a metric to share it.'
              : 'Nothing in the marketplace yet.'}
        </div>
      ) : null}

      {scoped ? (
        active.length > 0 ? (
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 16 }}>
            {/* ---- folder rail (the shared primitive, one component across tabs) ---- */}
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
                <span style={{ flex: 1 }}>All metrics</span>
                <span className="muted" style={{ fontSize: 12 }}>{active.length}</span>
              </button>
              <FolderTree
                variant="nav"
                personalNodes={roots.includes('personal') ? personalTreeNodes : []}
                domainNodes={roots.includes('domain') ? domainTreeNodes : []}
                items={treeItems.filter((i) => {
                  const r = active.find((m) => m.id === i.id);
                  return r ? roots.includes(rootOf(r)) : true;
                })}
                personalLabel="My folders"
                domainLabel="Shared in domain"
                selectedPath={sel?.path}
                onSelect={(root, path) => setSel((cur) => (cur && cur.root === root && cur.path === path ? null : { root, path }))}
                onCreate={createFolder}
                onMove={(ref) => { if (ref.id) setFolderMove(ref); }}
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
            </nav>

            {/* ---- the metric grid, filtered to the selected folder ---- */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {shown.length === 0 ? (
                <div className="stub-page">This folder is empty.</div>
              ) : (
                <div className="tile-grid">
                  {shown.map((m) => (
                    <MetricCard
                      key={m.id} m={m} onOpen={onOpen} scope={scope}
                      canManage={canManage(m)}
                      onMove={canManage(m) ? (mm) => setMoveIds({ ids: [mm.id], root: rootOf(mm) }) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
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
