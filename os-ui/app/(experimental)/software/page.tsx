/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import BusyProgress from '@/components/core/BusyProgress';
import { useApi } from '@/lib/useApi';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { SCOPE_GROUPS, groupsFromVisibility, tilesForScope, activeScopeCounts, rootsForScope, type ScopeKey, type FolderRoot } from '@/lib/core/scopes';
import { itemsUnderFolder, normaliseFolderPath, folderName, type FolderPathNode } from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type AppItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: string;
  owner: string;
  domain: string;
  visibility: Visibility;
  /** The Software rail folder path (default '/'). DISPLAY-only — never the slug. */
  folder: string;
  status: 'active' | 'archived';
  mode: 'live' | 'offline';
  subdomain: string;
  deploy: { state: 'building' | 'preview' | 'review' | 'live'; releases: number };
  /** How the app is served — 'spec' = declarative (os-ui 0.6.135 DRAFT/LIVE model). */
  serveMode?: 'image' | 'runtime' | 'spec';
  /** Presence signals for the tile's Draft indicator (never the full spec is read here). */
  spec?: unknown;
  draftSpec?: unknown;
};

/**
 * A spec app is a DRAFT-only work-in-progress when it has a draft (or is a spec app) but has never
 * published a live `spec` (os-ui 0.6.135). Such an app STILL shows in the tiles — never hidden —
 * with a small "Draft" indicator, so a work-in-progress is never lost.
 */
function isDraftOnly(a: AppItem): boolean {
  return a.serveMode === 'spec' && !a.spec && (!!a.draftSpec || a.deploy.releases === 0);
}

/**
 * Is the app actually SERVED, so "Open App" can go straight to /apps/<slug>?
 * A declarative (spec) app is served once it has a published LIVE `spec`; a coded
 * app is served once its deploy is live. A draft-only app isn't served yet, so
 * Open is disabled with a "Publish to open" hint (os-ui 0.6.139).
 */
function isOpenable(a: AppItem): boolean {
  return a.serveMode === 'spec' ? !!a.spec : a.deploy.state === 'live';
}

/** The folder root an app lives in: a Personal app folds into the owner's PERSONAL
 *  tree; a Shared/Certified app folds into the owning DOMAIN's tree (parity with Data). */
function rootOf(a: AppItem): FolderRoot {
  return a.visibility === 'Personal' ? 'personal' : 'domain';
}

/** App visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (v: Visibility): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Certified' ? 'certified' : 'personal';

/** Post an app lifecycle action to its lifecycle route (archive/unarchive/delete). */
async function appLifecycle(id: string, action: 'archive' | 'unarchive' | 'delete') {
  const res = await fetch(`/api/apps/${id}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Action failed');
}
type AppsData = {
  user: { id: string; role: string };
  apps: AppItem[];
  /** The create picker's four choices (server-defined; sovereign-app is default). */
  templates?: { key: string; label: string; blurb: string }[];
  /** os-ui 0.6.133 platform flag — when false (default) only Declarative (spec) apps
   *  can be created, so the launcher drops the coded chooser entirely. Server-decided
   *  (any authenticated user may read just this one boolean). */
  codedAppsEnabled?: boolean;
};

/** A running app's deploy state → a calm status badge. */
function statusBadge(state: AppItem['deploy']['state']): { cls: string; label: string } {
  switch (state) {
    case 'live':
      return { cls: 'badge ok', label: 'Live' };
    case 'review':
      return { cls: 'badge warn', label: 'In review' };
    case 'preview':
      return { cls: 'badge muted', label: 'Preview' };
    default:
      return { cls: 'badge muted', label: 'Draft' };
  }
}

function versionLabel(releases: number): string {
  return releases > 0 ? `v${releases}` : 'Unpublished';
}

/**
 * Software — the simple, chat-centric start screen. One page: a big home-style
 * "Create new software app" launcher, then the viewer's own running apps as
 * clean tiles, organised into FOLDERS (parity with Data / Metrics). Create
 * scaffolds a sovereign in-cluster Forgejo repo and drops you straight into the
 * build chat + editor (`/software/{id}?mode=edit`).
 *
 * The inner component uses `useConfirm`, so it must render INSIDE the
 * `<ConfirmProvider>` — the thin default export below provides it.
 */
function SoftwareInner() {
  const router = useRouter();
  const { user } = useUser();
  const { data, loading, reload } = useApi<AppsData>('/api/apps');
  const confirm = useConfirm();

  // os-ui 0.6.133: coded (custom) apps are platform-admin-gated and OFF by default.
  // Treat an absent flag as OFF (fail-safe: default to the Declarative-only launcher).
  // When OFF there is NO chooser — "New app" creates a Declarative (spec) app directly.
  const codedAppsEnabled = data?.codedAppsEnabled === true;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('sovereign-app');
  // AppSpec Phase 4a: choose the SERVING KIND. 'spec' = declarative no-code (the recommended
  // default — assemble it in Build by picking patterns + mapping governed data, served same-origin
  // with no pod). 'code' = the advanced coded path (a Forgejo repo + CI + image the agent builds).
  const [kind, setKind] = useState<'spec' | 'code'>('spec');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<ScopeKey>('all');
  const [showArchived, setShowArchived] = useState(false);
  // Folder rail state (mirrors DatasetTiles): the selected folder, the app(s) being
  // moved via the picker, and a folder-move ref for reparenting a folder row.
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);
  const { personalNodes, domainNodes, loadFolders } = useFolders('software', showArchived);

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      // When coded apps are disabled, "New app" ALWAYS creates a Declarative (spec) app
      // directly — the coded path is not an option (the server also fail-closes on it).
      const effectiveKind = codedAppsEnabled ? kind : 'spec';
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A declarative (spec) app carries no template — the OS renders its spec directly.
        body: JSON.stringify(effectiveKind === 'spec' ? { name, kind: 'spec' } : { name, template, kind: 'code' }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not create the app');
        setCreating(false);
        return;
      }
      // A Forgejo repo is auto-provisioned in-cluster; go build it.
      reload();
      router.push(`/software/${body.app.id}?mode=edit`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  const uid = data?.user.id ?? '';
  // Carry an `archived` boolean the OS-wide archive-aware scope helpers key on
  // (apps model it as `status: 'active' | 'archived'`).
  const allApps = (data?.apps ?? []).map((a) => ({ ...a, archived: a.status === 'archived' }));
  const appGroups = groupsFromVisibility(allApps);
  // Working counts EXCLUDE archived (they get their own section); the scope
  // switcher counts what you actually work with.
  const appCounts = activeScopeCounts(appGroups, uid);
  const { active: apps, archived: archivedApps } = tilesForScope(appGroups, scope, uid);

  // An app is the caller's to manage when they own it or are an in-domain Admin
  // (the lifecycle route re-checks either way — this only decides whether to show it).
  const role = data?.user.role ?? '';
  const canManage = (a: AppItem) => uid !== '' && (a.owner === uid || role === 'admin');

  // ── Folder rail (parity with DatasetTiles) ─────────────────────────────────
  const visibleRoots = rootsForScope(scope);
  const active = apps as AppItem[];

  // Move one or many apps into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setError('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/apps/${id}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) { setError((await res.json()).error ?? 'Move failed'); }
      } catch (e) { setError((e as Error).message); }
    }
    reload();
    loadFolders();
  }, [reload, loadFolders]);

  // Create a folder row in the registry, then re-load the rail.
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const nm = window.prompt('Folder name');
    if (!nm || !nm.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${nm.trim()}`);
    setError('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'software', scope: root, path }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Could not create folder'); return; }
      await loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [loadFolders]);

  // Folder lifecycle handlers — archive / restore / delete / rename a folder row via
  // the governed registry API (identical wiring to DatasetTiles).
  const countUnder = (ref: FolderRef) =>
    itemsUnderFolder(ref.path, active.filter((a) => rootOf(a) === ref.scope)).length;

  const handleFolderArchive = useCallback(async (ref: FolderRef) => {
    const ok = await confirm(archiveFolderCopy(folderName(ref.path), countUnder(ref)));
    if (!ok) return;
    setError('');
    try {
      const id = await ensureFolderId('software', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Archive failed'); return; }
      reload(); loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [confirm, active, reload, loadFolders]);

  const handleFolderRename = useCallback(async (ref: FolderRef, newName: string) => {
    const path = renamedPath(ref.path, newName);
    if (!path || path === ref.path) return;
    setError('');
    try {
      const id = await ensureFolderId('software', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Rename failed'); return; }
      reload(); loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [reload, loadFolders]);

  const handleFolderRestore = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    setError('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      });
      if (!res.ok) { setError((await res.json()).error ?? 'Restore failed'); return; }
      reload(); loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [reload, loadFolders]);

  const handleFolderDelete = useCallback(async (ref: FolderRef) => {
    if (!ref.id) return;
    const ok = await confirm(deleteFolderCopy(folderName(ref.path), countUnder(ref)));
    if (!ok) return;
    setError('');
    try {
      const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
      if (!res.ok) { setError((await res.json()).error ?? 'Delete failed'); return; }
      reload(); loadFolders();
    } catch (e) { setError((e as Error).message); }
  }, [confirm, active, reload, loadFolders]);

  // Folder rows = governed registry rows UNIONed with folders synthesised from the
  // visible apps' own paths (implicit pre-registry folders keep showing). Split by root.
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
    const personalPaths = active.filter((a) => rootOf(a) === 'personal').map((a) => normaliseFolderPath(a.folder));
    const domainPaths = active.filter((a) => rootOf(a) === 'domain').map((a) => normaliseFolderPath(a.folder));
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, active]);

  const treePersonalNodes = visibleRoots.includes('personal') ? personalTreeNodes : [];
  const treeDomainNodes = visibleRoots.includes('domain') ? domainTreeNodes : [];
  const treeItems = useMemo(
    () => active.map((a) => ({ id: a.id, folder: normaliseFolderPath(a.folder), name: a.name })),
    [active],
  );

  // Grid filter: a selected folder shows the apps under it (incl. subfolders) in that
  // root; else the whole scope list.
  const shown = sel
    ? (itemsUnderFolder(sel.path, active.filter((a) => rootOf(a) === sel.root)) as AppItem[])
    : active;

  // ONE tile renderer used by both the active grid and the archived section.
  const appTile = (a: AppItem & { archived: boolean }) => {
    const s = statusBadge(a.deploy.state);
    return (
      <div className="sw-app-cell" key={a.id}>
        <Link className="sw-app" href={`/software/${a.id}`}>
          <div className="sw-app-top">
            <h3 className="sw-app-name">{a.name}</h3>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              {(scope === 'shared' || scope === 'marketplace') ? <DomainTag domain={a.domain} /> : null}
              {a.archived ? <span className="badge muted">archived</span> : null}
              {/* A never-published spec app is a work-in-progress DRAFT — always shown, never hidden. */}
              {isDraftOnly(a) && !a.archived ? <span className="badge muted" title="Not published yet — a work-in-progress draft">Draft</span> : <span className={s.cls}>{s.label}</span>}
            </div>
          </div>
          <div className="sw-app-desc">{a.description || 'No description yet.'}</div>
          <div className="sw-app-foot">
            <span className="sw-app-ver">{versionLabel(a.deploy.releases)}</span>
            {a.mode === 'offline' ? <span className="badge muted">git not ready</span> : null}
          </div>
        </Link>
        {/* TWO explicit actions on every tile (os-ui 0.6.139): Open App → the SERVED app
            at /apps/<slug> (its own page), Edit App → the builder. Open is enabled only when
            the app is actually served (a published live spec / live deploy); a draft-only app
            shows a disabled Open with a "Publish to open" hint. */}
        {!a.archived ? (
          <div className="sw-app-open-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isOpenable(a) ? (
              <a className="btn sm" href={`/apps/${a.slug}`} target="_blank" rel="noreferrer" title="Open the running app in a new tab">
                Open App ↗
              </a>
            ) : (
              <button type="button" className="btn sm" disabled title="Publish this app first — a draft isn't served yet">
                Open App
              </button>
            )}
            <Link className="btn ghost sm" href={`/software/${a.id}`} title="Open the builder to edit this app">
              Edit App
            </Link>
            {!isOpenable(a) ? <span className="sw-app-open-hint hint" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Publish to open</span> : null}
          </div>
        ) : null}
        {canManage(a) ? (
          <div className="sw-app-actions" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!a.archived ? (
              <button
                className="btn ghost sm"
                title="Move this app to a folder"
                onClick={() => setPickerIds([a.id])}
              >Move…</button>
            ) : null}
            <LifecycleActions
              id={a.id}
              name={a.name}
              kind="app"
              visibility={lcVis(a.visibility)}
              archived={a.archived}
              api={`/api/apps/${a.id}`}
              handlers={{
                onArchive: () => appLifecycle(a.id, 'archive'),
                onRestore: () => appLifecycle(a.id, 'unarchive'),
                onDelete: () => appLifecycle(a.id, 'delete'),
              }}
              onChanged={reload}
              compact
              surface="tile"
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <PageHeader title="Software" crumb="build, chat, deploy — sovereign" tutorial="software" />
      <div className="content sw">
        {/* The big, home-style create launcher. */}
        <div className={`sw-create${open ? ' is-open' : ''}`}>
          {open ? (
            <div className="sw-create-head">
              <div>
                <div className="sw-create-title">Create new software app</div>
                {/* KIND-aware sub: declarative (the recommended default) vs the coded path.
                    The collapsed trigger below stays neutral (no kind chosen yet). */}
                <div className="sw-create-sub">
                  {kind === 'spec'
                    ? 'Assemble it in Build by picking patterns and mapping your governed data — no code. Served instantly, same-origin, with no repo or pipeline.'
                    : 'Describe it in chat; the agent writes the code, commits to its own in-cluster Forgejo repo, and ships it. No accounts, no tokens — your code never leaves.'}
                </div>
              </div>
            </div>
          ) : (
            <button type="button" className="sw-create-head sw-create-trigger" onClick={() => setOpen(true)} aria-expanded={false}>
              <div>
                <div className="sw-create-title">Create new software app</div>
                <div className="sw-create-sub">
                  {codedAppsEnabled
                    ? 'Build it no-code by mapping your governed data, or have the agent write real code — your choice, both sovereign and served in-cluster.'
                    : 'Build it no-code by mapping your governed data to patterns — sovereign, served instantly in-cluster, no repo or pipeline.'}
                </div>
              </div>
              <span className="sw-create-go" aria-hidden="true">+</span>
            </button>
          )}

          {open ? (
            <div className="sw-create-form">
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name your app (e.g. Renewals Tracker)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                }}
              />
              {/* Serving KIND — the first, clearest choice: declarative (no-code) vs coded.
                  Shown ONLY when the platform admin has enabled coded apps; otherwise
                  "New app" creates a Declarative (spec) app directly (no chooser). */}
              {codedAppsEnabled ? (
              <div
                role="radiogroup"
                aria-label="How to build"
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8, marginTop: 12 }}
              >
                {([
                  { k: 'spec' as const, label: 'Declarative app (no-code · recommended)', blurb: 'Assemble it in Build by picking patterns and mapping your governed data. Served instantly — no repo, no pipeline, no code.' },
                  { k: 'code' as const, label: 'Coded app (advanced)', blurb: 'The agent writes real code into an in-cluster Forgejo repo and ships an image. Full control; more moving parts.' },
                ]).map((opt) => {
                  const active = kind === opt.k;
                  return (
                    <button
                      key={opt.k}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setKind(opt.k)}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius)',
                        background: active ? 'var(--panel)' : 'transparent',
                        cursor: 'pointer',
                        font: 'inherit',
                        color: 'inherit',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{opt.blurb}</div>
                    </button>
                  );
                })}
              </div>
              ) : null}

              {/* The four-template picker — CODED apps only; a declarative app has no template. */}
              {codedAppsEnabled && kind === 'code' ? (
                <div
                  role="radiogroup"
                  aria-label="App template"
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 12 }}
                >
                  {(data?.templates ?? []).map((t) => {
                    const active = template === t.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setTemplate(t.key)}
                        style={{
                          textAlign: 'left',
                          padding: '10px 12px',
                          border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius)',
                          background: active ? 'var(--panel)' : 'transparent',
                          cursor: 'pointer',
                          font: 'inherit',
                          color: 'inherit',
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{t.blurb}</div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <button type="button" className="btn ghost" onClick={() => { setOpen(false); setError(''); }} disabled={creating}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={create} disabled={creating || !name.trim()}>
                  {creating ? <span className="spin" /> : 'Create & build'}
                </button>
              </div>
              {/* While the create runs, mirror the OS-wide core progress surface (as on a
                  metric/dashboard save): one honest live step + elapsed. The route is a
                  single request that provisions the app's Forgejo repo, sets the registry
                  secret and seeds the scaffold server-side — there are no streamed
                  sub-milestones to observe, so we name what the server is doing rather than
                  fake checkmarks. */}
              {creating ? (
                <BusyProgress
                  label={`Creating ${name.trim() || 'your app'}`}
                  detail={kind === 'spec'
                    ? 'Registering the app and its governed MCP — no repo or pipeline for a declarative app'
                    : 'Provisioning its in-cluster Forgejo repository, wiring the build pipeline and seeding the scaffold'}
                  typicalSeconds={kind === 'spec' ? 6 : 20}
                />
              ) : null}
              <p className="sw-create-note">
                {kind === 'spec'
                  ? 'No repo, pipeline or code — you compose the app from patterns in Build and it’s served the moment you save. You can grant it governed data, metrics and agents in Choose Context.'
                  : 'The template only sets the starting point — describe the rest in chat and the build agent takes it from there. A sovereign Forgejo repo is created in-cluster; if git isn’t ready yet you can still build in honest offline mode.'}
              </p>
              {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
            </div>
          ) : null}
        </div>

        {/* The governed Software Delivery Team now lives IN each app's Build stage
            (create an app, then build with the team or the build chat there). */}

        {/* Software apps — the OS-wide four groups: All · My · Shared · Marketplace. */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginTop: 30 }}>
          <h2 className="sw-sec-title">Software apps</h2>
          <div className="row" style={{ gap: 14, alignItems: 'center' }}>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
            <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews →</Link>
          </div>
        </div>

        {data ? (
          <div className="seg" style={{ marginTop: 8, marginBottom: 4 }}>
            {SCOPE_GROUPS.map((g) => (
              <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
                {g.label('Software')} ({appCounts[g.key]})
              </button>
            ))}
          </div>
        ) : null}

        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

        {/* App picker modal — move one/many apps into a folder (scope-valid roots only). */}
        <FolderPickerModal
          open={pickerIds !== null}
          tab="software"
          roots={visibleRoots}
          personalNodes={visibleRoots.includes('personal') ? personalTreeNodes : []}
          domainNodes={visibleRoots.includes('domain') ? domainTreeNodes : []}
          title={`Move ${pickerIds && pickerIds.length > 1 ? `${pickerIds.length} apps` : 'app'} to folder`}
          onConfirm={({ path }) => {
            if (pickerIds) void moveInto(pickerIds, path);
            setPickerIds(null);
          }}
          onCancel={() => setPickerIds(null)}
          onCreate={async (root, path) => {
            const res = await fetch('/api/folders', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tab: 'software', scope: root, path }),
            });
            if (!res.ok) { setError((await res.json()).error ?? 'Could not create folder'); return; }
            await loadFolders();
          }}
        />

        {/* Folder move modal — reparents a folder row via PATCH /api/folders/{id}. */}
        <FolderPickerModal
          open={folderMove !== null}
          tab="software"
          roots={folderMove ? [folderMove.scope] : visibleRoots}
          personalNodes={folderMove?.scope === 'personal' ? personalTreeNodes : []}
          domainNodes={folderMove?.scope === 'domain' ? domainTreeNodes : []}
          title="Move folder"
          onConfirm={async ({ path }) => {
            const ref = folderMove;
            setFolderMove(null);
            if (!ref) return;
            setError('');
            try {
              const id = await ensureFolderId('software', ref);
              const res = await fetch(`/api/folders/${id}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path }),
              });
              if (!res.ok) { setError((await res.json()).error ?? 'Move failed'); return; }
              reload(); loadFolders();
            } catch (e) { setError((e as Error).message); }
          }}
          onCancel={() => setFolderMove(null)}
          onCreate={async (root, path) => {
            const res = await fetch('/api/folders', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tab: 'software', scope: root, path }),
            });
            if (!res.ok) { setError((await res.json()).error ?? 'Could not create folder'); return; }
            await loadFolders();
          }}
        />

        {loading && !data ? (
          <div className="stub-page" style={{ marginTop: 12 }}>Loading your apps…</div>
        ) : apps.length === 0 ? (
          <div className="sw-empty">
            <div className="sw-empty-title">
              {scope === 'mine' || scope === 'all' ? 'No apps yet' : scope === 'shared' ? 'Nothing shared yet' : 'Nothing certified yet'}
            </div>
            <div className="sw-empty-sub">
              {scope === 'mine' || scope === 'all'
                ? 'Create your first — it takes one line of chat to get something running.'
                : scope === 'shared' ? 'Promote an app to share it in your domain.' : 'Admins certify apps into the marketplace.'}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <FolderLayout
              allLabel="All apps"
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
              }
            >
              {shown.length === 0 ? (
                <div className="stub-page">This folder is empty.</div>
              ) : (
                <div className="sw-apps">{(shown as (AppItem & { archived: boolean })[]).map(appTile)}</div>
              )}
            </FolderLayout>
          </div>
        )}

        {/* Archived — hidden from the working grid; openable so the detail exposes
            Restore + Delete (the OS-wide archive rule). */}
        {data && showArchived ? (
          archivedApps.length > 0 ? (
            <>
              <div className="section-title" style={{ marginTop: 24 }}>
                Archived<span className="count-pill">{archivedApps.length}</span>
              </div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                Archived apps are hidden from the working lists (retained). Open one to Restore or Delete it.
              </p>
              <div className="sw-apps">{archivedApps.map(appTile)}</div>
            </>
          ) : (
            <div className="hint" style={{ marginTop: 16 }}>No archived apps in this scope.</div>
          )
        ) : null}
      </div>
    </>
  );
}

/** The Software page — wraps the inner surface in the shared ConfirmProvider so the
 *  folder-lifecycle handlers can use `useConfirm` (parity with the Data tab). */
export default function SoftwarePage() {
  return (
    <ConfirmProvider>
      <SoftwareInner />
    </ConfirmProvider>
  );
}
