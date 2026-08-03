/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import Markdown from '@/components/Markdown';
import { roleAtLeast, type Role } from '@/lib/core/session';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import { useTabNavReset } from '@/lib/core/tab-nav';
import { SCOPE_GROUPS, type ScopeKey } from '@/lib/core/scopes';
import type { PersonalKnowledgeSummary } from '@/lib/knowledge/personal-store';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import DomainTag from '@/components/DomainTag';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { isUnderFolder, itemsUnderFolder, folderName, type FolderPathNode } from '@/lib/core/folders';

/** Knowledge visibility (Personal/Shared/Marketplace) → OS-wide lifecycle visibility. */
const lcVis = (v: 'Personal' | 'Shared' | 'Marketplace'): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

/** Knowledge visibility → the fail-closed edit-scope tier (mirrors the store's
 *  `canManageEntry`): Personal is owner-only, Shared is domain, Marketplace is company. */
const scopeOf = (v: 'Personal' | 'Shared' | 'Marketplace'): ArtifactScope =>
  v === 'Personal' ? 'personal' : v === 'Marketplace' ? 'certified' : 'shared';

/**
 * Knowledge tab — reference knowledge (markdown) added by users.
 *
 * My knowledge: personal notes about how you work (owner-only, promotable).
 * Domain: notes promoted to domain scope.
 * Company: certified knowledge from across the org.
 *
 * The Domain Operating Manual (overview / glossary / goals / context) has
 * moved to the top of the Workflows tab (/workflows).
 */

type UserInfo = { id: string; role: Role; domains: string[] };

type PersonalGroups = {
  mine: PersonalKnowledgeSummary[];
  domain: PersonalKnowledgeSummary[];
  marketplace: PersonalKnowledgeSummary[];
};

export default function KnowledgePage() {
  return (
    <Suspense>
      <ConfirmProvider>
        <KnowledgePageInner />
      </ConfirmProvider>
    </Suspense>
  );
}

function KnowledgePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { notifyApprovalFiled } = useApprovalNotifier();
  const confirm = useConfirm();
  // Clicking the Knowledge sidebar link returns to this page root (and closes any open detail).
  useTabNavReset(() => { setPkOpenId(null); });

  // Knowledge scope (My · Shared · Marketplace).
  const [kScope, setKScope] = useState<ScopeKey>('all');

  // Personal general-knowledge entries ("My knowledge").
  const [personal, setPersonal] = useState<PersonalGroups | null>(null);
  const [pkCreating, setPkCreating] = useState(false);
  // Which entry's DETAIL is open (null = the list). Opening a tile lands in VIEW;
  // a fresh entry lands in EDIT (the OS-wide View/Edit artifact model).
  const [pkOpenId, setPkOpenId] = useState<string | null>(null);
  const [pkMode, setPkMode] = useState<'view' | 'edit'>('view');
  const [pkDraft, setPkDraft] = useState<{ title: string; md: string }>({ title: '', md: '' });
  const [pkSaving, setPkSaving] = useState(false);
  const [pkMsg, setPkMsg] = useState('');
  const [pkPromoting, setPkPromoting] = useState(false);
  const [confirmDemoteId, setConfirmDemoteId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // "＋ New knowledge" type chooser (General knowledge · Workflow); null = closed.
  const [chooserOpen, setChooserOpen] = useState(false);

  // Folder navigation state for "My knowledge"
  const [pkFolder, setPkFolder] = useState<string>('/');
  const [pkFolderNodes, setPkFolderNodes] = useState<FolderPathNode[]>([]);
  // Picker modal: which entry id is being moved; null = closed.
  const [pkMoveId, setPkMoveId] = useState<string | null>(null);
  // Folder lifecycle: folder being moved (opens a second picker); null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  // User info for role-based UI
  const [user, setUser] = useState<UserInfo | null>(null);

  const loadPersonal = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge/personal${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      if (res.ok) setPersonal(await res.json());
    } catch {
      /* leave personal null → the sub-area shows its loading/empty surface */
    }
  }, [showArchived]);

  const loadFolders = useCallback(async () => {
    try {
      // Include archived folder rows when the user is viewing archived, so the shared
      // ••• menu can offer Restore / Delete on them (one lifecycle, every tab).
      const res = await fetch(
        `/api/folders?tab=knowledge&scope=personal${showArchived ? '&archived=1' : ''}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const d = await res.json();
        // Keep the FULL rows (id + archived) so the lifecycle menu can target the row.
        setPkFolderNodes((d.folders ?? []) as FolderPathNode[]);
      }
    } catch { /* leave empty */ }
  }, [showArchived]);

  // ── Folder lifecycle (create / move / rename / archive / restore / delete) ──
  // Knowledge folders ONLY its personal lane ("My knowledge"), so every handler
  // targets scope=personal — the same one lifecycle every foldered tab shares.
  const reloadFolders = useCallback(() => { void loadPersonal(); void loadFolders(); }, [loadPersonal, loadFolders]);

  const createFolder = useCallback(async (parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    const full = parentPath === '/' ? `/${name.trim()}` : `${parentPath}/${name.trim()}`;
    setPkMsg('');
    const res = await fetch('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'knowledge', scope: 'personal', path: full }),
    });
    if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Could not create folder'); return; }
    reloadFolders();
  }, [reloadFolders]);

  const moveFolder = useCallback(async (ref: FolderRef, dest: string) => {
    setPkMsg('');
    try {
      // Synthetic (implicit) folder → materialise a registry row, then reparent it.
      const id = await ensureFolderId('knowledge', ref);
      const res = await fetch(`/api/folders/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dest }),
      });
      if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Move failed'); return; }
      if (pkFolder === ref.path) setPkFolder(dest);
      reloadFolders();
    } catch (e) { setPkMsg((e as Error).message); }
  }, [pkFolder, reloadFolders]);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && setUser(d.user))
      .catch(() => null);
  }, []);

  useEffect(() => {
    void loadPersonal();
    void loadFolders();
  }, [loadPersonal, loadFolders]);

  // ?focus=<knowledgeId> deep-link: once entries load, open that entry for editing.
  // Searches across all three scope groups (mine/domain/marketplace). Switches to 'all'
  // scope so the entry is always visible. A ref prevents re-firing.
  const focusApplied = useRef(false);
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  useEffect(() => {
    if (!focusId || focusApplied.current || !personal) return;
    const all = [...(personal.mine ?? []), ...(personal.domain ?? []), ...(personal.marketplace ?? [])];
    const target = all.find((e) => e.id === focusId);
    if (!target) return; // unknown id — no-op
    focusApplied.current = true;
    setKScope('all');
    // A ?focus= deep-link opens the entry's detail in View; the ✎ Edit button
    // switches to editing (edit-scope gated), matching the OS-wide artifact model.
    void openPersonal(focusId);
  // openPersonal is defined below — safe to omit from deps (stable function reference in closure)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, personal]);

  // ── Personal knowledge ("My knowledge") ──────────────────────────────────

  async function createPersonal() {
    if (pkCreating) return;
    // The type chooser mints the note with a placeholder title, then opens it in Edit
    // where the title field is the first thing shown — the OS-wide "new artifact opens
    // in Edit" flow (Metrics/Dashboards), so there is no separate title prompt.
    const title = 'New note';
    setPkCreating(true);
    setPkMsg('');
    try {
      const res = await fetch('/api/knowledge/personal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const d = await res.json();
      if (!res.ok) { setPkMsg(d.error ?? 'Could not create.'); return; }
      setChooserOpen(false);
      await loadPersonal();
      // A NEW entry opens DIRECTLY in Edit (the OS-wide artifact model).
      setPkOpenId(d.id);
      setPkMode('edit');
      setPkDraft({ title: d.title, md: '' });
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkCreating(false); }
  }

  // Open an entry's DETAIL. `mode` lets a deep-link jump straight to Edit; a plain
  // tile click lands in VIEW (rendered markdown), then a ✎ Edit button switches.
  async function openPersonal(id: string, mode: 'view' | 'edit' = 'view') {
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${id}`, { cache: 'no-store' });
      if (!res.ok) { setPkMsg('Could not open entry.'); return; }
      const d = await res.json();
      setPkOpenId(id);
      setPkMode(mode);
      setPkDraft({ title: d.title, md: d.md });
    } catch (e) { setPkMsg((e as Error).message); }
  }

  async function savePersonal() {
    if (!pkOpenId || pkSaving) return;
    setPkSaving(true);
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${pkOpenId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: pkDraft.title, md: pkDraft.md }),
      });
      if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Could not save.'); return; }
      setPkMsg('Saved.');
      setTimeout(() => setPkMsg(''), 2000);
      // Save returns to VIEW (the rendered note), matching Metrics/Dashboards.
      setPkMode('view');
      await loadPersonal();
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkSaving(false); }
  }

  /**
   * Promote a personal entry one governed rung along Personal → Shared → Marketplace.
   */
  async function promotePersonal(id: string) {
    if (pkPromoting) return;
    setPkPromoting(true);
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${id}/promote`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setPkMsg(d.error ?? 'Could not promote.'); return; }
      setPkMsg(d.requested ? 'Requested — approve it in Policies & Approvals.' : 'Promoted.');
      // ONE OS-wide "this needs approval" confirmation (Policies link + inline approve).
      const approval = d.approval as FiledApproval | undefined;
      if (d.requested && approval?.id) notifyApprovalFiled(approval, 'knowledge', () => { void loadPersonal(); });
      setTimeout(() => setPkMsg(''), 2500);
      await loadPersonal();
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkPromoting(false); }
  }

  /**
   * Revoke sharing on a personal entry one governed rung along
   * Marketplace → Shared → Personal (`/demote`).
   */
  async function demotePersonal(id: string) {
    if (pkPromoting) return;
    setPkPromoting(true);
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${id}/demote`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setPkMsg(d.error ?? 'Could not revoke.'); return; }
      setPkMsg('Revoked.');
      setTimeout(() => setPkMsg(''), 2500);
      await loadPersonal();
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkPromoting(false); }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  const canPublish = !!user && roleAtLeast(user.role, 'builder');
  const canCertify = !!user && roleAtLeast(user.role, 'admin');

  // Edit-scope, the OS-wide fail-closed rule (mirrors the store's `canManageEntry`):
  // owner always; a Personal note is owner-only; Shared/Company admits an in-domain
  // domain_admin or a platform admin. Used to gate the ✎ Edit button and the header
  // controls — the server re-checks on every mutation, so this only hides dead affordances.
  const canManageEntry = (e: PersonalKnowledgeSummary): boolean =>
    !!user && canManageArtifact(user, { owner: e.owner, domain: e.domain, scope: scopeOf(e.visibility) });

  // A LIST TILE — click opens the entry's detail in View (rendered markdown). Tiles
  // carry no inline editor now; the detail surface owns View/Edit (matches Metrics).
  const renderTile = (e: PersonalKnowledgeSummary) => {
    const shared = e.visibility === 'Shared' || e.visibility === 'Marketplace';
    return (
      <button key={e.id} type="button" className="k-tile" onClick={() => void openPersonal(e.id)}>
        <span className="k-tile-title">{e.title}</span>
        <span className="k-tile-meta">
          {e.archived && <span className="badge muted">archived</span>}
          {shared && <DomainTag domain={e.domain} />}
          {e.visibility === 'Personal' && <span className="badge vis-personal">My</span>}
          {e.visibility === 'Shared' && <span className="badge vis-shared">Domain</span>}
          {e.visibility === 'Marketplace' && <span className="badge vis-certified">Company</span>}
        </span>
      </button>
    );
  };

  // The DETAIL surface for one open entry — the OS-wide View/Edit artifact model.
  // VIEW renders the note's markdown; a ✎ Edit button (edit-scope gated) switches to
  // the markdown editor; Save returns to View. Promote + lifecycle live in the header.
  const renderDetail = (e: PersonalKnowledgeSummary) => {
    const editable = canManageEntry(e);
    const shared = e.visibility === 'Shared' || e.visibility === 'Marketplace';
    return (
      <div style={{ marginTop: 20 }}>
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="btn ghost sm" onClick={() => { setPkOpenId(null); setPkMsg(''); }}>← All knowledge</button>
        </div>

        {/* Detail HEADER — title, scope badges, and (edit-scoped) Promote + lifecycle. */}
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{pkDraft.title || e.title}</h2>
          {e.archived && <span className="badge muted">archived</span>}
          {shared && <DomainTag domain={e.domain} />}
          {e.visibility === 'Personal' && <span className="badge vis-personal">My</span>}
          {e.visibility === 'Shared' && <span className="badge vis-shared">Domain</span>}
          {e.visibility === 'Marketplace' && <span className="badge vis-certified">Company</span>}
          {editable ? (
            <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
              {/* Promotion ladder — Personal → Shared → (Company). Unchanged governance. */}
              {!e.archived && e.visibility !== 'Marketplace' && (
                <button className="btn" onClick={() => void promotePersonal(e.id)} disabled={pkPromoting} title="Share this note along the governed promotion ladder">
                  {pkPromoting ? <span className="spin" /> : (
                    e.visibility === 'Shared'
                      ? (canCertify ? 'Certify to Company' : 'Request certification')
                      : (canPublish ? 'Promote to Domain' : 'Request promotion')
                  )}
                </button>
              )}
              {/* Revoke sharing — Company → Domain (Admin) / Domain → My (owner or Builder+). */}
              {!e.archived &&
                ((e.visibility === 'Marketplace' && canCertify) || e.visibility === 'Shared') &&
                (confirmDemoteId === e.id ? (
                  <>
                    <button className="btn sm" onClick={() => { setConfirmDemoteId(null); void demotePersonal(e.id); }} disabled={pkPromoting} style={{ background: 'var(--danger, #b42318)' }}>
                      {pkPromoting ? <span className="spin" /> : (e.visibility === 'Marketplace' ? 'Confirm revoke → Domain' : 'Confirm unshare → My')}
                    </button>
                    <button className="btn ghost sm" onClick={() => setConfirmDemoteId(null)} disabled={pkPromoting}>Cancel</button>
                  </>
                ) : (
                  <button className="btn ghost sm" onClick={() => setConfirmDemoteId(e.id)} disabled={pkPromoting} title="Revoke sharing one governed rung">
                    {e.visibility === 'Marketplace' ? 'Revoke from Company' : 'Unshare'}
                  </button>
                ))}
              <button className="btn ghost sm" onClick={() => setPkMoveId(e.id)} title="Move to a folder">Move…</button>
              {/* Lifecycle: live → Archive + Version; archived → Restore + Delete + Version. */}
              <LifecycleActions
                id={e.id}
                name={e.title}
                kind="knowledge"
                visibility={lcVis(e.visibility)}
                archived={!!e.archived}
                api={`/api/knowledge/personal/${e.id}`}
                onChanged={() => { setPkOpenId(null); void loadPersonal(); }}
                compact
              />
            </div>
          ) : null}
        </div>

        {(pkMsg === 'Promoted.' || pkMsg.startsWith('Requested') || pkMsg === 'Revoked.') ? (
          <div className="hint" style={{ marginTop: 6, color: 'var(--teal)' }}>{pkMsg}</div>
        ) : null}
        {pkMsg && pkMsg !== 'Saved.' && pkMsg !== 'Promoted.' && pkMsg !== 'Revoked.' && !pkMsg.startsWith('Requested') ? (
          <div className="error" style={{ marginTop: 6 }}>{pkMsg}</div>
        ) : null}

        {/* View ⇄ Edit toggle — Edit is edit-scope gated (server re-checks on save). */}
        <div className="row" style={{ gap: 8, margin: '12px 0' }}>
          <button className={`btn ${pkMode === 'view' ? 'primary' : 'ghost'} sm`} onClick={() => setPkMode('view')}>View</button>
          {editable ? (
            <button className={`btn ${pkMode === 'edit' ? 'primary' : 'ghost'} sm`} onClick={() => setPkMode('edit')}>✎ Edit</button>
          ) : null}
        </div>

        {pkMode === 'edit' && editable ? (
          <>
            <label className="comp-label">Title</label>
            <input
              style={{ width: '100%', marginBottom: 10 }}
              value={pkDraft.title}
              onChange={(ev) => setPkDraft((d) => ({ ...d, title: ev.target.value }))}
            />
            <label className="comp-label">Note (markdown)</label>
            <textarea
              className="k-section-editor"
              rows={16}
              value={pkDraft.md}
              onChange={(ev) => setPkDraft((d) => ({ ...d, md: ev.target.value }))}
              placeholder="Free-form markdown about you — your role, preferences, working style…"
              autoFocus
            />
            <div className="row" style={{ gap: 8, marginTop: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
              {pkMsg === 'Saved.' ? <span className="hint" style={{ color: 'var(--teal)' }}>Saved.</span> : null}
              <button className="btn ghost sm" onClick={() => setPkMode('view')} disabled={pkSaving}>Cancel</button>
              <button className="btn primary" onClick={() => void savePersonal()} disabled={pkSaving}>
                {pkSaving ? <span className="spin" /> : 'Save'}
              </button>
            </div>
          </>
        ) : (
          <div className="k-detail-body">
            {pkDraft.md.trim()
              ? <Markdown>{pkDraft.md}</Markdown>
              : <p className="hint">This note is empty.{editable ? ' Click ✎ Edit to add content.' : ''}</p>}
          </div>
        )}
      </div>
    );
  };

  // The entry whose DETAIL is open (across every lane, incl. archived); null = the list.
  const openEntry = pkOpenId
    ? [...(personal?.mine ?? []), ...(personal?.domain ?? []), ...(personal?.marketplace ?? [])]
        .find((e) => e.id === pkOpenId) ?? null
    : null;

  return (
    <>
      <PageHeader title="Knowledge" crumb="personal notes · domain · company" tutorial="knowledge" />
      <div className="content">

        {openEntry ? renderDetail(openEntry) : (<>

        <div className="row" style={{ marginTop: 18, justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <p className="lead" style={{ margin: 0, maxWidth: 720 }}>
            Reference knowledge (markdown) that grounds your agents.
          </p>
          <button className="btn" onClick={() => { setPkMsg(''); setChooserOpen(true); }}>＋ New knowledge</button>
        </div>

        {/* Scope switcher — the OS-wide four groups. */}
        <div className="seg" style={{ marginTop: 14 }}>
          {SCOPE_GROUPS.map((g) => {
            const n = g.key === 'mine' ? (personal?.mine.length ?? 0)
              : g.key === 'shared' ? (personal?.domain.length ?? 0)
              : g.key === 'marketplace' ? (personal?.marketplace.length ?? 0)
              : undefined; // 'all' has no single count
            return (
              <button key={g.key} type="button" className={kScope === g.key ? 'on' : ''} onClick={() => setKScope(g.key)}>
                {g.label('Knowledge')}{n !== undefined ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>

        {/* ── ONE folder shell (identical to Files/Data/Metrics): the scope segment
            above drives which lane's entries show; the LEFT folder rail filters them;
            the MAIN area lists the entries. No more three simultaneous lanes. ── */}
        {(() => {
          // The active lane's entries — the scope segment picks it (My/Domain/Company),
          // and 'all' concatenates the three. Each entry lives in exactly one lane
          // (by visibility), so the concat never duplicates. `editable` is per-entry:
          // Personal = always; Shared/Company = owner or a publisher (unchanged governance).
          const lane =
            kScope === 'mine' ? (personal?.mine ?? [])
            : kScope === 'shared' ? (personal?.domain ?? [])
            : kScope === 'marketplace' ? (personal?.marketplace ?? [])
            : [...(personal?.mine ?? []), ...(personal?.domain ?? []), ...(personal?.marketplace ?? [])];

          const active = lane
            .filter((e) => !e.archived)
            .filter((e) => isUnderFolder(pkFolder, e.folder ?? '/'));
          const archived = lane.filter((e) => e.archived);

          const emptyCopy =
            kScope === 'shared' ? 'No shared notes yet. Promote a personal note to share it with your domain.'
            : kScope === 'marketplace' ? 'Nothing certified yet. Admins certify general knowledge to Company.'
            : 'No personal knowledge yet. Use ＋ New knowledge to add one — it stays private to you.';

          return (
            <div style={{ marginTop: 20 }}>
              <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'baseline', marginBottom: 8 }}>
                <button
                  className="btn ghost sm"
                  style={{ opacity: showArchived ? 1 : 0.7 }}
                  onClick={() => setShowArchived((s) => !s)}
                  title="Archived notes are hidden by default"
                >
                  {showArchived ? 'Hide archived' : 'Show archived'}
                </button>
              </div>

              {pkMsg && pkMsg !== 'Saved.' && pkMsg !== 'Promoted.' && !pkMsg.startsWith('Requested') ? <div className="error" style={{ marginTop: 8 }}>{pkMsg}</div> : null}
              {(pkMsg === 'Promoted.' || pkMsg.startsWith('Requested')) ? <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{pkMsg}</div> : null}

              <FolderLayout
                allLabel="All knowledge"
                allCount={active.length}
                allSelected={pkFolder === '/'}
                onSelectAll={() => setPkFolder('/')}
                rail={(() => {
                  const treeItems = lane.map((e) => ({ id: e.id, folder: e.folder ?? '/', name: e.title }));
                  const countUnder = (path: string) => itemsUnderFolder(path, treeItems).length;
                  return (
                    <FolderTree
                      variant="nav"
                      roots={['personal']}
                      personalNodes={pkFolderNodes}
                      items={treeItems}
                      personalLabel="My folders"
                      selectedPath={pkFolder}
                      onSelect={(_scope, path) => setPkFolder(path)}
                      onCreate={(_scope, parentPath) => void createFolder(parentPath)}
                      onMove={(ref) => setFolderMove(ref)}
                      onRename={(ref, newName) => {
                        const path = renamedPath(ref.path, newName);
                        if (!path || path === ref.path) return;
                        void moveFolder(ref, path);
                      }}
                      onArchive={(ref) => void (async () => {
                        if (!(await confirm(archiveFolderCopy(folderName(ref.path), countUnder(ref.path))))) return;
                        setPkMsg('');
                        try {
                          const id = await ensureFolderId('knowledge', ref);
                          const res = await fetch(`/api/folders/${id}`, {
                            method: 'POST', headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ action: 'archive' }),
                          });
                          if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Archive failed'); return; }
                          reloadFolders();
                        } catch (e) { setPkMsg((e as Error).message); }
                      })()}
                      onRestore={(ref) => void (async () => {
                        setPkMsg('');
                        const res = await fetch(`/api/folders/${ref.id}`, {
                          method: 'POST', headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ action: 'restore' }),
                        });
                        if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Restore failed'); return; }
                        reloadFolders();
                      })()}
                      onDelete={(ref) => void (async () => {
                        if (!(await confirm(deleteFolderCopy(folderName(ref.path), countUnder(ref.path))))) return;
                        setPkMsg('');
                        const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
                        if (!res.ok) { setPkMsg((await res.json().catch(() => ({}))).error ?? 'Delete failed'); return; }
                        if (pkFolder === ref.path) setPkFolder('/');
                        reloadFolders();
                      })()}
                    />
                  );
                })()}
              >
                {personal === null ? (
                  <div className="stub-page"><span className="spin" /> Loading…</div>
                ) : active.length === 0 ? (
                  <div className="stub-page">{emptyCopy}</div>
                ) : (
                  <div className="k-tile-grid">
                    {active.map((e) => renderTile(e))}
                  </div>
                )}

                {showArchived && (
                  archived.length > 0 ? (
                    <>
                      <div className="section-title" style={{ marginTop: 20, fontSize: 12 }}>Archived</div>
                      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                        Hidden from your agents — open one to restore or delete it.
                      </p>
                      <div className="k-tile-grid">
                        {archived.map((e) => renderTile(e))}
                      </div>
                    </>
                  ) : (
                    <div className="hint" style={{ marginTop: 16 }}>No archived notes.</div>
                  )
                )}
              </FolderLayout>
            </div>
          );
        })()}

        {/* Talk to Knowledge — governed retrieval over knowledge entries. */}
        {(() => {
          const talk = TALK_PRESENTATION.knowledge;
          return (
            <div style={{ marginTop: 40 }}>
              <TalkTo tab="knowledge" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
            </div>
          );
        })()}

        </>)}
      </div>

      {/* ＋ New knowledge — the OS-wide TYPE chooser. General knowledge is authored
          here; a Workflow (business process) is authored on its own tab, which already
          carries the full steps/rules/swimlane editor + PDF export. */}
      {chooserOpen ? (
        <div className="k-chooser-backdrop" role="dialog" aria-modal="true" aria-label="New knowledge" onClick={() => setChooserOpen(false)}>
          <div className="k-chooser" onClick={(ev) => ev.stopPropagation()}>
            <div className="k-chooser-head">
              <span className="k-chooser-title">New knowledge</span>
              <button className="btn ghost sm" onClick={() => setChooserOpen(false)}>✕</button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>What kind of knowledge do you want to add?</p>

            <button
              type="button"
              className="k-chooser-option"
              onClick={() => { setKScope('mine'); void createPersonal(); }}
              disabled={pkCreating}
            >
              <span className="k-chooser-option-title">{pkCreating ? <span className="spin" /> : 'General knowledge'}</span>
              <span className="k-chooser-option-desc">
                A free-form markdown note — how you work, key contacts, context.
              </span>
            </button>

            <button
              type="button"
              className="k-chooser-option"
              onClick={() => { setChooserOpen(false); router.push('/workflows'); }}
            >
              <span className="k-chooser-option-title">Workflow →</span>
              <span className="k-chooser-option-desc">
                A business process — steps, rules and expert knowledge. Authored on the <strong>Business Processes</strong> tab.
              </span>
            </button>

            {pkCreating ? null : (
              <div className="hint" style={{ marginTop: 4 }}>General knowledge opens straight in the editor.</div>
            )}
          </div>
        </div>
      ) : null}

      {/* Folder picker modal — used by the "Move…" button on any knowledge entry. */}
      <FolderPickerModal
        open={pkMoveId !== null}
        tab="knowledge"
        personalNodes={pkFolderNodes}
        title="Move note to folder"
        onConfirm={async ({ path }) => {
          const id = pkMoveId;
          setPkMoveId(null);
          if (!id) return;
          await fetch(`/api/knowledge/personal/${id}/folder`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ folder: path }),
          });
          await loadPersonal();
          await loadFolders();
        }}
        onCancel={() => setPkMoveId(null)}
        onCreate={async (_scope, path) => {
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'knowledge', scope: 'personal', path }),
          });
          await loadFolders();
        }}
      />

      {/* Folder lifecycle: move a folder to a new parent path (the rail's ••• → Move…). */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="knowledge"
        roots={['personal']}
        personalNodes={pkFolderNodes}
        title="Move folder"
        onConfirm={({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (ref) void moveFolder(ref, path);
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (_scope, path) => {
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'knowledge', scope: 'personal', path }),
          });
          await loadFolders();
        }}
      />

      <style>{KnowledgeStyles}</style>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped styles — no cascade pollution; match the design system palette.
// ─────────────────────────────────────────────────────────────────────────────

const KnowledgeStyles = `
/* List tiles — one per note; click opens the View/Edit detail. */
.k-tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(256px, 1fr));
  gap: 14px;
  margin-top: 4px;
}
.k-tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  text-align: left;
  color: var(--text);
  font-family: var(--font-body);
  width: 100%;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.k-tile:hover {
  border-color: var(--gold-line);
  box-shadow: 0 0 0 1px var(--gold-line), 0 4px 14px rgba(200,162,74,0.07);
}
.k-tile-title {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.3px;
  line-height: 1.25;
}
.k-tile-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* Detail — the markdown editor (Edit) reuses this; View renders <Markdown>. */
.k-section-editor {
  width: 100%;
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.6;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 10px 12px;
  resize: vertical;
}
.k-detail-body {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 22px;
  background: var(--panel);
}

/* ＋ New knowledge — the type chooser (General knowledge · Workflow). */
.k-chooser-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 60;
}
.k-chooser {
  width: min(460px, 100%);
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.35);
}
.k-chooser-head { display: flex; align-items: center; justify-content: space-between; }
.k-chooser-title {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 16px;
  letter-spacing: 0.3px;
}
.k-chooser-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.k-chooser-option:hover:not(:disabled) {
  border-color: var(--gold-line);
  box-shadow: 0 0 0 1px var(--gold-line);
}
.k-chooser-option:disabled { opacity: 0.7; cursor: default; }
.k-chooser-option-title {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 14px;
}
.k-chooser-option-desc { font-size: 12.5px; line-height: 1.5; color: var(--text-muted); }
`;
