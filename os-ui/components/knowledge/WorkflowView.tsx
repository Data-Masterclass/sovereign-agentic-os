/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SwimlaneCanvas from './SwimlaneCanvas';
import MermaidPreview from './MermaidPreview';
import StepInspector from './StepInspector';
import ActorsPanel from './ActorsPanel';
import RulesPanel from './RulesPanel';
import TacitPanel from './TacitPanel';
import HandoverPanel from './HandoverPanel';
import { commitWorkflow } from './commitWorkflow';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import DomainTag from '@/components/DomainTag';
import { addStep } from '@/lib/knowledge/step-edit';
import { buildWorkflowReport, workflowPdfFilename } from '@/lib/knowledge/workflow-pdf';
import { renderSwimlaneSvg } from '@/lib/knowledge/swimlane-svg';
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
  archived?: boolean;
  md: string;
  tacit: string;
  sha: string;
  workflow: Workflow;
  gaps: Gap[];
  canEdit: boolean;
  canPublish: boolean;
};

type Panel = 'visual' | 'actors' | 'rules' | 'tacit' | 'handover' | 'markdown' | 'mermaid' | 'gaps';

const VIS_CLASS: Record<string, string> = {
  Personal: 'vis-personal',
  Shared: 'vis-shared',
  Marketplace: 'vis-certified',
};
const VIS_LABEL: Record<string, string> = {
  Personal: 'Personal',
  Shared: 'Shared in Domain',
  Marketplace: 'Marketplace',
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

  // Export PDF (client-side jsPDF — same stack as the Agents run report).
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState('');

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'Could not load workflow'); return null; }
      setData(body as WorkflowData);
      setMdDraft((body as WorkflowData).md);
      setError('');
      return body as WorkflowData;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
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

  /**
   * Rasterise a standalone SVG string to a PNG data URL at `scale`× so the flow
   * embeds crisply in the PDF. Browser-only (Image + canvas); the SVG itself is
   * built by the pure `renderSwimlaneSvg`. Returns null if the raster fails so the
   * export can still produce the text sections.
   */
  async function svgToPng(svg: string, w: number, h: number, scale = 2): Promise<{ dataUrl: string; w: number; h: number } | null> {
    try {
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('swimlane image failed to load'));
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png'), w, h };
    } catch {
      return null;
    }
  }

  /** Build + download a PDF of the whole workflow — swimlane on page 1, then content. */
  async function exportPdf() {
    if (!data || pdfBusy) return;
    setPdfBusy(true);
    setPdfErr('');
    try {
      const { jsPDF } = await import('jspdf');
      const wf = data.workflow;
      const report = buildWorkflowReport(wf, data.gaps);

      // Per-step gap counts so the printed swimlane carries the ⚠ markers.
      const gapByStep = new Map<string, number>();
      for (const g of data.gaps) gapByStep.set(g.stepId, (gapByStep.get(g.stepId) ?? 0) + 1);
      const { svg, width, height } = renderSwimlaneSvg(wf, { gapFor: (s) => gapByStep.get(s.id) ?? 0 });
      const png = wf.steps.length > 0 ? await svgToPng(svg, width, height) : null;

      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const M = 40;
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      let y = M;
      const line = (text: string, size = 10, bold = false, gap = 14, color: [number, number, number] = [20, 20, 20]) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.setTextColor(...color);
        for (const l of doc.splitTextToSize(text, W - M * 2)) {
          if (y > H - M) { doc.addPage(); y = M; }
          doc.text(l, M, y);
          y += gap;
        }
      };
      const space = (h = 8) => { y += h; };

      // ── Page 1: the beautiful visual flow (swimlane) ──────────────────────
      line(report.title, 18, true, 22);
      if (report.subtitle) line(report.subtitle, 10, false, 16, [110, 110, 110]);
      space(6);
      if (png) {
        // Fit the swimlane inside the page's content box, preserving aspect.
        const availW = W - M * 2;
        const availH = H - y - M;
        const ratio = Math.min(availW / png.w, availH / png.h, 1);
        const dw = png.w * ratio;
        const dh = png.h * ratio;
        doc.addImage(png.dataUrl, 'PNG', M + (availW - dw) / 2, y, dw, dh);
      } else {
        line(wf.steps.length === 0 ? 'No steps yet — the visual flow is empty.' : 'The visual flow could not be rendered.', 10, false, 16, [110, 110, 110]);
      }

      // ── Actors — the registry ─────────────────────────────────────────────
      doc.addPage();
      y = M;
      line('Actors', 14, true, 18);
      if (report.actors.length === 0) {
        line('No actors registered.', 10, false, 14, [110, 110, 110]);
      } else {
        for (const a of report.actors) {
          space(2);
          line(`${a.name} · ${a.category}${a.external ? '  (external)' : ''}`, 11, true, 15);
          if (a.description) line(a.description, 10, false, 14, [60, 60, 60]);
        }
      }

      // ── Steps — in order ──────────────────────────────────────────────────
      space(10);
      line('Steps', 14, true, 18);
      report.steps.forEach((s, i) => {
        if (i > 0) space(6);
        line(`${s.seq}. ${s.title}`, 12, true, 16);
        line(`Actor: ${s.actor} (${s.category})`, 9.5, false, 13, [90, 90, 90]);
        if (s.inputs.length > 0) line(`Inputs: ${s.inputs.join(', ')}`, 9.5, false, 13);
        if (s.outputs.length > 0) line(`Outputs: ${s.outputs.join(', ')}`, 9.5, false, 13);
        for (const r of s.rules) line(`Rule${r.hard ? ' (hard)' : ''}: ${r.text}`, 9.5, false, 13, r.hard ? [150, 40, 40] : [90, 90, 90]);
        if (s.tacit) line(`Know-how: ${s.tacit}`, 9.5, false, 13, [120, 90, 20]);
      });

      // ── Workflow rules + Handover / gaps summary ──────────────────────────
      if (report.workflowRules.length > 0) {
        space(10);
        line('Workflow rules', 14, true, 18);
        for (const r of report.workflowRules) line(`•  ${r.text}${r.hard ? ' (hard)' : ''}`, 10, false, 14);
      }
      if (report.gaps.length > 0) {
        space(10);
        line('Handover / gaps', 14, true, 18);
        line(`${report.gaps.length} step link${report.gaps.length === 1 ? '' : 's'} reference an entity that does not exist yet:`, 10, false, 15, [110, 110, 110]);
        for (const g of report.gaps) line(`•  ${g.step} — ${g.kind}: ${g.ref}`, 9.5, false, 13, [150, 40, 40]);
      }

      doc.save(workflowPdfFilename(report.title));
    } catch (e) {
      setPdfErr(`Could not export the PDF: ${(e as Error).message}`);
    } finally {
      setPdfBusy(false);
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
      if (d.requested) {
        setPubMsg(action === 'certify'
          ? 'Certification requested — a platform admin will review it.'
          : 'Promotion requested — a domain builder will review it.');
        return;
      }
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
    <ConfirmProvider>
      <PageHeader title="Knowledge" crumb={data.title} tutorial="knowledge" />
      <div className="content">
        {/* Header */}
        <div className="k-detail-head">
          <button className="btn ghost sm" onClick={onBack}>← Workflows</button>
          <h2 className="k-detail-title">{data.title}</h2>
          <span className={`badge ${VIS_CLASS[data.visibility] ?? 'muted'}`}>{VIS_LABEL[data.visibility] ?? data.visibility}</span>
          {/* Source-domain provenance — shown only in Shared/Marketplace tiers. */}
          {(data.visibility === 'Shared' || data.visibility === 'Marketplace') && (
            <DomainTag domain={data.domain} />
          )}
          <span className={`badge ${data.status === 'live' ? 'ok' : 'muted'}`}>{data.status === 'live' ? 'Live' : 'Draft'}</span>
          {data.gaps.length > 0 && (
            <span className="badge err" title="Some step links reference a missing entity">
              ⚠ {data.gaps.length} gap{data.gaps.length === 1 ? '' : 's'}
            </span>
          )}
          {acting ? <span className="spin" title="saving…" /> : null}
          {data.publishedBy && <span className="muted" style={{ fontSize: 12 }}>published by {data.publishedBy}</span>}

          {/* Export PDF — top-right of the workflow detail. Leads with the visual
              flow (swimlane) on page 1, then the full content below. */}
          <button
            className="btn ghost sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => void exportPdf()}
            disabled={pdfBusy}
            title="Export this workflow as a PDF — the visual flow first, then all content"
          >
            {pdfBusy ? <span className="spin" /> : 'Export PDF'}
          </button>

          {data.canPublish && data.status === 'draft' && (
            <button className="btn sm" onClick={() => void publish('publish')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Publish'}
            </button>
          )}
          {data.canPublish && data.status === 'live' && data.visibility === 'Shared' && (
            <button className="btn ghost sm" onClick={() => void publish('certify')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Certify to Marketplace'}
            </button>
          )}
          {/* Creator (can edit, cannot publish) files a governed promotion request
              — docs-first; a domain builder approves it. */}
          {!data.canPublish && data.canEdit && data.status === 'draft' && (
            <button className="btn ghost sm" onClick={() => void publish('publish')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Request promotion'}
            </button>
          )}
          {/* Live & Shared but not a publisher → file a certification request for a
              platform admin (the Marketplace rung of the ladder — creators can ask). */}
          {!data.canPublish && data.canEdit && data.status === 'live' && data.visibility === 'Shared' && (
            <button className="btn ghost sm" onClick={() => void publish('certify')} disabled={publishing}>
              {publishing ? <span className="spin" /> : 'Request certification'}
            </button>
          )}
        </div>

        {/* Lifecycle lives in the opened detail (OS-wide rule): live → Archive + Version;
            archived → Restore + Delete + Version. `data.archived` carries the real state. */}
        <div style={{ marginBottom: 12 }}>
          <LifecycleActions
            id={data.id}
            name={data.title}
            kind="knowledge"
            visibility={data.visibility === 'Shared' ? 'shared' : data.visibility === 'Marketplace' ? 'certified' : 'personal'}
            archived={!!data.archived}
            api={`/api/knowledge/workflows/${workflowId}`}
            onChanged={onBack}
            compact
          />
        </div>

        {pubMsg && <div className="hint" style={{ marginBottom: 10, color: 'var(--teal)' }}>{pubMsg}</div>}
        {pubError && <div className="error" style={{ marginBottom: 10 }}>{pubError}</div>}
        {actErr && <div className="error" style={{ marginBottom: 10 }}>{actErr}</div>}
        {pdfErr && <div className="error" style={{ marginBottom: 10 }}>{pdfErr}</div>}

        {/* Surface tabs */}
        <div className="tabstrip">
          <button className={panel === 'visual' ? 'active' : ''} onClick={() => setPanel('visual')}>Visual flow</button>
          <button className={panel === 'actors' ? 'active' : ''} onClick={() => setPanel('actors')}>
            Actors {wf.actors.length > 0 && <span className="badge muted" style={{ marginLeft: 6, fontSize: 10 }}>{wf.actors.length}</span>}
          </button>
          <button className={panel === 'rules' ? 'active' : ''} onClick={() => setPanel('rules')}>Rules</button>
          <button className={panel === 'tacit' ? 'active' : ''} onClick={() => setPanel('tacit')}>Tacit</button>
          <button className={panel === 'handover' ? 'active' : ''} onClick={() => setPanel('handover')}>Handover</button>
          <button className={panel === 'markdown' ? 'active' : ''} onClick={() => setPanel('markdown')}>Markdown</button>
          <button className={panel === 'mermaid' ? 'active' : ''} onClick={() => setPanel('mermaid')}>Diagram (read-only)</button>
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

          {/* ── ACTORS (the workflow's first-class actor registry) ── */}
          {panel === 'actors' && (
            <ActorsPanel
              workflow={wf}
              canEdit={data.canEdit}
              mutate={(next) => void mutate(next)}
            />
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
    </ConfirmProvider>
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
