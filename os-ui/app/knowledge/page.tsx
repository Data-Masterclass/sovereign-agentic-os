/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import WorkflowTile from '@/components/knowledge/WorkflowTile';
import WorkflowView from '@/components/knowledge/WorkflowView';
import type { WorkflowSummary } from '@/lib/knowledge/store';
import type { DomainKnowledge } from '@/lib/knowledge/schema';
import { roleAtLeast, type Role } from '@/lib/core/session';
import { useTabNavReset } from '@/lib/core/tab-nav';
import { SCOPE_GROUPS, groupByScope, activeScopeCounts, type ScopeKey } from '@/lib/core/scopes';
import type { PersonalKnowledgeSummary } from '@/lib/knowledge/personal-store';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import VersionHistory from '@/components/lifecycle/VersionHistory';
import DomainTag from '@/components/DomainTag';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';

/** Knowledge visibility (Personal/Shared/Marketplace) → OS-wide lifecycle visibility. */
const lcVis = (v: 'Personal' | 'Shared' | 'Marketplace'): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

/**
 * Knowledge tab — the domain's operating manual.
 *
 * TOP:   General domain knowledge — four guided sections (overview / glossary /
 *        goals / context). Automatically the base context for every domain agent.
 *
 * BELOW: Workflow tiles — one per business process. Each opens the tri-directional
 *        step editor (visual swimlane + Monaco markdown + Mermaid). Phase 1 shows
 *        the raw source; Phase 2 wires the full editor.
 *
 * Surface: knowledge, workflows, a search box. All tooling hidden.
 */

type WorkflowGroups = {
  mine: WorkflowSummary[];
  domain: WorkflowSummary[];
  marketplace: WorkflowSummary[];
};

type UserInfo = { id: string; role: Role; domains: string[] };

type PersonalGroups = {
  mine: PersonalKnowledgeSummary[];
  domain: PersonalKnowledgeSummary[];
  marketplace: PersonalKnowledgeSummary[];
};

const SECTION_PLACEHOLDERS: Record<string, string> = {
  overview:
    'A short description of this domain — what it does, who it serves, and what makes it distinct…',
  glossary:
    'Key terms and their definitions — e.g.\n\n**Data Product:** A certified, shared dataset in the marketplace.',
  goals:
    'The domain\'s current objectives — e.g.\n\n- Reduce submission error rate below 0.1%\n- Achieve 48h SLA on bank submissions',
  context:
    'Background knowledge agents need — key partners, systems, constraints, deadlines…',
};

export default function KnowledgePage() {
  const [view, setView] = useState<'overview' | 'workflows' | 'new' | 'detail'>('workflows');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Clicking the Knowledge sidebar link while inside a workflow detail returns to
  // the tab root (same-route client nav wouldn't otherwise re-mount this page).
  useTabNavReset(() => { setSelectedWorkflowId(null); setView('workflows'); });

  // Domain knowledge (top section)
  const [domainKnowledge, setDomainKnowledge] = useState<DomainKnowledge | null>(null);
  const [dkLoading, setDkLoading] = useState(true);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState('');
  const [dkSaving, setDkSaving] = useState(false);
  const [dkMsg, setDkMsg] = useState('');
  const [dkHistory, setDkHistory] = useState(false);

  // Knowledge sub-area scope (Shared = domain sections · My = personal entries · Marketplace).
  const [kScope, setKScope] = useState<ScopeKey>('all');

  // Personal general-knowledge entries ("My knowledge").
  const [personal, setPersonal] = useState<PersonalGroups | null>(null);
  const [pkNewTitle, setPkNewTitle] = useState('');
  const [pkCreating, setPkCreating] = useState(false);
  const [pkOpenId, setPkOpenId] = useState<string | null>(null);
  const [pkDraft, setPkDraft] = useState<{ title: string; md: string }>({ title: '', md: '' });
  const [pkSaving, setPkSaving] = useState(false);
  const [pkMsg, setPkMsg] = useState('');
  const [pkPromoting, setPkPromoting] = useState(false);
  const [confirmDemoteId, setConfirmDemoteId] = useState<string | null>(null);

  // Workflows
  const [groups, setGroups] = useState<WorkflowGroups | null>(null);
  const [wfScope, setWfScope] = useState<ScopeKey>('all');
  const [wfLoading, setWfLoading] = useState(true);
  const [wfError, setWfError] = useState('');
  // Archive/lifecycle UI
  const [showArchived, setShowArchived] = useState(false);

  // New workflow form
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // User info for role-based UI
  const [user, setUser] = useState<UserInfo | null>(null);

  const loadDomainKnowledge = useCallback(async () => {
    setDkLoading(true);
    try {
      const res = await fetch('/api/knowledge/domain', { cache: 'no-store' });
      if (res.ok) setDomainKnowledge(await res.json());
    } catch {
      /* leave domainKnowledge null → the "Could not load" surface renders */
    } finally {
      setDkLoading(false);
    }
  }, []);

  const loadPersonal = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge/personal${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      if (res.ok) setPersonal(await res.json());
    } catch {
      /* leave personal null → the sub-area shows its loading/empty surface */
    }
  }, [showArchived]);

  const loadWorkflows = useCallback(async () => {
    setWfLoading(true);
    setWfError('');
    try {
      // ?archived=1 additionally returns soft-archived workflows (shown in their
      // own section with Restore / Delete).
      const res = await fetch(`/api/knowledge/workflows${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      if (res.ok) setGroups(await res.json());
      else setWfError('Could not load workflows.');
    } catch {
      setWfError('Network error loading workflows.');
    } finally {
      setWfLoading(false);
    }
  }, [showArchived]);

  useEffect(() => {
    void loadDomainKnowledge();
    // Load user role from existing /api/auth endpoint. `/api/auth/me` nests the
    // profile under `.user`, so read that (else role stays undefined and the
    // Builder-only affordances never light up).
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && setUser(d.user))
      .catch(() => null);
  }, [loadDomainKnowledge]);

  // Reload workflows + personal knowledge whenever the archived filter toggles
  // (both loaders depend on showArchived).
  useEffect(() => {
    void loadWorkflows();
    void loadPersonal();
  }, [loadWorkflows, loadPersonal]);

  // ── Domain section editing ───────────────────────────────────────────────

  function startEditSection(id: string) {
    const sec = domainKnowledge?.sections.find((s) => s.id === id);
    setSectionDraft(sec?.content ?? '');
    setEditingSection(id);
    setDkMsg('');
  }

  async function saveSectionDraft() {
    if (!editingSection || dkSaving) return;
    setDkSaving(true);
    try {
      const res = await fetch('/api/knowledge/domain', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sections: [{ id: editingSection, content: sectionDraft }] }),
      });
      if (res.ok) {
        setDomainKnowledge(await res.json());
        setEditingSection(null);
        setDkMsg('Saved.');
        setTimeout(() => setDkMsg(''), 2000);
      } else {
        setDkMsg('Could not save — please retry.');
      }
    } catch {
      setDkMsg('Could not save — please retry.');
    } finally {
      setDkSaving(false);
    }
  }

  // ── Personal knowledge ("My knowledge") ──────────────────────────────────

  async function createPersonal() {
    const title = pkNewTitle.trim();
    if (!title || pkCreating) return;
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
      setPkNewTitle('');
      await loadPersonal();
      // Open the fresh entry for immediate editing.
      setPkOpenId(d.id);
      setPkDraft({ title: d.title, md: '' });
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkCreating(false); }
  }

  async function openPersonal(id: string) {
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${id}`, { cache: 'no-store' });
      if (!res.ok) { setPkMsg('Could not open entry.'); return; }
      const d = await res.json();
      setPkOpenId(id);
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
      await loadPersonal();
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkSaving(false); }
  }

  /**
   * Promote a personal entry one governed rung along Personal → Shared → Marketplace.
   * Reuses the SAME ladder every artifact rides (`/promote`): a Builder+ promotes
   * (Admin certifies) in one shot; a creator files request_promotion (docs-first).
   */
  async function promotePersonal(id: string) {
    if (pkPromoting) return;
    setPkPromoting(true);
    setPkMsg('');
    try {
      const res = await fetch(`/api/knowledge/personal/${id}/promote`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setPkMsg(d.error ?? 'Could not promote.'); return; }
      setPkMsg(d.requested ? 'Requested — an approver will review it.' : 'Promoted.');
      setTimeout(() => setPkMsg(''), 2500);
      await loadPersonal();
    } catch (e) { setPkMsg((e as Error).message); }
    finally { setPkPromoting(false); }
  }

  /**
   * Revoke sharing on a personal entry one governed rung along
   * Marketplace → Shared → Personal (`/demote`). Server is the fail-closed authority;
   * this only fires for eligible users. Lineage-aware errors surface via setPkMsg.
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

  // ── Create workflow ──────────────────────────────────────────────────────

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
      if (!res.ok) { setCreateError(d.error ?? 'Failed to create workflow.'); return; }
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  const canPublish = !!user && roleAtLeast(user.role, 'builder');
  const canCertify = !!user && roleAtLeast(user.role, 'admin');
  const uid = user?.id ?? '';
  const allWorkflows = [
    ...(groups?.mine ?? []),
    ...(groups?.domain ?? []),
    ...(groups?.marketplace ?? []),
  ];
  // The OS-wide four groups (All · My · Shared · Marketplace), owner-scoped for "My".
  const wfScoped = groups ? groupByScope(groups, uid) : null;
  const wfCounts = groups ? activeScopeCounts(groups, uid) : null;
  const scopedWorkflows = (wfScoped ? wfScoped[wfScope] : []).filter((w) => !w.archived);
  const archivedWorkflows = allWorkflows.filter((w) => w.archived);
  const activeCount = allWorkflows.filter((w) => !w.archived).length;

  const openWorkflow = (id: string) => { setSelectedWorkflowId(id); setView('detail'); };

  // One workflow card + its lifecycle actions (the OS-wide Archive/Restore · Delete ·
  // Version-history cluster). The tile is a bare <button>, so the controls live in a
  // sibling action row — never nested inside the button.
  const renderCell = (w: WorkflowSummary) => (
    <div key={w.id} className="k-wf-cell">
      <WorkflowTile workflow={w} onClick={openWorkflow} />
      <div className="k-wf-actions">
        <LifecycleActions
          id={w.id}
          name={w.title}
          kind="knowledge"
          visibility={lcVis(w.visibility)}
          archived={!!w.archived}
          api={`/api/knowledge/workflows/${w.id}`}
          onChanged={() => void loadWorkflows()}
          compact
          surface="tile"
        />
      </div>
    </div>
  );

  // One personal ("My knowledge") entry — header + open/close, and when open the
  // full detail: title/body editor, the OS-wide lifecycle cluster (Archive/Restore ·
  // Delete-when-archived · Version history), the promotion ladder control, and a
  // source-domain tag once it is Shared/Marketplace. Reused across all scopes so a
  // promoted note keeps its full detail (versions + governance) wherever it lands.
  const renderPersonalEntry = (e: PersonalKnowledgeSummary, editable: boolean) => {
    const open = pkOpenId === e.id;
    const shared = e.visibility === 'Shared' || e.visibility === 'Marketplace';
    return (
      <div key={e.id} className="k-section">
        <div className="k-section-head">
          <span className="k-section-label">{e.title}</span>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {shared && <DomainTag domain={e.domain} />}
            {e.visibility === 'Shared' && <span className="badge vis-shared">Shared in Domain</span>}
            {e.visibility === 'Marketplace' && <span className="badge vis-certified">Certified</span>}
            <button className="btn ghost sm" onClick={() => void (open ? setPkOpenId(null) : openPersonal(e.id))}>
              {open ? 'Close' : 'Open'}
            </button>
          </div>
        </div>
        {open ? (
          <>
            <input
              style={{ width: '100%', marginBottom: 8 }}
              value={pkDraft.title}
              disabled={!editable}
              onChange={(ev) => setPkDraft((d) => ({ ...d, title: ev.target.value }))}
            />
            <textarea
              className="k-section-editor"
              rows={6}
              value={pkDraft.md}
              disabled={!editable}
              onChange={(ev) => setPkDraft((d) => ({ ...d, md: ev.target.value }))}
              placeholder="Free-form markdown about you — your role, preferences, working style…"
              autoFocus
            />
            <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Lifecycle lives inside the opened detail: live → Archive + Version;
                  archived → Restore + Delete + Version. */}
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
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                {pkMsg === 'Saved.' ? <span className="hint" style={{ color: 'var(--teal)' }}>Saved.</span> : null}
                {/* Promotion ladder — Personal → Shared → (Marketplace).
                    Docs-first: Builder+ promotes / Admin certifies, a creator files a request. */}
                {editable && !e.archived && e.visibility !== 'Marketplace' && (
                  <button className="btn ghost sm" onClick={() => void promotePersonal(e.id)} disabled={pkPromoting} title="Share this note along the governed promotion ladder">
                    {pkPromoting ? <span className="spin" /> : (
                      e.visibility === 'Shared'
                        ? (canCertify ? 'Certify to marketplace' : 'Request certification')
                        : (canPublish ? 'Promote to domain' : 'Request promotion')
                    )}
                  </button>
                )}
                {/* Revoke sharing — Marketplace → Shared (Admin) / Shared → Personal (owner or Builder+).
                    Two-step confirm; server is the fail-closed authority. */}
                {!e.archived &&
                  ((e.visibility === 'Marketplace' && canCertify) ||
                    (e.visibility === 'Shared' && editable)) &&
                  (confirmDemoteId === e.id ? (
                    <>
                      <button className="btn sm" onClick={() => { setConfirmDemoteId(null); void demotePersonal(e.id); }} disabled={pkPromoting} style={{ background: 'var(--danger, #b42318)' }}>
                        {pkPromoting ? <span className="spin" /> : (e.visibility === 'Marketplace' ? 'Confirm revoke → Shared' : 'Confirm unshare → Personal')}
                      </button>
                      <button className="btn ghost sm" onClick={() => setConfirmDemoteId(null)} disabled={pkPromoting}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn ghost sm" onClick={() => setConfirmDemoteId(e.id)} disabled={pkPromoting} title="Revoke sharing one governed rung">
                      {e.visibility === 'Marketplace' ? 'Revoke from Marketplace' : 'Unshare'}
                    </button>
                  ))}
                {editable && (
                  <button className="btn sm" onClick={() => void savePersonal()} disabled={pkSaving}>
                    {pkSaving ? <span className="spin" /> : 'Save'}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  // ── Workflow detail — the tri-directional editor (swimlane + markdown + Mermaid) ─

  if (view === 'detail' && selectedWorkflowId) {
    return (
      <WorkflowView
        workflowId={selectedWorkflowId}
        onBack={() => { setSelectedWorkflowId(null); setView('workflows'); void loadWorkflows(); }}
      />
    );
  }

  return (
    <ConfirmProvider>
      <PageHeader title="Knowledge" crumb="domain operating manual · workflows · context" tutorial="knowledge" />
      <div className="content">

        {/* ── Tab navigation (Workflows first, then General) ── */}
        <div className="tabstrip">
          <button
            className={view === 'workflows' || view === 'new' ? 'active' : ''}
            onClick={() => setView('workflows')}
          >
            Workflows
            {activeCount > 0 && (
              <span className="badge muted" style={{ marginLeft: 7, fontSize: 10 }}>
                {activeCount}
              </span>
            )}
          </button>
          <button
            className={view === 'overview' ? 'active' : ''}
            onClick={() => setView('overview')}
          >
            General
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════
            KNOWLEDGE — four groups: All · My · Shared · Marketplace
            My      = personal entries about the user (feeds their own agents)
            Shared  = the domain operating manual (four guided sections)
            Market  = certified general-knowledge entries about other domains
        ══════════════════════════════════════════════════════════════ */}
        {view === 'overview' && (
          <>
            <p className="lead" style={{ marginTop: 18 }}>
              General knowledge that grounds your agents. <strong>My knowledge</strong> is
              personal context about how you work; <strong>Shared in Domain</strong> is the
              domain&rsquo;s operating manual; <strong>Marketplace</strong> is certified
              knowledge from across the org.
            </p>

            {/* ── CREATE — the tab's focal point: capture a note in one line, or
                start a workflow. Primary action lives up top, never buried. ── */}
            <div className="k-create">
              <div className="k-create-lead">
                <div className="k-create-title">New knowledge</div>
                <p className="hint" style={{ margin: 0 }}>
                  Jot a personal note about how you work — it grounds your own agents and
                  can be promoted to the domain later.
                </p>
              </div>
              <form
                onSubmit={(ev) => { ev.preventDefault(); setKScope('mine'); void createPersonal(); }}
                className="k-create-form"
              >
                <input
                  value={pkNewTitle}
                  onChange={(ev) => setPkNewTitle(ev.target.value)}
                  placeholder="e.g. How I like reports, key contacts, my domain…"
                  aria-label="New knowledge note title"
                />
                <button className="btn" type="submit" disabled={pkCreating || !pkNewTitle.trim()}>
                  {pkCreating ? <span className="spin" /> : 'Add note'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => { setView('new'); }}
                  title="Document a business process as a workflow"
                >
                  + Workflow
                </button>
              </form>
            </div>

            {/* Scope switcher — the OS-wide four groups. */}
            <div className="seg" style={{ marginTop: 14 }}>
              {SCOPE_GROUPS.map((g) => {
                const n = g.key === 'mine' ? (personal?.mine.length ?? 0)
                  : g.key === 'shared' ? (
                      (domainKnowledge?.sections.filter((s) => s.content).length ?? 0) +
                      (personal?.domain.length ?? 0)
                    )
                  : g.key === 'marketplace' ? (personal?.marketplace.length ?? 0)
                  : undefined; // 'all' has no single count
                return (
                  <button key={g.key} type="button" className={kScope === g.key ? 'on' : ''} onClick={() => setKScope(g.key)}>
                    {g.label('Knowledge')}{n !== undefined ? ` (${n})` : ''}
                  </button>
                );
              })}
            </div>

            {/* The three scope lanes in a flex column so `order` can float
                My knowledge to the top in the combined "All" view (the tab's
                focal content), ahead of Shared and Marketplace. */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>

            {/* ── SHARED: the domain operating manual (four guided sections) ── */}
            {(kScope === 'all' || kScope === 'shared') && (
              <div style={{ marginTop: 20, order: 2 }}>
                <div className="section-title">Shared in Domain · the domain operating manual</div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  Pinned as base context for every agent in this domain. Keep it short and current.
                </p>
                {dkLoading ? (
                  <div className="stub-page"><span className="spin" /> Loading…</div>
                ) : domainKnowledge ? (
                  <>
                    {domainKnowledge.sections.map((section) => (
                      <div key={section.id} className="k-section">
                        <div className="k-section-head">
                          <span className="k-section-label">{section.title}</span>
                          {editingSection !== section.id && (
                            <button className="btn ghost sm" onClick={() => startEditSection(section.id)}>Edit</button>
                          )}
                        </div>
                        {editingSection === section.id ? (
                          <>
                            <textarea
                              className="k-section-editor"
                              rows={6}
                              value={sectionDraft}
                              onChange={(e) => setSectionDraft(e.target.value)}
                              placeholder={SECTION_PLACEHOLDERS[section.id]}
                              autoFocus
                            />
                            <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                              <button className="btn ghost sm" onClick={() => setEditingSection(null)} disabled={dkSaving}>Cancel</button>
                              <button className="btn sm" onClick={() => void saveSectionDraft()} disabled={dkSaving}>
                                {dkSaving ? <span className="spin" /> : 'Save'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="k-section-body">
                            {section.content ? (
                              <pre className="k-prose">{section.content}</pre>
                            ) : (
                              <span className="muted" style={{ fontSize: 13, fontStyle: 'italic' }}>
                                {SECTION_PLACEHOLDERS[section.id]}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                    {dkMsg && (
                      dkMsg === 'Saved.'
                        ? <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{dkMsg}</div>
                        : <div className="error" style={{ marginTop: 8 }}>{dkMsg}</div>
                    )}
                    {/* Version history for the whole card — the SAME shared panel +
                        reversible restore every other knowledge artifact has. */}
                    <div className="lc-actions row" style={{ gap: 8, alignItems: 'center', marginTop: 12 }}>
                      <button
                        type="button"
                        className={`btn ghost sm${dkHistory ? ' on' : ''}`}
                        onClick={() => setDkHistory((v) => !v)}
                        aria-expanded={dkHistory}
                      >
                        {dkHistory ? 'Hide history' : 'Version history'}
                      </button>
                    </div>
                    {dkHistory && (
                      <div className="lc-history-panel">
                        <VersionHistory
                          basePath={`/api/knowledge/domain/${encodeURIComponent(domainKnowledge.domain)}`}
                          name="Domain knowledge"
                          onRestored={() => void loadDomainKnowledge()}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="stub-page">Could not load domain knowledge.</div>
                )}

                {/* Personal notes promoted to the domain (Shared visibility). They
                    ride the same governed ladder; each carries its source-domain tag. */}
                {personal && personal.domain.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <div className="section-title" style={{ marginTop: 0, fontSize: 12 }}>Shared notes</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                      {personal.domain.map((e) => renderPersonalEntry(e, e.owner === uid || canPublish))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── MY KNOWLEDGE: personal general-knowledge entries — the tab's
                focal lane (order 1 in the combined view). ── */}
            {(kScope === 'all' || kScope === 'mine') && (
              <div style={{ marginTop: 24, order: 1 }}>
                <div className="section-title" style={{ marginTop: 0 }}>My knowledge</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  Personal notes about your role and how you work — feeds your own agents &amp; assistant. Owner-only.
                  Add one above; promote a note to share it with your domain.
                </p>

                {pkMsg && pkMsg !== 'Saved.' && pkMsg !== 'Promoted.' && !pkMsg.startsWith('Requested') ? <div className="error" style={{ marginTop: 8 }}>{pkMsg}</div> : null}
                {(pkMsg === 'Promoted.' || pkMsg.startsWith('Requested')) ? <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{pkMsg}</div> : null}

                {personal === null ? (
                  <div className="stub-page"><span className="spin" /> Loading…</div>
                ) : personal.mine.length === 0 ? (
                  <div className="stub-page" style={{ marginTop: 8 }}>
                    No personal knowledge yet. Add a note above — it stays private to you.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                    {personal.mine.map((e) => renderPersonalEntry(e, true))}
                  </div>
                )}
              </div>
            )}

            {/* ── MARKETPLACE: certified general-knowledge entries ── */}
            {(kScope === 'all' || kScope === 'marketplace') && (
              <div style={{ marginTop: 24, order: 3 }}>
                <div className="section-title">Marketplace · certified knowledge</div>
                {personal === null ? (
                  <div className="stub-page"><span className="spin" /> Loading…</div>
                ) : personal.marketplace.length === 0 ? (
                  <div className="stub-page" style={{ marginTop: 8 }}>
                    Nothing certified yet. Admins certify general knowledge into the marketplace.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                    {personal.marketplace.map((e) => renderPersonalEntry(e, e.owner === uid || canPublish))}
                  </div>
                )}
              </div>
            )}
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════
            WORKFLOWS — tile grid
        ══════════════════════════════════════════════════════════════ */}
        {(view === 'workflows' || view === 'new') && (
          <>
            <div className="row" style={{ marginTop: 18, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
              <p className="lead" style={{ margin: 0 }}>
                One tile per business process — steps, decision rules, and tacit knowledge
                that agents follow.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className={`btn ghost sm ${showArchived ? 'active' : ''}`}
                  onClick={() => setShowArchived((s) => !s)}
                >
                  {showArchived ? 'Hide archived' : 'Show archived'}
                </button>
                <button
                  className="btn sm"
                  onClick={() => setView(view === 'new' ? 'workflows' : 'new')}
                >
                  {view === 'new' ? 'Cancel' : '+ New workflow'}
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
                    placeholder="Workflow name — e.g. Bank Submission, Customer Onboarding…"
                    autoFocus
                    style={{ flex: 1 }}
                  />
                  <button className="btn" type="submit" disabled={creating || !newTitle.trim()}>
                    {creating ? <span className="spin" /> : 'Create'}
                  </button>
                </form>
                {createError && <div className="error" style={{ marginTop: 8 }}>{createError}</div>}
              </div>
            )}

            {wfLoading ? (
              <div className="stub-page" style={{ marginTop: 24 }}>
                <span className="spin" /> Loading workflows…
              </div>
            ) : wfError ? (
              <div className="error" style={{ marginTop: 16 }}>{wfError}</div>
            ) : (
              <>
                {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
                <div className="seg" style={{ marginTop: 18 }}>
                  {SCOPE_GROUPS.map((g) => (
                    <button key={g.key} type="button" className={wfScope === g.key ? 'on' : ''} onClick={() => setWfScope(g.key)}>
                      {g.label('Workflows')}{wfCounts ? ` (${wfCounts[g.key]})` : ''}
                    </button>
                  ))}
                </div>

                {scopedWorkflows.length > 0 ? (
                  <div className="k-workflow-grid" style={{ marginTop: 16 }}>{scopedWorkflows.map(renderCell)}</div>
                ) : null}

                {scopedWorkflows.length === 0 && !showArchived && (
                  <div className="stub-page" style={{ marginTop: 32 }}>
                    {wfScope === 'mine' || wfScope === 'all'
                      ? 'No workflows yet. Create one above to document a business process.'
                      : wfScope === 'shared'
                        ? 'Nothing shared in your domain yet — publish a workflow to share it.'
                        : 'Nothing in the marketplace yet.'}
                  </div>
                )}

                {showArchived && (
                  archivedWorkflows.length > 0 ? (
                    <>
                      <div className="section-title" style={{ marginTop: 28 }}>Archived</div>
                      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                        Archived workflows are hidden from agents and the working lists.
                        Restore brings one back; Delete removes it permanently.
                      </p>
                      <div className="k-workflow-grid">{archivedWorkflows.map(renderCell)}</div>
                    </>
                  ) : (
                    <div className="hint" style={{ marginTop: 20 }}>No archived workflows.</div>
                  )
                )}

                {!canPublish && allWorkflows.some((w) => w.status === 'draft') && (
                  <div className="hint" style={{ marginTop: 16 }}>
                    Draft workflows are visible to you and domain builders.
                    A builder or admin publishes them to make them live.
                  </div>
                )}
              </>
            )}
          </>
        )}


        {/* Talk to Knowledge — governed retrieval over workflows + knowledge entries. */}
        {(() => {
          const talk = TALK_PRESENTATION.knowledge;
          return (
            <div style={{ marginTop: 40 }}>
              <TalkTo tab="knowledge" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
            </div>
          );
        })()}
      </div>

      <style>{KnowledgeStyles}</style>
    </ConfirmProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped styles — no cascade pollution; match the design system palette.
// ─────────────────────────────────────────────────────────────────────────────

const KnowledgeStyles = `
/* Create call-to-action — the tab's focal affordance. A quiet gold-lined panel
   (not a loud hero): title + one-line helper on the left, capture form on the right. */
.k-create {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  margin-top: 18px;
  padding: 16px 20px;
  border: 1px solid var(--gold-line);
  border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(200,162,74,0.05), transparent);
}
.k-create-lead { min-width: 220px; flex: 1 1 260px; }
.k-create-title {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}
.k-create-form {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 1 1 340px;
  min-width: 260px;
}
.k-create-form input { flex: 1; min-width: 0; }

/* Domain knowledge sections */
.k-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin-top: 14px;
  background: var(--panel);
}
.k-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.k-section-label {
  font-family: var(--font-head);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--gold-text);
}
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
.k-section-body { margin-top: 2px; }
.k-prose {
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  color: var(--text);
}
.k-agent-output {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  cursor: text;
  user-select: text;
}

/* Workflow grid */
.k-workflow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(256px, 1fr));
  gap: 14px;
  margin-top: 12px;
}
/* A workflow card + its lifecycle action row (archive / restore / delete). */
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

/* New workflow form */
.k-new-form {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-top: 14px;
}

/* Workflow tile (also in WorkflowTile.tsx but scoped here too for detail view) */
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
