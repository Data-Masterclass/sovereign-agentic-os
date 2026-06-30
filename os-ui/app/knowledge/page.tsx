/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import WorkflowTile from '@/components/knowledge/WorkflowTile';
import WorkflowView from '@/components/knowledge/WorkflowView';
import type { WorkflowSummary } from '@/lib/knowledge/store';
import type { DomainKnowledge } from '@/lib/knowledge/schema';

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

type UserInfo = { role: string; domains: string[] };

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
  const [view, setView] = useState<'overview' | 'workflows' | 'new' | 'detail'>('overview');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Domain knowledge (top section)
  const [domainKnowledge, setDomainKnowledge] = useState<DomainKnowledge | null>(null);
  const [dkLoading, setDkLoading] = useState(true);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState('');
  const [dkSaving, setDkSaving] = useState(false);
  const [dkMsg, setDkMsg] = useState('');
  const [agentDraft, setAgentDraft] = useState('');

  // Workflows
  const [groups, setGroups] = useState<WorkflowGroups | null>(null);
  const [wfLoading, setWfLoading] = useState(true);
  const [wfError, setWfError] = useState('');

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
    } finally {
      setDkLoading(false);
    }
  }, []);

  const loadWorkflows = useCallback(async () => {
    setWfLoading(true);
    setWfError('');
    try {
      const res = await fetch('/api/knowledge/workflows', { cache: 'no-store' });
      if (res.ok) setGroups(await res.json());
      else setWfError('Could not load workflows.');
    } catch {
      setWfError('Network error loading workflows.');
    } finally {
      setWfLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDomainKnowledge();
    void loadWorkflows();
    // Load user role from existing /api/auth endpoint.
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUser(d))
      .catch(() => null);
  }, [loadDomainKnowledge, loadWorkflows]);

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
      }
    } finally {
      setDkSaving(false);
    }
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
    } finally {
      setCreating(false);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  const canPublish = user?.role === 'builder' || user?.role === 'admin';
  const allWorkflows = [
    ...(groups?.mine ?? []),
    ...(groups?.domain ?? []),
    ...(groups?.marketplace ?? []),
  ];

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
    <>
      <PageHeader title="Knowledge" crumb="domain operating manual · workflows · context" tutorial="knowledge" />
      <div className="content">

        {/* ── Tab navigation ── */}
        <div className="tabstrip">
          <button
            className={view === 'overview' ? 'active' : ''}
            onClick={() => setView('overview')}
          >
            Domain knowledge
          </button>
          <button
            className={view === 'workflows' || view === 'new' ? 'active' : ''}
            onClick={() => setView('workflows')}
          >
            Workflows
            {allWorkflows.length > 0 && (
              <span className="badge muted" style={{ marginLeft: 7, fontSize: 10 }}>
                {allWorkflows.length}
              </span>
            )}
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════
            DOMAIN KNOWLEDGE — four guided sections
        ══════════════════════════════════════════════════════════════ */}
        {view === 'overview' && (
          <>
            <p className="lead" style={{ marginTop: 18 }}>
              The domain&rsquo;s baseline context — automatically pinned as base context
              for every agent in this domain. Keep it short and current.
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
                        <button className="btn ghost sm" onClick={() => startEditSection(section.id)}>
                          Edit
                        </button>
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
                          <button className="btn ghost sm" onClick={() => setEditingSection(null)} disabled={dkSaving}>
                            Cancel
                          </button>
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
                  <div className="hint" style={{ marginTop: 8, color: 'var(--teal)' }}>{dkMsg}</div>
                )}

                {/* Knowledge agent for drafting ── */}
                <div className="section-title" style={{ marginTop: 28 }}>Draft with the knowledge agent</div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                  Describe your domain and the agent produces structured markdown — paste into any
                  section above.
                </p>
                <AgentChat
                  agent="knowledge"
                  label="knowledge agent"
                  placeholder="e.g. We run the bank submission process for mortgage applications in Germany…"
                  starters={[
                    'Draft a domain overview for our mortgage submission operation.',
                    'Write a glossary of key terms for a sales domain.',
                    'What goals should a loan operations team track?',
                  ]}
                  onAssistant={(content) => setAgentDraft(content)}
                />
                {agentDraft && (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      Agent reply — copy into a section above:
                    </div>
                    <pre className="k-prose k-agent-output">{agentDraft}</pre>
                  </div>
                )}
              </>
            ) : (
              <div className="stub-page">Could not load domain knowledge.</div>
            )}
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
              <button
                className="btn sm"
                onClick={() => setView(view === 'new' ? 'workflows' : 'new')}
              >
                {view === 'new' ? 'Cancel' : '+ New workflow'}
              </button>
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
                {groups && groups.mine.length > 0 && (
                  <>
                    <div className="section-title" style={{ marginTop: 24 }}>My workflows</div>
                    <div className="k-workflow-grid">
                      {groups.mine.map((w) => (
                        <WorkflowTile
                          key={w.id}
                          workflow={w}
                          onClick={(id) => { setSelectedWorkflowId(id); setView('detail'); }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {groups && groups.domain.length > 0 && (
                  <>
                    <div className="section-title" style={{ marginTop: 24 }}>Domain workflows</div>
                    <div className="k-workflow-grid">
                      {groups.domain.map((w) => (
                        <WorkflowTile
                          key={w.id}
                          workflow={w}
                          onClick={(id) => { setSelectedWorkflowId(id); setView('detail'); }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {groups && groups.marketplace.length > 0 && (
                  <>
                    <div className="section-title" style={{ marginTop: 24 }}>Marketplace</div>
                    <div className="k-workflow-grid">
                      {groups.marketplace.map((w) => (
                        <WorkflowTile
                          key={w.id}
                          workflow={w}
                          onClick={(id) => { setSelectedWorkflowId(id); setView('detail'); }}
                        />
                      ))}
                    </div>
                  </>
                )}

                {allWorkflows.length === 0 && (
                  <div className="stub-page" style={{ marginTop: 32 }}>
                    No workflows yet. Create one above to document a business process.
                  </div>
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
      </div>

      <style>{KnowledgeStyles}</style>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoped styles — no cascade pollution; match the design system palette.
// ─────────────────────────────────────────────────────────────────────────────

const KnowledgeStyles = `
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
