/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { roleAtLeast, type Role } from '@/lib/core/session';
import { useTabNavReset } from '@/lib/core/tab-nav';
import { SCOPE_GROUPS, type ScopeKey } from '@/lib/core/scopes';
import type { PersonalKnowledgeSummary } from '@/lib/knowledge/personal-store';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import DomainTag from '@/components/DomainTag';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';

/** Knowledge visibility (Personal/Shared/Marketplace) → OS-wide lifecycle visibility. */
const lcVis = (v: 'Personal' | 'Shared' | 'Marketplace'): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

/**
 * Knowledge tab — reference knowledge (markdown) added by users.
 *
 * My knowledge: personal notes about how you work (owner-only, promotable).
 * Shared in Domain: notes promoted to domain scope.
 * Marketplace: certified knowledge from across the org.
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
  // Clicking the Knowledge sidebar link returns to this page root.
  useTabNavReset(() => {});

  // Knowledge scope (My · Shared · Marketplace).
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
  const [showArchived, setShowArchived] = useState(false);

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

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && setUser(d.user))
      .catch(() => null);
  }, []);

  useEffect(() => {
    void loadPersonal();
  }, [loadPersonal]);

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
  const uid = user?.id ?? '';

  // One personal ("My knowledge") entry — header + open/close, and when open the
  // full detail: title/body editor, the OS-wide lifecycle cluster, the promotion
  // ladder control, and a source-domain tag once it is Shared/Marketplace.
  const renderPersonalEntry = (e: PersonalKnowledgeSummary, editable: boolean) => {
    const open = pkOpenId === e.id;
    const shared = e.visibility === 'Shared' || e.visibility === 'Marketplace';
    return (
      <div key={e.id} className="k-section">
        <div className="k-section-head">
          <span className="k-section-label">{e.title}</span>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {e.archived && <span className="badge muted">archived</span>}
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
                {/* Promotion ladder — Personal → Shared → (Marketplace). */}
                {editable && !e.archived && e.visibility !== 'Marketplace' && (
                  <button className="btn ghost sm" onClick={() => void promotePersonal(e.id)} disabled={pkPromoting} title="Share this note along the governed promotion ladder">
                    {pkPromoting ? <span className="spin" /> : (
                      e.visibility === 'Shared'
                        ? (canCertify ? 'Certify to marketplace' : 'Request certification')
                        : (canPublish ? 'Promote to domain' : 'Request promotion')
                    )}
                  </button>
                )}
                {/* Revoke sharing — Marketplace → Shared (Admin) / Shared → Personal (owner or Builder+). */}
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

  return (
    <ConfirmProvider>
      <PageHeader title="Knowledge" crumb="personal notes · shared in domain · marketplace" tutorial="knowledge" />
      <div className="content">

        <p className="lead" style={{ marginTop: 18 }}>
          Reference knowledge (markdown) that grounds your agents. <strong>My knowledge</strong> is
          personal context about how you work; <strong>Shared in Domain</strong> are notes promoted
          by domain members; <strong>Marketplace</strong> is certified knowledge from across the org.
          The <strong>Domain Operating Manual</strong> (overview / glossary / goals / context) lives
          at the top of the <strong>Workflows</strong> tab.
        </p>

        {/* ── CREATE — capture a note in one line. ── */}
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
          </form>
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

        {/* The three scope lanes in a flex column so `order` can float
            My knowledge to the top in the combined "All" view. */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>

        {/* ── SHARED: personal notes promoted to domain scope ── */}
        {(kScope === 'all' || kScope === 'shared') && (
          <div style={{ marginTop: 20, order: 2 }}>
            <div className="section-title">Shared in Domain · promoted notes</div>
            {personal === null ? (
              <div className="stub-page"><span className="spin" /> Loading…</div>
            ) : personal.domain.length === 0 ? (
              <div className="stub-page" style={{ marginTop: 8 }}>
                No shared notes yet. Promote a personal note to share it with your domain.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {personal.domain.map((e) => renderPersonalEntry(e, e.owner === uid || canPublish))}
              </div>
            )}
          </div>
        )}

        {/* ── MY KNOWLEDGE: personal general-knowledge entries ── */}
        {(kScope === 'all' || kScope === 'mine') && (() => {
          const mineActive = (personal?.mine ?? []).filter((e) => !e.archived);
          const mineArchived = (personal?.mine ?? []).filter((e) => e.archived);
          return (
          <div style={{ marginTop: 24, order: 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div className="section-title" style={{ marginTop: 0 }}>My knowledge</div>
              <button
                className="btn ghost sm"
                style={{ opacity: showArchived ? 1 : 0.7 }}
                onClick={() => setShowArchived((s) => !s)}
                title="Archived notes are hidden by default"
              >
                {showArchived ? 'Hide archived' : 'Show archived'}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Personal notes about your role and how you work — feeds your own agents &amp; assistant. Owner-only.
              Add one above; promote a note to share it with your domain.
            </p>

            {pkMsg && pkMsg !== 'Saved.' && pkMsg !== 'Promoted.' && !pkMsg.startsWith('Requested') ? <div className="error" style={{ marginTop: 8 }}>{pkMsg}</div> : null}
            {(pkMsg === 'Promoted.' || pkMsg.startsWith('Requested')) ? <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{pkMsg}</div> : null}

            {personal === null ? (
              <div className="stub-page"><span className="spin" /> Loading…</div>
            ) : mineActive.length === 0 ? (
              <div className="stub-page" style={{ marginTop: 8 }}>
                No personal knowledge yet. Add a note above — it stays private to you.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                {mineActive.map((e) => renderPersonalEntry(e, true))}
              </div>
            )}

            {showArchived && (
              mineArchived.length > 0 ? (
                <>
                  <div className="section-title" style={{ marginTop: 20, fontSize: 12 }}>Archived</div>
                  <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    Archived notes are hidden from your agents. Open one to Restore it or Delete it permanently.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {mineArchived.map((e) => renderPersonalEntry(e, true))}
                  </div>
                </>
              ) : (
                <div className="hint" style={{ marginTop: 16 }}>No archived notes.</div>
              )
            )}
          </div>
          );
        })()}

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

        {/* Talk to Knowledge — governed retrieval over knowledge entries. */}
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
/* Create call-to-action — a quiet gold-lined panel. */
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
`;
