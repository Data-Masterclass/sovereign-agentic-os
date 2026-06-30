/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SwimlaneCanvas from './SwimlaneCanvas';
import MermaidPreview from './MermaidPreview';
import StepInspector from './StepInspector';
import RulesPanel from './RulesPanel';
import TacitPanel from './TacitPanel';
import ContextPanel from './ContextPanel';
import HandoverPanel from './HandoverPanel';
import { commitWorkflow } from './commitWorkflow';
import { addStep } from '@/lib/knowledge/step-edit';
import type { Workflow, ActorType } from '@/lib/knowledge/schema';
import type { Gap } from '@/lib/knowledge/gaps';

/**
 * The workflow editor — the tri-directional surface over ONE source (`workflow.md`):
 *   • the visual swimlane (SwimlaneCanvas + StepInspector) — EDITABLE
 *   • the markdown (Monaco panel)                          — EDITABLE
 *   • the Mermaid diagram (MermaidPreview)                 — DERIVED, read-only
 * Clone of SystemView's `actingRef`/`mutate`/reload mechanism: each canvas edit
 * builds its diff from the freshly-reloaded source and commits through the same
 * sha-checked PATCH the markdown panel uses, so all three stay in sync.
 *
 * Missing-entity links are surfaced as gap flags with a jump-to-build.
 */

type WorkflowData = {
  id: string;
  title: string;
  domain: string;
  owner: string;
  status: 'draft' | 'live';
  visibility: string;
  publishedBy: string | null;
  publishedAt: string | null;
  md: string;
  tacit: string;
  sha: string;
  workflow: Workflow;
  gaps: Gap[];
  canEdit: boolean;
  canPublish: boolean;
};

type Panel = 'visual' | 'rules' | 'tacit' | 'context' | 'handover' | 'markdown' | 'mermaid' | 'gaps';

const VIS_CLASS: Record<string, string> = {
  Personal: 'vis-personal',
  Shared: 'vis-shared',
  Marketplace: 'vis-certified',
};

const ACTORS: ActorType[] = ['Human', 'Software', 'Agent'];

export default function WorkflowView({
  workflowId,
  onBack,
}: {
  workflowId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<WorkflowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel>('visual');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actErr, setActErr] = useState('');
  const actingRef = useRef(false);

  // New step form
  const [newStepTitle, setNewStepTitle] = useState('');
  const [newStepActor, setNewStepActor] = useState<ActorType>('Human');

  // Publish
  const [publishing, setPublishing] = useState(false);
  const [pubMsg, setPubMsg] = useState('');
  const [pubError, setPubError] = useState('');

  // Markdown buffer (Monaco-free fallback; a plain editor keeps the bundle light)
  const [mdDraft, setMdDraft] = useState('');
  const [mdSaving, setMdSaving] = useState(false);
  const [mdMsg, setMdMsg] = useState('');

  const reload = useCallback(async () => {
    const res = await fetch(`/api/knowledge/workflows/${workflowId}`, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) { setError(body.error ?? 'Could not load workflow'); return null; }
    setData(body as WorkflowData);
    setMdDraft((body as WorkflowData).md);
    setError('');
    return body as WorkflowData;
  }, [workflowId]);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => setLoading(false));
  }, [reload]);

  // The one-source commit: serialize the next Workflow, PATCH with the sha,
  // then reload so the swimlane / markdown / mermaid all reflect the new source.
  const mutate = useCallback(
    async (next: Workflow) => {
      if (actingRef.current) return;
      actingRef.current = true;
      setActing(true);
      setActErr('');
      try {
        await commitWorkflow(workflowId, next);
        await reload();
      } catch (e) {
        setActErr((e as Error).message);
      } finally {
        actingRef.current = false;
        setActing(false);
      }
    },
    [workflowId, reload],
  );

  async function saveMarkdown() {
    if (mdSaving || !data) return;
    setMdSaving(true);
    setMdMsg('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md: mdDraft, sha: data.sha }),
      });
      const body = await res.json();
      if (!res.ok) setMdMsg(`✗ ${body.error ?? 'Save failed'}`);
      else { setMdMsg('✓ Committed.'); await reload(); }
    } catch (e) {
      setMdMsg(`✗ ${(e as Error).message}`);
    } finally {
      setMdSaving(false);
    }
  }

  async function publish(action: 'publish' | 'certify') {
    setPublishing(true);
    setPubMsg('');
    setPubError('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const d = await res.json();
      if (!res.ok) { setPubError(d.error ?? 'Failed'); return; }
      setPubMsg(`Workflow is now ${d.visibility === 'Marketplace' ? 'in the Marketplace' : 'live'}.`);
      await reload();
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return (
    <>
      <PageHeader title="Knowledge" crumb="workflow" />
      <div className="content">
        <button className="btn ghost sm" onClick={onBack}>← Workflows</button>
        <div className="stub-page" style={{ marginTop: 16 }}><span className="spin" /> Loading…</div>
      </div>
    </>
  );

  if (error || !data) return (
    <>
      <PageHeader title="Knowledge" crumb="workflow" />
      <div className="content">
        <button className="btn ghost sm" onClick={onBack}>← Workflows</button>
        <div className="error" style={{ marginTop: 16 }}>{error || 'Workflow not found.'}</div>
      </div>
    </>
  );

  const wf = data.workflow;
  const step = selectedStep ? wf.steps.find((s) => s.id === selectedStep) ?? null : null;
  const dirty = mdDraft !== data.md;

  return (
    <>
      <PageHeader title="Knowledge" crumb={data.title} />
      <div className="content">
        {/* Header */}
        <div className="k-detail-head">
          <button className="btn ghost sm" onClick={onBack}>← Workflows</button>
          <h2 className="k-detail-title">{data.title}</h2>
          <span className={`badge ${VIS_CLASS[data.visibility] ?? 'muted'}`}>{data.visibility}</span>
          <span className={`badge ${data.status === 'live' ? 'ok' : 'muted'}`}>{data.status === 'live' ? 'Live' : 'Draft'}</span>
          {data.gaps.length > 0 && (
            <span className="badge err" title="Some step links reference a missing entity">
              ⚠ {data.gaps.length} gap{data.gaps.length === 1 ? '' : 's'}
            </span>
          )}
          {acting ? <span className="spin" title="saving…" /> : null}
          {data.publishedBy && <span className="muted" style={{ fontSize: 12 }}>published by {data.publishedBy}</span>}

          {data.canPublish && data.status === 'draft' && (
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => void publish('publish')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Publish'}
            </button>
          )}
          {data.canPublish && data.status === 'live' && data.visibility === 'Shared' && (
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => void publish('certify')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Certify to Marketplace'}
            </button>
          )}
        </div>

        {pubMsg && <div className="hint" style={{ marginBottom: 10, color: 'var(--teal)' }}>{pubMsg}</div>}
        {pubError && <div className="error" style={{ marginBottom: 10 }}>{pubError}</div>}
        {actErr && <div className="error" style={{ marginBottom: 10 }}>{actErr}</div>}

        {/* Surface tabs */}
        <div className="tabstrip">
          <button className={panel === 'visual' ? 'active' : ''} onClick={() => setPanel('visual')}>Visual flow</button>
          <button className={panel === 'rules' ? 'active' : ''} onClick={() => setPanel('rules')}>Rules</button>
          <button className={panel === 'tacit' ? 'active' : ''} onClick={() => setPanel('tacit')}>Tacit</button>
          <button className={panel === 'context' ? 'active' : ''} onClick={() => setPanel('context')}>Context</button>
          <button className={panel === 'handover' ? 'active' : ''} onClick={() => setPanel('handover')}>Handover</button>
          <button className={panel === 'markdown' ? 'active' : ''} onClick={() => setPanel('markdown')}>Markdown</button>
          <button className={panel === 'mermaid' ? 'active' : ''} onClick={() => setPanel('mermaid')}>Diagram</button>
          <button className={panel === 'gaps' ? 'active' : ''} onClick={() => setPanel('gaps')}>
            Gaps {data.gaps.length > 0 && <span className="badge err" style={{ marginLeft: 6, fontSize: 10 }}>{data.gaps.length}</span>}
          </button>
        </div>

        <div style={{ marginTop: 14 }}>
          {/* ── VISUAL FLOW ── */}
          {panel === 'visual' && (
            <>
              <SwimlaneCanvas
                workflow={wf}
                gaps={data.gaps}
                selectedStepId={selectedStep}
                canEdit={data.canEdit}
                onSelectStep={(id) => setSelectedStep((cur) => (cur === id ? null : id))}
              />

              {data.canEdit && (
                <form
                  className="k-add-step"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newStepTitle.trim()) return;
                    void mutate(addStep(wf, { title: newStepTitle.trim(), actor: newStepActor }));
                    setNewStepTitle('');
                  }}
                >
                  <input type="text" value={newStepTitle} onChange={(e) => setNewStepTitle(e.target.value)}
                    placeholder="New step title…" style={{ flex: 1 }} />
                  <select value={newStepActor} onChange={(e) => setNewStepActor(e.target.value as ActorType)}>
                    {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <button className="btn sm" type="submit" disabled={!newStepTitle.trim() || acting}>+ Add step</button>
                </form>
              )}

              {step && (
                <StepInspector
                  workflow={wf}
                  step={step}
                  gaps={data.gaps}
                  canEdit={data.canEdit}
                  mutate={(next) => void mutate(next)}
                  onClose={() => setSelectedStep(null)}
                />
              )}
            </>
          )}

          {/* ── MARKDOWN ── */}
          {panel === 'markdown' && (
            <div className="k-md-panel">
              <div className="k-md-head">
                <span className="mono" style={{ fontSize: 12 }}>workflow.md{dirty ? ' •' : ''}</span>
                {data.canEdit ? (
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    {mdMsg && <span className={mdMsg.startsWith('✓') ? 'hint' : 'error'} style={{ fontSize: 12, margin: 0 }}>{mdMsg}</span>}
                    <button className="btn sm" onClick={() => void saveMarkdown()} disabled={mdSaving || !dirty}>
                      {mdSaving ? <span className="spin" /> : dirty ? 'Save & commit' : 'Saved'}
                    </button>
                  </div>
                ) : <span className="badge muted">read-only</span>}
              </div>
              <textarea
                className="k-md-editor mono"
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                disabled={!data.canEdit}
                spellCheck={false}
                rows={24}
              />
              <p className="hint" style={{ marginTop: 8 }}>
                The same source the visual flow + diagram render from. Edits here commit to one source.
              </p>
            </div>
          )}

          {/* ── RULES (workflow-level + guardrail apply) ── */}
          {panel === 'rules' && (
            <RulesPanel
              workflow={wf}
              workflowId={workflowId}
              canEdit={data.canEdit}
              mutate={(next) => void mutate(next)}
            />
          )}

          {/* ── TACIT (sibling tacit.md) ── */}
          {panel === 'tacit' && (
            <TacitPanel
              workflowId={workflowId}
              initialTacit={data.tacit}
              canEdit={data.canEdit}
            />
          )}

          {/* ── CONTEXT (the context layer: pinned vs retrieved) ── */}
          {panel === 'context' && <ContextPanel workflowId={workflowId} />}

          {/* ── HANDOVER (workflow → agent scaffold + attach-as-context) ── */}
          {panel === 'handover' && (
            <HandoverPanel workflow={wf} workflowId={workflowId} canEdit={data.canEdit} />
          )}

          {/* ── MERMAID (derived) ── */}
          {panel === 'mermaid' && <MermaidPreview workflow={wf} />}

          {/* ── GAPS ── */}
          {panel === 'gaps' && (
            <div className="k-gaps">
              {data.gaps.length === 0 ? (
                <div className="stub-page">No gaps — every linked entity resolves.</div>
              ) : (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>
                    These step links reference an entity that doesn&rsquo;t exist yet. Jump to the right
                    tab to build it — the workflow context travels with you. Nothing is auto-created.
                  </p>
                  {data.gaps.map((g, i) => (
                    <div key={`${g.stepId}-${g.link.type}-${g.link.ref}-${i}`} className="k-gap-row">
                      <span className="badge err">{g.link.type}</span>
                      <div className="k-gap-info">
                        <span className="k-gap-step">{g.stepTitle}</span>
                        <span className="k-gap-ref mono">{g.link.label || g.link.ref}</span>
                      </div>
                      <a className="btn ghost sm" href={g.buildHref}>Build in {g.buildTab} →</a>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{WorkflowViewStyles}</style>
    </>
  );
}

const WorkflowViewStyles = `
.k-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.k-detail-title { font-family: var(--font-head); font-size: 20px; font-weight: 600; letter-spacing: 0.3px; margin: 0; }
.k-add-step { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
.k-add-step input, .k-add-step select {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
.k-md-panel { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); padding: 12px 14px; }
.k-md-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.k-md-editor {
  width: 100%; font-size: 12.5px; line-height: 1.55; resize: vertical;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 12px;
}
.k-gaps { display: flex; flex-direction: column; gap: 9px; }
.k-gap-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border: 1px solid rgba(192,57,43,0.3);
  border-radius: var(--radius); background: rgba(192,57,43,0.04);
}
.k-gap-info { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.k-gap-step { font-size: 13px; font-weight: 600; }
.k-gap-ref { font-size: 11.5px; color: var(--text-muted); word-break: break-all; }
`;
