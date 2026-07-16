/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import WorkflowTile from '@/components/knowledge/WorkflowTile';
import WorkflowView from '@/components/knowledge/WorkflowView';
import type { WorkflowSummary } from '@/lib/knowledge/store';
import { roleAtLeast, type Role } from '@/lib/core/session';
import { useTabNavReset } from '@/lib/core/tab-nav';
import { SCOPE_GROUPS, groupByScope, activeScopeCounts, type ScopeKey } from '@/lib/core/scopes';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility as LcVisibility } from '@/lib/core/lifecycle';

/** Workflow visibility → OS-wide lifecycle visibility. */
const lcVis = (v: 'Personal' | 'Shared' | 'Marketplace'): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Marketplace' ? 'certified' : 'personal';

type WorkflowGroups = {
  mine: WorkflowSummary[];
  domain: WorkflowSummary[];
  marketplace: WorkflowSummary[];
};

type UserInfo = { id: string; role: Role; domains: string[] };

export default function WorkflowsPage() {
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list');
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Clicking the Workflows sidebar link while inside a detail returns to the list.
  useTabNavReset(() => { setSelectedWorkflowId(null); setView('list'); });

  const [groups, setGroups] = useState<WorkflowGroups | null>(null);
  const [wfScope, setWfScope] = useState<ScopeKey>('all');
  const [wfLoading, setWfLoading] = useState(true);
  const [wfError, setWfError] = useState('');
  const [showArchived, setShowArchived] = useState(false);

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
      if (res.ok) setGroups(await res.json());
      else setWfError('Could not load workflows.');
    } catch {
      setWfError('Network error loading workflows.');
    } finally {
      setWfLoading(false);
    }
  }, [showArchived]);

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

  const openWorkflow = (id: string) => { setSelectedWorkflowId(id); setView('detail'); };

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
      <PageHeader title="Workflows" crumb="business processes · steps · decision rules" tutorial="knowledge" />
      <div className="content">

        <div className="row" style={{ marginTop: 18, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
          <p className="lead" style={{ margin: 0 }}>
            One tile per business process — steps, decision rules, and tacit knowledge
            that agents follow.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn ghost"
              style={{ opacity: showArchived ? 1 : 0.7 }}
              onClick={() => setShowArchived((s) => !s)}
              title="Archived workflows are hidden by default"
            >
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
            <button
              className="btn"
              onClick={() => setView(view === 'new' ? 'list' : 'new')}
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
            {/* Scope switcher — All · My · Shared · Marketplace. */}
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
                    ? 'Nothing in Domain yet — promote a workflow to share it with your domain.'
                    : 'Nothing in Company yet.'}
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
