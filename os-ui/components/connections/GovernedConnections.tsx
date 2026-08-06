/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { roleAtLeast } from '@/lib/core/session';
import { SCOPE_GROUPS, groupByScope, groupsFromVisibility, scopeCounts } from '@/lib/core/scopes';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import DomainTag from '@/components/DomainTag';
import { useApi } from '@/lib/useApi';
import ConnectionBuilder from '@/components/connections/ConnectionBuilder';
import { itemsUnderFolder, normaliseFolderPath, folderName } from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import {
  type Conn, type Data, type AppConn, type AppConns,
  badge, visWord,
} from './shared';
import { connectorIdentity, markStyle } from '@/lib/connections/connector-identity';
import type { CSSProperties } from 'react';

/**
 * Governed Connections surface — the OS-wide View/Edit artifact model (as on Metrics +
 * Dashboards).
 *
 *   list    — scope-grouped tiles-in-folders (All · My · Domain · Company) via the shared
 *             FolderTree + connections folder adapter. App-MCP connections (auto-generated
 *             from the Software tab) fold in by scope, tagged "App". ＋ New connection opens
 *             the builder on a TYPE CHOOSER.
 *   builder — ConnectionBuilder. ＋ New opens its two-door type chooser (Use a connector ·
 *             Build a custom connector), both landing in the configure (Edit) surface.
 *             Clicking a tile opens the connection in VIEW (real status · what it connects
 *             to · exposed capabilities · usage · Test), with Promote + lifecycle in the
 *             detail header and ✎ Edit for the configure surface (edit-scope gated).
 *
 * This component owns the ONE /api/connections fetch and the folder rail; the builder owns
 * every create/view/edit surface. Internal ids + governed routes are unchanged.
 */

function GovernedConnectionsInner() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  // View: the grouped list, or the builder for one connection / a new one.
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'builder'; existing: Conn | null }>({ kind: 'list' });
  const [scope, setScope] = useState<(typeof SCOPE_GROUPS)[number]['key']>('all');
  const [showArchived, setShowArchived] = useState(false);
  // Folder nav: the selected folder filters the list; the picker moves one connection.
  const [sel, setSel] = useState<{ root: 'personal' | 'domain'; path: string } | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  const { personalNodes, domainNodes, loadFolders } = useFolders('connections', showArchived);
  useEffect(() => { loadFolders(); }, [loadFolders]);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/connections${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const body = await res.json() as Data | { error: string };
      if (!res.ok) setError((body as { error: string }).error ?? 'Failed to load connections');
      else setData(body as Data);
    } catch (e) { setError((e as Error).message); }
  }, [showArchived]);
  useEffect(() => { load(); }, [load]);

  // Keep the open builder's connection fresh after a mutation (capability save, promote,
  // usage toggle) — re-bind `existing` to the reloaded record so View reflects the change.
  useEffect(() => {
    if (view.kind !== 'builder' || !view.existing || !data) return;
    const fresh = data.connections.find((c) => c.id === view.existing!.id);
    if (fresh && fresh !== view.existing) setView({ kind: 'builder', existing: fresh });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- App MCP connections (auto-generated from Software tab) ----
  const { data: appConns } = useApi<AppConns>('/api/connections/apps');

  // ?focus=<connectionId> deep-link: once data loads, open that connection in the builder
  // (View). Matches a governed connection by id, or an app connection by id/principal/slug
  // (→ open its app). One-shot via a ref.
  const focusApplied = useRef(false);
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  useEffect(() => {
    if (!focusId || focusApplied.current || !data) return;
    const target = data.connections.find((c) => c.id === focusId);
    if (!target) return; // may be an app connection — handled below
    focusApplied.current = true;
    setView({ kind: 'builder', existing: target });
  }, [focusId, data]);

  const appFocusApplied = useRef(false);
  useEffect(() => {
    if (!focusId || appFocusApplied.current || !appConns) return;
    const target = appConns.connections.find((c) => c.id === focusId || c.principal === focusId || c.appSlug === focusId);
    if (!target) return;
    appFocusApplied.current = true;
    requestAnimationFrame(() => {
      document.getElementById(`app-conn-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [focusId, appConns]);

  // Move one connection into a folder via the edit-gated folder route (mirrors Data).
  const moveInto = useCallback(async (id: string, folder: string) => {
    setError('');
    try {
      const res = await fetch(`/api/connections/${id}/folder`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Move failed'); return; }
      await Promise.all([load(), loadFolders()]);
    } catch (e) { setError((e as Error).message); }
  }, [load, loadFolders]);

  const createFolderRow = useCallback(async (root: 'personal' | 'domain', parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setError('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'connections', scope: root, path }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Could not create folder'); return; }
      await loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [loadFolders]);

  const refreshAll = useCallback(async () => { await Promise.all([load(), loadFolders()]); }, [load, loadFolders]);
  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    if (!window.confirm(`Archive the folder "${folderName(ref.path)}" and everything in it?`)) return;
    setError('');
    try {
      const id = await ensureFolderId('connections', ref);
      const res = await fetch(`/api/folders/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'archive' }) });
      if (!res.ok) { setError((await res.json()).error ?? 'Archive failed'); return; }
      await refreshAll();
    } catch (e) { setError((e as Error).message); }
  }, [refreshAll]);
  const handleFolderRename = useCallback(async (ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    setError('');
    try {
      const id = await ensureFolderId('connections', ref);
      const res = await fetch(`/api/folders/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      if (!res.ok) { setError((await res.json()).error ?? 'Rename failed'); return; }
      await refreshAll();
    } catch (e) { setError((e as Error).message); }
  }, [refreshAll]);
  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setError('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restore' }) });
      if (!res.ok) { setError((await res.json()).error ?? 'Restore failed'); return; }
      await refreshAll();
    } catch (e) { setError((e as Error).message); }
  }, [refreshAll]);
  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    if (!window.confirm(`Permanently delete the folder "${folderName(ref.path)}"?`)) return;
    setError('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setError((await res.json()).error ?? 'Delete failed'); return; }
      await refreshAll();
    } catch (e) { setError((e as Error).message); }
  }, [refreshAll]);

  const canCreate = data?.canCreate ?? false;
  const canCreatePersonal = data?.canCreatePersonal ?? false;

  if (!data && !error) return <div className="hint"><span className="spin" /> Loading connections…</div>;

  // ── Builder (create / view / edit) ──
  if (view.kind === 'builder' && data) {
    return (
      <ConfirmProvider>
        <ConnectionBuilder
          existing={view.existing}
          data={data}
          onBack={() => setView({ kind: 'list' })}
          onChanged={load}
        />
      </ConfirmProvider>
    );
  }

  // ── List ──
  return (
    <ConfirmProvider>
      {/* Header: lead + Show archived + ＋ New connection */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <p className="lead" style={{ margin: 0, maxWidth: 560 }}>
          Your connections to the tools and data you already use — each signs in as you and keeps
          your credentials in the vault, never in the record.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost" style={{ opacity: 1 }} onClick={() => setShowArchived((v) => !v)} title="Archived connections are hidden by default">
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {(canCreate || canCreatePersonal) ? (
            <button className="btn" onClick={() => setView({ kind: 'builder', existing: null })}>＋ New connection</button>
          ) : null}
        </div>
      </div>
      {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}

      {data ? (() => {
        // Governed connections + App-MCP connections share the SAME four scope groups.
        const groups = groupsFromVisibility(data.connections);
        const scopedConns = groupByScope(groups, data.user.id)[scope];
        const apps = appConns?.connections ?? [];
        const scopedApps = groupByScope(groupsFromVisibility(apps), data.user.id)[scope];
        const cCounts = scopeCounts(groups, data.user.id);
        const aCounts = scopeCounts(groupsFromVisibility(apps), data.user.id);
        const counts = {
          all: cCounts.all + aCounts.all,
          mine: cCounts.mine + aCounts.mine,
          shared: cCounts.shared + aCounts.shared,
          marketplace: cCounts.marketplace + aCounts.marketplace,
        };
        const empty = scopedConns.length === 0 && scopedApps.length === 0;

        const connRoot = (v: Conn['visibility']): 'personal' | 'domain' => (v === 'Personal' ? 'personal' : 'domain');
        const visibleRoots: ('personal' | 'domain')[] =
          scope === 'mine' ? ['personal'] : scope === 'shared' || scope === 'marketplace' ? ['domain'] : ['personal', 'domain'];

        const synth = (rows: { path: string; id?: string; archived?: boolean }[], paths: string[]) => {
          const seen = new Set(rows.map((r) => normaliseFolderPath(r.path)));
          const out = [...rows];
          for (const p of paths) {
            const n = normaliseFolderPath(p);
            if (n !== '/' && !seen.has(n)) { seen.add(n); out.push({ path: n }); }
          }
          return out;
        };
        const pPaths = scopedConns.filter((c) => connRoot(c.visibility) === 'personal').map((c) => c.folder ?? '/');
        const dPaths = scopedConns.filter((c) => connRoot(c.visibility) === 'domain').map((c) => c.folder ?? '/');
        const treePersonal = visibleRoots.includes('personal') ? synth(personalNodes, pPaths) : [];
        const treeDomain = visibleRoots.includes('domain') ? synth(domainNodes, dPaths) : [];
        const treeItems = scopedConns.map((c) => ({ id: c.id, folder: normaliseFolderPath(c.folder ?? '/'), name: c.name, scope: connRoot(c.visibility) }));

        const shownConns = sel
          ? scopedConns.filter((c) => connRoot(c.visibility) === sel.root)
              .filter((c) => itemsUnderFolder(sel.path, [{ id: c.id, folder: normaliseFolderPath(c.folder ?? '/') }]).length > 0)
          : scopedConns;
        const shownApps = sel ? [] : scopedApps;

        return (
          <>
            <div className="seg" style={{ marginBottom: 14, marginTop: 14 }}>
              {SCOPE_GROUPS.map((g) => (
                <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => { setScope(g.key); setSel(null); }}>
                  {g.label('Connections')} ({counts[g.key]})
                </button>
              ))}
            </div>
            {empty ? (
              <div className="stub-page">
                {scope === 'mine' || scope === 'all'
                  ? <>No connections yet{(canCreate || canCreatePersonal) ? ' — use ＋ New connection to add one.' : '.'}</>
                  : scope === 'shared' ? 'Nothing in Domain yet.' : 'Nothing in Company yet.'}
              </div>
            ) : (
              <FolderLayout
                allLabel="All connections"
                allCount={scopedConns.length + scopedApps.length}
                allSelected={sel === null}
                onSelectAll={() => setSel(null)}
                rail={
                  <FolderTree
                    variant="nav"
                    canCreateDomain={roleAtLeast(data.user.role, 'domain_admin')}
                    roots={visibleRoots}
                    personalNodes={treePersonal}
                    domainNodes={treeDomain}
                    items={treeItems}
                    personalLabel="My folders"
                    domainLabel="Domain folders"
                    selectedPath={sel?.path}
                    onSelect={(root, path) => setSel({ root, path })}
                    onCreate={createFolderRow}
                    onRename={handleFolderRename}
                    onArchive={handleFolderArchive}
                    onRestore={handleFolderRestore}
                    onDelete={handleFolderDelete}
                    renderLeaf={(item) => item.name ?? item.id}
                  />
                }
              >
                {shownConns.map((c) => (
                  <ConnectionTile
                    key={c.id}
                    c={c}
                    onOpen={() => setView({ kind: 'builder', existing: c })}
                    onMove={() => setPickerId(c.id)}
                    canMove={connMovable(c, data.user)}
                  />
                ))}
                {shownApps.map((c) => <AppConnectionTile key={c.id} c={c} />)}
              </FolderLayout>
            )}

            <FolderPickerModal
              open={pickerId !== null}
              tab="connections"
              roots={visibleRoots}
              personalNodes={treePersonal}
              domainNodes={treeDomain}
              title="Move connection to folder"
              onCancel={() => setPickerId(null)}
              onConfirm={(dest) => { const id = pickerId; setPickerId(null); if (id) void moveInto(id, dest.path); }}
              onCreate={async (root, path) => {
                const res = await fetch('/api/folders', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ tab: 'connections', scope: root, path }),
                });
                if (!res.ok) { setError((await res.json()).error ?? 'Could not create folder'); return; }
                await loadFolders();
              }}
            />
          </>
        );
      })() : null}
    </ConfirmProvider>
  );
}

/** May this viewer move the connection (edit-scope)? Owner / owning-domain admin / admin. */
function connMovable(c: Conn, me: { id: string; role: Data['user']['role']; domains: string[] }): boolean {
  if (me.role === 'admin') return true;
  if (c.owner === me.id) return true;
  if (me.role === 'domain_admin' && me.domains.includes(c.domain)) return true;
  return false;
}

// ---- List tiles ------------------------------------------------------------

/**
 * One connection as a clickable tile — name, type, real health, visibility. Opening it
 * hands off to the builder's VIEW. Move-to-folder stays here (a list-level act). The tile
 * never shows secrets or exposes controls — those live in View/Edit.
 */
function ConnectionTile({ c, onOpen, onMove, canMove }: { c: Conn; onOpen: () => void; onMove: () => void; canMove: boolean }) {
  const id = connectorIdentity(c.template, { label: c.name });
  return (
    <div className="card" style={{ marginBottom: 14, ...(markStyle(id.accent) as CSSProperties) }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <button
          type="button"
          onClick={onOpen}
          style={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0, display: 'flex', gap: 12, alignItems: 'flex-start' }}
          aria-label={`Open ${c.name}`}
        >
          <span className="conn-mono sm" aria-hidden="true">{id.monogram}</span>
          <span style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>
              {c.name}
              <span className="badge muted" style={{ marginLeft: 6 }}>{c.type}</span>
              {c.health === 'healthy' ? <span className="badge ok" style={{ marginLeft: 4 }}>healthy</span> : null}
              {c.health === 'needs-reconnect' ? <span className="badge err" style={{ marginLeft: 4 }}>needs reconnect</span> : null}
              {c.health === 'untested' ? <span className="badge muted" style={{ marginLeft: 4 }}>untested</span> : null}
            </h3>
            <span className="muted mono" style={{ display: 'block', marginTop: 6, fontSize: 11.5 }}>
              {c.connector} · {c.auth === 'oauth' ? 'signs in as you' : 'service account'} · {c.owner}/{c.domain}
            </span>
          </span>
        </button>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {c.archived ? <span className="badge muted">archived</span> : null}
          {c.dataUsage === 'bronze' ? <span className="badge warn">Bronze source</span> : null}
          {c.dataUsage === 'files' ? <span className="badge warn">Files index</span> : null}
          {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
          <span className={badge(c.visibility)}>{visWord(c.visibility)}</span>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8, justifyContent: 'flex-end' }}>
        {canMove ? <button className="btn ghost sm" onClick={onMove} title="Move to folder">Move to folder…</button> : null}
        <button className="btn ghost sm" onClick={onOpen}>Open →</button>
      </div>
    </div>
  );
}

/**
 * App-MCP connection tile — auto-generated from the Software tab, folded into the scope
 * list. Tagged "App"; the app owns its lifecycle, so this links to its app (read-only here).
 */
function AppConnectionTile({ c }: { c: AppConn }) {
  const toolNames = c.tools.map((t) => t.name).join(', ');
  return (
    <div className="card" id={`app-conn-${c.id}`} style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{c.name}<span className="badge" style={{ marginLeft: 6 }}>App</span></h3>
          <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>{c.principal} · {c.owner}/{c.domain}</div>
          <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }} title={toolNames}>Tools: {toolNames || '(none)'}</div>
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 12 }}>
          {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
          <span className={badge(c.visibility)}>{visWord(c.visibility)}</span>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 10, marginBottom: 0, fontSize: 11.5 }}>
        Auto-generated from its app in the Software tab — manage it there.
      </p>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <Link className="btn ghost" href={`/software/${c.appId}`}>Open app →</Link>
      </div>
    </div>
  );
}

export default function GovernedConnections() {
  return (
    <Suspense>
      <GovernedConnectionsInner />
    </Suspense>
  );
}
