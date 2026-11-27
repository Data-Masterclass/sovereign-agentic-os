/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@core/ui/PageHeader';
import SwimlaneCanvas from '@tabs/knowledge/ui/SwimlaneCanvas';
import MermaidPreview from '@tabs/knowledge/ui/MermaidPreview';
import StepInspector from '@tabs/knowledge/ui/StepInspector';
import ActorsPanel from '@tabs/knowledge/ui/ActorsPanel';
import ActorInspector from '@tabs/knowledge/ui/ActorInspector';
import RulesPanel from '@tabs/knowledge/ui/RulesPanel';
import TacitPanel from '@tabs/knowledge/ui/TacitPanel';
import DataMetricsPanel from '@tabs/knowledge/ui/DataMetricsPanel';
import HandoverPanel from '@tabs/knowledge/ui/HandoverPanel';
import { commitWorkflow } from '@tabs/knowledge/ui/commitWorkflow';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@core/ui/lifecycle/ConfirmDialog';
import { useApprovalNotifier } from '@core/ui/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@core/policy/approval-notice';
import DomainTag from '@core/ui/DomainTag';
import { FolderPickerModal } from '@core/ui/core/FolderTree';
import { useFolders } from '@core/folders/useFolders';
import { usePublishPageContext } from '@core/ui/core/PageContext';
import { addStep } from '@tabs/knowledge/lib/step-edit';
import { createCommitQueue, type CommitOutcome, type CommitQueue } from '@tabs/knowledge/lib/commit-queue';
import type { WorkflowReducer } from '@tabs/knowledge/lib/workflow-commit';
import {
  requestNavigation,
  resolveNavigation,
  editorDirty,
  type EditorIntent,
  type GuardChoice,
} from '@tabs/knowledge/lib/editor-guard';
import { actorWarnings, findActorById } from '@tabs/knowledge/lib/actor-registry';
import { buildWorkflowReport, workflowPdfFilename } from '@tabs/knowledge/lib/workflow-pdf';
import { renderSwimlaneSvg } from '@tabs/knowledge/lib/swimlane-svg';
import type { Workflow, ActorType } from '@tabs/knowledge/lib/schema';
import type { WorkflowLinks } from '@tabs/knowledge/lib/links';
import type { Gap } from '@tabs/knowledge/lib/gaps';
import { useTranslations, useServerMessage } from '@core/i18n/client';
import { useActorLabels } from '@tabs/knowledge/ui/useActorLabels';

/**
 * The workflow editor — the tri-directional surface over ONE source (`workflow.md`):
 *   • the visual swimlane (SwimlaneCanvas + StepInspector) — EDITABLE
 *   • the markdown (Monaco panel)                          — EDITABLE
 *   • the Mermaid diagram (MermaidPreview)                 — DERIVED, read-only
 * Each canvas edit builds its diff from the freshly-reloaded source and commits through
 * the same sha-checked PATCH the markdown panel uses, so all three stay in sync. Commits
 * go through ONE `createCommitQueue` (lib/commit-queue.ts): serial — each re-reads the sha
 * — and never dropped, which is what the old drop-if-busy guard did to an edit made while
 * the previous commit was still in flight.
 *
 * Missing-entity links are surfaced as gap flags with a jump-to-build; a step naming an
 * actor the registry does not hold is an actor warning shown in the inspector.
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
  /** Folder path within its tier's tree; server defaults to '/'. */
  folder?: string;
  md: string;
  tacit: string;
  sha: string;
  workflow: Workflow;
  gaps: Gap[];
  /** Data & Metrics links (governed dataset + metric ids); server defaults to empty. */
  links: WorkflowLinks;
  canEdit: boolean;
  canPublish: boolean;
};

type Panel = 'visual' | 'actors' | 'rules' | 'tacit' | 'links' | 'handover' | 'markdown' | 'mermaid' | 'gaps';

const VIS_CLASS: Record<string, string> = {
  Personal: 'vis-personal',
  Shared: 'vis-shared',
  Marketplace: 'vis-certified',
};
// Display labels from the OS-wide scope vocabulary (lib/core/scopes.ts):
// Shared→Domain, Marketplace→Company. Keys stay the persisted visibility values;
// the label is the `knowledge.scope.*` message.
const VIS_KEY = { Personal: 'my', Shared: 'domain', Marketplace: 'company' } as const;

const ACTORS: ActorType[] = ['Human', 'Software', 'Agent'];

export default function WorkflowView({
  workflowId,
  onBack,
}: {
  workflowId: string;
  onBack: () => void;
}) {
  const { notifyApprovalFiled } = useApprovalNotifier();
  const t = useTranslations('knowledge');
  const msg = useServerMessage();
  const { category, linkType } = useActorLabels();
  const [data, setData] = useState<WorkflowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel>('visual');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedActor, setSelectedActor] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actErr, setActErr] = useState('');
  // An unsaved-changes prompt: which move is waiting for the user's answer.
  const [pendingNav, setPendingNav] = useState<EditorIntent | null>(null);
  // The open inspector's draft state, reported up so every exit is guarded.
  const dirtyRef = useRef(false);
  const saveDraftRef = useRef<(() => Promise<boolean>) | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // ONE queue for the whole editor: commits run in order and none is dropped. Lazily
  // created — a `useRef(createCommitQueue(…))` builds (and throws away) a queue on every
  // render. After unmount there is no tree to tell, so a late failure is logged instead.
  const queueRef = useRef<CommitQueue | null>(null);
  const queue = useCallback((): CommitQueue => {
    if (!queueRef.current) {
      queueRef.current = createCommitQueue({
        onError: (m) => {
          if (mountedRef.current) setActErr(m);
          else console.error('[knowledge] workflow commit failed after the editor closed:', m);
        },
        onBusyChange: (b) => { if (mountedRef.current) setActing(b); },
      });
    }
    return queueRef.current;
  }, []);

  // New step form
  const [newStepTitle, setNewStepTitle] = useState('');
  const [newStepActor, setNewStepActor] = useState<ActorType>('Human');

  // Publish
  const [publishing, setPublishing] = useState(false);
  const [pubMsg, setPubMsg] = useState('');
  const [pubError, setPubError] = useState('');

  // Markdown buffer (Monaco-free fallback; a plain editor keeps the bundle light).
  // It is an EXIT like any other: its buffer feeds the same unsaved-changes guard, and a
  // reload triggered by a queued canvas commit must not overwrite it mid-typing.
  const [mdDraft, setMdDraft] = useState('');
  const [mdSaving, setMdSaving] = useState(false);
  const [mdMsg, setMdMsg] = useState('');
  const mdDraftRef = useRef('');
  const mdBaseRef = useRef('');
  const mdDirtyRef = useRef(false);
  const saveMarkdownRef = useRef<() => Promise<boolean>>(async () => true);
  mdDraftRef.current = mdDraft;
  mdDirtyRef.current = mdDraft !== mdBaseRef.current;

  // Export PDF (client-side jsPDF — same stack as the Agents run report).
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState('');
  // Export as OKF bundle (server-side zip download — the portable interchange format).
  const [okfBusy, setOkfBusy] = useState(false);
  // Inline rename of the workflow title (edit-gated; server re-checks canManageArtifact).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');
  // Move-to-folder affordance (edit-gated; server re-checks canManageArtifact).
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderErr, setFolderErr] = useState('');
  const { personalNodes, domainNodes, loadFolders } = useFolders('workflows', false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(msg(body, t('view.loadFailed'))); return null; }
      const next = body as WorkflowData;
      setData(next);
      // Never clobber an unsaved Markdown buffer: a queued canvas commit reloads while the
      // user may be typing here. A clean buffer re-seeds from the new source; a dirty one is
      // left alone and the panel says the file moved underneath it.
      if (mdDraftRef.current === mdBaseRef.current) {
        setMdDraft(next.md);
        mdBaseRef.current = next.md;
      }
      setError('');
      return body as WorkflowData;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [workflowId, t]);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => setLoading(false));
  }, [reload]);

  // Ground "Ask the OS" on the open workflow (its id + title + which panel/view is
  // active), so "add a step" / "fix this rule" act on THIS workflow. Clears on unmount.
  usePublishPageContext({
    tab: 'knowledge',
    stage: `workflow:${panel}`,
    artifactType: 'workflow',
    artifactId: workflowId,
    artifactName: data?.title,
  });

  // The one-source commit: serialize the next Workflow, PATCH with the sha, then reload
  // so the swimlane / markdown / mermaid all reflect the new source.
  //
  // QUEUED, never dropped. This used to `return` when a previous commit+reload was still
  // in flight, so an edit followed by a click was lost in silence. The queue runs commits
  // one at a time (each re-reads the sha, so overlapping them would 409), reports every
  // failure, and hands the outcome back to the caller — which is how an inspector can keep
  // its draft and show the error on the field the user was typing in.
  const mutate = useCallback(
    async (reduce: WorkflowReducer): Promise<CommitOutcome> =>
      queue().enqueue(async () => {
        setActErr(''); // the banner belongs to the commit in flight, not to an older failure
        await commitWorkflow(workflowId, reduce, { readFailed: t('view.readFailed'), saveFailed: t('view.saveFailed'), render: msg });
        await reload();
      }),
    [workflowId, reload, queue, t],
  );

  // --- the unsaved-changes guard --------------------------------------------
  // Every exit from an inspector goes through `navigate`: another step, the same step
  // again (deselect), another actor, another panel. The inspectors only report their
  // draft state; the prompt and the moves live here, because this component owns
  // `selectedStep` / `selectedActor` / `panel`.
  const onDirtyChange = useCallback((state: { dirty: boolean; save: () => Promise<boolean> }) => {
    dirtyRef.current = state.dirty;
    saveDraftRef.current = state.dirty ? state.save : null;
  }, []);

  // "Open this step" from the actor inspector: the step rides along with the panel move,
  // so the jump still works when the guard delays the move until the user has answered.
  const stepJumpRef = useRef<string | null>(null);
  const setPendingStepJump = useCallback((stepId: string) => { stepJumpRef.current = stepId; }, []);

  const applyIntent = useCallback((intent: EditorIntent) => {
    dirtyRef.current = false;
    saveDraftRef.current = null;
    if (intent.kind === 'step') { stepJumpRef.current = null; setSelectedStep(intent.stepId); return; }
    if (intent.kind === 'actor') { stepJumpRef.current = null; setSelectedActor(intent.actorId); return; }
    setPanel(intent.panel as Panel);
    if (intent.panel === 'visual' && stepJumpRef.current) {
      setSelectedStep(stepJumpRef.current);
      stepJumpRef.current = null;
    }
  }, []);

  const navigate = useCallback((intent: EditorIntent) => {
    const dirty = editorDirty({
      inspector: dirtyRef.current,
      markdown: mdDirtyRef.current,
    });
    const req = requestNavigation(dirty, intent);
    if (req.action === 'navigate') applyIntent(intent);
    else setPendingNav(intent);
  }, [applyIntent]);

  /** Throw away the Markdown buffer (the inspectors' drafts die with their remount). */
  const discardDrafts = useCallback(() => {
    setMdDraft(mdBaseRef.current);
    setMdMsg('');
  }, []);

  const answerGuard = useCallback(async (choice: GuardChoice) => {
    const res = resolveNavigation(choice, pendingNav);
    setPendingNav(null);
    if (res.action === 'stay') return;
    if (res.saveFirst) {
      // Save whichever editor holds the draft: an open inspector, or the Markdown buffer.
      const saveInspector = saveDraftRef.current;
      if (saveInspector && !(await saveInspector())) return; // keep the draft + its error
      if (mdDirtyRef.current && !(await saveMarkdownRef.current())) return;
    } else {
      discardDrafts();
    }
    applyIntent(res.intent);
  }, [pendingNav, applyIntent, discardDrafts]);

  /** Commit the Markdown buffer. Returns whether it landed, so the guard can wait on it. */
  async function saveMarkdown(): Promise<boolean> {
    if (mdSaving || !data) return false;
    setMdSaving(true);
    setMdMsg('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md: mdDraft, sha: data.sha }),
      });
      const body = await res.json();
      if (!res.ok) { setMdMsg(`✗ ${msg(body, t('view.saveFailed'))}`); return false; }
      setMdMsg(t('view.md.committed'));
      // The buffer is now the source: clear the baseline so `reload` re-seeds it.
      mdBaseRef.current = mdDraft;
      await reload();
      return true;
    } catch (e) {
      setMdMsg(`✗ ${(e as Error).message}`);
      return false;
    } finally {
      setMdSaving(false);
    }
  }
  saveMarkdownRef.current = saveMarkdown;

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

      // Resolve the linked Data & Metrics ids to display names — fail-soft: if a
      // lookup fails, the raw ids still print so the section never breaks the export.
      let linked = { datasets: data.links.datasets, metrics: data.links.metrics };
      if (linked.datasets.length > 0 || linked.metrics.length > 0) {
        try {
          const flat = (g: { mine?: { id: string; name: string }[]; domain?: { id: string; name: string }[]; marketplace?: { id: string; name: string }[] }) =>
            new Map([...(g.mine ?? []), ...(g.domain ?? []), ...(g.marketplace ?? [])].map((x) => [x.id, x.name]));
          const [dsRes, mRes] = await Promise.all([
            fetch('/api/data/datasets', { cache: 'no-store' }),
            fetch('/api/metrics', { cache: 'no-store' }),
          ]);
          const dsNames = dsRes.ok ? flat(await dsRes.json()) : new Map<string, string>();
          const mNames = mRes.ok ? flat(await mRes.json()) : new Map<string, string>();
          linked = {
            datasets: linked.datasets.map((id) => dsNames.get(id) ?? id),
            metrics: linked.metrics.map((id) => mNames.get(id) ?? id),
          };
        } catch { /* keep the raw ids */ }
      }

      const report = buildWorkflowReport(wf, data.gaps, linked);

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

      // ── Business rules + Data & Metrics + Handover / gaps summary ─────────
      if (report.workflowRules.length > 0) {
        space(10);
        line('Business rules', 14, true, 18);
        for (const r of report.workflowRules) line(`•  ${r.text}${r.hard ? ' (hard)' : ''}`, 10, false, 14);
      }
      if (report.linked.datasets.length > 0 || report.linked.metrics.length > 0) {
        space(10);
        line('Data & Metrics', 14, true, 18);
        for (const n of report.linked.datasets) line(`•  Dataset: ${n}`, 10, false, 14);
        for (const n of report.linked.metrics) line(`•  Metric: ${n}`, 10, false, 14);
      }
      if (report.gaps.length > 0) {
        space(10);
        line('Handover / gaps', 14, true, 18);
        line(`${report.gaps.length} step link${report.gaps.length === 1 ? '' : 's'} reference an entity that does not exist yet:`, 10, false, 15, [110, 110, 110]);
        for (const g of report.gaps) line(`•  ${g.step} — ${g.kind}: ${g.ref}`, 9.5, false, 13, [150, 40, 40]);
      }

      doc.save(workflowPdfFilename(report.title));
    } catch (e) {
      setPdfErr(t('view.pdfFailed', { error: (e as Error).message }));
    } finally {
      setPdfBusy(false);
    }
  }

  /** Export this process as an OKF v0.2 bundle (server-side zip) and download it. */
  async function exportOkf() {
    if (!data || okfBusy) return;
    setOkfBusy(true);
    setPdfErr('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}/okf`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(msg(body, t('view.exportFailed', { status: res.status })));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(data.title || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.okf.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setPdfErr(t('view.okfFailed', { error: (e as Error).message }));
    } finally {
      setOkfBusy(false);
    }
  }

  async function rename() {
    const title = nameDraft.trim();
    setRenameErr('');
    if (!title) { setRenaming(false); return; }
    const res = await fetch(`/api/knowledge/workflows/${workflowId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', title }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(msg(d, t('view.renameFailed'))); return; }
    setRenaming(false);
    await reload();
  }

  async function moveToFolder(folder: string) {
    setFolderErr('');
    const res = await fetch(`/api/knowledge/workflows/${workflowId}/folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setFolderErr(msg(d, t('view.moveFailed'))); return; }
    setFolderPickerOpen(false);
    await reload();
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
      // A bare res.json() on a 502 or an HTML error page REJECTS, and this function had no
      // catch — so a real failure showed no message at all and the button simply re-enabled.
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) { setPubError(msg(d, t('view.publishFailed', { status: res.status }))); return; }
      if (d.requested) {
        setPubMsg(action === 'certify'
          ? t('view.certRequested')
          : t('view.promoRequested'));
        // ONE OS-wide "this needs approval" confirmation (Policies link + inline approve).
        const approval = d.approval as FiledApproval | undefined;
        if (approval?.id) notifyApprovalFiled(approval, 'workflow', () => { void reload(); });
        // Re-read even on the request path: the pending request is part of this page's state,
        // and returning without it left the view looking exactly as it did before the click.
        await reload();
        return;
      }
      // INDEXING IS PART OF THE OUTCOME. The route reports `indexing: { ok: false, code }`
      // when the embed/index pipeline was refused (no scoped key, the alias off the
      // allowlist, a budget cap). The flip succeeded, but the published process is NOT
      // retrievable by any agent until it is indexed — reporting only "now live" would be a
      // success message over a knowledge base nobody can search.
      const indexing = d.indexing as { ok?: boolean; code?: string; error?: string } | undefined;
      const live = d.visibility === 'Marketplace' ? t('view.nowCertified') : t('view.nowLive');
      setPubMsg(live);
      if (indexing && indexing.ok === false) {
        setPubError(t('view.notIndexed', {
          code: indexing.code ?? 'index_failed',
          error: indexing.error ?? t('view.indexRefused'),
        }));
      }
      await reload();
    } catch (e) {
      setPubError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return (
    <>
      <PageHeader title={t('view.pageTitle')} crumb={t('view.crumb')} />
      <div className="content">
        <button className="btn ghost sm" onClick={onBack}>{t('view.back')}</button>
        <div className="stub-page" style={{ marginTop: 16 }}><span className="spin" /> {t('view.loading')}</div>
      </div>
    </>
  );

  if (error || !data) return (
    <>
      <PageHeader title={t('view.pageTitle')} crumb={t('view.crumb')} />
      <div className="content">
        <button className="btn ghost sm" onClick={onBack}>{t('view.back')}</button>
        <div className="error" style={{ marginTop: 16 }}>{error || t('view.notFound')}</div>
      </div>
    </>
  );

  const wf = data.workflow;
  const step = selectedStep ? wf.steps.find((s) => s.id === selectedStep) ?? null : null;
  const actor = selectedActor ? findActorById(wf, selectedActor) ?? null : null;
  // A step naming an actor the registry does not hold is a warning, never a re-added actor.
  const warnings = actorWarnings(wf);
  // The Markdown buffer's own dirtiness, against the source it was seeded from (NOT the
  // latest reload — a queued canvas commit may have moved the file underneath it).
  const mdDirty = mdDirtyRef.current;
  const mdBehind = mdDirty && mdBaseRef.current !== data.md;

  return (
    <ConfirmProvider>
      <PageHeader title={t('view.pageTitle')} crumb={data.title} />
      <div className="content">
        {/* Header */}
        <div className="k-detail-head">
          <button className="btn ghost sm" onClick={onBack}>{t('view.back')}</button>
          {renaming ? (
            <span className="rename-inline">
              <input
                className="rename-input"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }}
                aria-label={t('view.titleAria')}
              />
              <button className="btn primary sm" onClick={() => void rename()}>{t('editor.save')}</button>
              <button className="btn ghost sm" onClick={() => setRenaming(false)}>{t('editor.cancel')}</button>
            </span>
          ) : (
            <h2 className="k-detail-title">
              {data.title}
              {data.canEdit ? (
                <button
                  className="rename-pencil"
                  onClick={() => { setNameDraft(data.title); setRenameErr(''); setRenaming(true); }}
                  title={t('view.renameTitle')}
                  aria-label={t('view.renameTitle')}
                >✎</button>
              ) : null}
            </h2>
          )}
          <span className={`badge ${VIS_CLASS[data.visibility] ?? 'muted'}`}>{data.visibility in VIS_KEY ? t(`scope.${VIS_KEY[data.visibility as keyof typeof VIS_KEY]}`) : data.visibility}</span>
          {/* Source-domain provenance — shown only in Shared/Marketplace tiers. */}
          {(data.visibility === 'Shared' || data.visibility === 'Marketplace') && (
            <DomainTag domain={data.domain} />
          )}
          <span className={`badge ${data.status === 'live' ? 'ok' : 'muted'}`}>{data.status === 'live' ? t('status.live') : t('status.draft')}</span>
          {data.gaps.length > 0 && (
            <span className="badge err" title={t('view.gapsTitle')}>
              {t('view.gapsBadge', { count: data.gaps.length })}
            </span>
          )}
          {acting ? <span className="spin" title={t('view.saving')} /> : null}
          {data.publishedBy && <span className="muted" style={{ fontSize: 12 }}>{t('tile.publishedBy', { name: data.publishedBy })}</span>}
          <span className="mono muted" style={{ fontSize: 11 }} title={t('view.idTitle')}>{data.id}</span>
          {renameErr && <span className="badge err" style={{ fontSize: 11 }}>{renameErr}</span>}

          {folderErr && <span className="badge err" style={{ fontSize: 11 }}>{folderErr}</span>}

          {/* Move to folder — edit-gated; opens the shared folder picker for this tab.
              Roots follow the tier: a My (Personal) process folders in the personal tree,
              a Domain/Company process in the domain tree. */}
          {data.canEdit ? (
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => { setFolderErr(''); void loadFolders(); setFolderPickerOpen(true); }}
              title={t('view.moveFolderTitle')}
            >
              {data.folder && data.folder !== '/' ? t('view.folder', { folder: data.folder }) : t('view.moveToFolder')}
            </button>
          ) : null}

          {/* Export PDF — top-right of the workflow detail. Leads with the visual
              flow (swimlane) on page 1, then the full content below. */}
          <button
            className="btn ghost sm"
            style={{ marginLeft: data.canEdit ? undefined : 'auto' }}
            onClick={() => void exportPdf()}
            disabled={pdfBusy}
            title={t('view.exportPdfTitle')}
          >
            {pdfBusy ? <span className="spin" /> : t('view.exportPdf')}
          </button>

          {/* Export as OKF — the portable interchange bundle (markdown + YAML
              frontmatter, zipped). Round-trips losslessly back into any OKF consumer. */}
          <button
            className="btn ghost sm"
            onClick={() => void exportOkf()}
            disabled={okfBusy}
            title={t('view.exportOkfTitle')}
          >
            {okfBusy ? <span className="spin" /> : t('view.exportOkf')}
          </button>

          {data.canPublish && data.status === 'draft' && (
            <button className="btn sm" onClick={() => void publish('publish')} disabled={publishing}>
              {publishing ? <span className="spin" /> : t('view.publish')}
            </button>
          )}
          {data.canPublish && data.status === 'live' && data.visibility === 'Shared' && (
            <button className="btn ghost sm" onClick={() => void publish('certify')} disabled={publishing}>
              {publishing ? <span className="spin" /> : t('view.certify')}
            </button>
          )}
          {/* Creator (can edit, cannot publish) files a governed promotion request
              — docs-first; a domain builder approves it. */}
          {!data.canPublish && data.canEdit && data.status === 'draft' && (
            <button className="btn ghost sm" onClick={() => void publish('publish')} disabled={publishing}>
              {publishing ? <span className="spin" /> : t('view.requestPromotion')}
            </button>
          )}
          {/* Live & Shared but not a publisher → file a certification request for a
              platform admin (the Marketplace rung of the ladder — creators can ask). */}
          {!data.canPublish && data.canEdit && data.status === 'live' && data.visibility === 'Shared' && (
            <button className="btn ghost sm" onClick={() => void publish('certify')} disabled={publishing}>
              {publishing ? <span className="spin" /> : t('view.requestCertification')}
            </button>
          )}
        </div>

        {/* Folder picker — scoped to this process's tier root (My → personal tree;
            Domain/Company → domain tree), mirroring the Data tab's move modal. */}
        <FolderPickerModal
          open={folderPickerOpen}
          tab="workflows"
          roots={[data.visibility === 'Personal' ? 'personal' : 'domain']}
          personalNodes={data.visibility === 'Personal' ? personalNodes : []}
          domainNodes={data.visibility === 'Personal' ? [] : domainNodes}
          title={t('view.folderPickerTitle')}
          onConfirm={({ path }) => void moveToFolder(path)}
          onCancel={() => setFolderPickerOpen(false)}
          onCreate={async (scope, path) => {
            const res = await fetch('/api/folders', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tab: 'workflows', scope, path }),
            });
            if (!res.ok) { setFolderErr(msg(await res.json(), t('view.folderCreateFailed'))); return; }
            await loadFolders();
          }}
        />

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

        {/* The unsaved-changes guard: one prompt for EVERY way out of an inspector —
            another step, the same step again, another actor, another panel. */}
        {pendingNav && (
          <div className="k-guard">
            <span>{t('view.guard.text')}</span>
            <button className="btn sm" onClick={() => void answerGuard('save')}>{t('view.guard.save')}</button>
            <button className="btn ghost sm" onClick={() => void answerGuard('discard')}>{t('view.guard.discard')}</button>
            <button className="btn ghost sm" onClick={() => void answerGuard('keep')}>{t('view.guard.keep')}</button>
          </div>
        )}
        {pdfErr && <div className="error" style={{ marginBottom: 10 }}>{pdfErr}</div>}

        {/* Surface tabs */}
        <div className="tabstrip">
          <button className={panel === 'visual' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'visual' })}>{t('view.tabs.visual')}</button>
          <button className={panel === 'actors' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'actors' })}>
            {t('view.tabs.actors')} {wf.actors.length > 0 && <span className="badge muted" style={{ marginLeft: 6, fontSize: 10 }}>{wf.actors.length}</span>}
          </button>
          <button className={panel === 'rules' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'rules' })}>{t('view.tabs.rules')}</button>
          <button className={panel === 'tacit' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'tacit' })}>{t('view.tabs.tacit')}</button>
          <button className={panel === 'links' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'links' })}>
            {t('view.tabs.links')} {(data.links.datasets.length + data.links.metrics.length) > 0 && (
              <span className="badge muted" style={{ marginLeft: 6, fontSize: 10 }}>{data.links.datasets.length + data.links.metrics.length}</span>
            )}
          </button>
          <button className={panel === 'handover' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'handover' })}>{t('view.tabs.handover')}</button>
          <button className={panel === 'markdown' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'markdown' })}>{t('view.tabs.markdown')}</button>
          <button className={panel === 'mermaid' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'mermaid' })}>{t('view.tabs.mermaid')}</button>
          <button className={panel === 'gaps' ? 'active' : ''} onClick={() => navigate({ kind: 'panel', panel: 'gaps' })}>
            {t('view.tabs.gaps')} {data.gaps.length > 0 && <span className="badge err" style={{ marginLeft: 6, fontSize: 10 }}>{data.gaps.length}</span>}
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
                onSelectStep={(id) => navigate({ kind: 'step', stepId: selectedStep === id ? null : id })}
              />

              {data.canEdit && (
                <form
                  className="k-add-step"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newStepTitle.trim()) return;
                    void mutate((fresh) => addStep(fresh, { title: newStepTitle.trim(), actor: newStepActor }));
                    setNewStepTitle('');
                  }}
                >
                  <input type="text" value={newStepTitle} onChange={(e) => setNewStepTitle(e.target.value)}
                    placeholder={t('view.newStepPlaceholder')} style={{ flex: 1 }} />
                  <select value={newStepActor} onChange={(e) => setNewStepActor(e.target.value as ActorType)}>
                    {ACTORS.map((a) => <option key={a} value={a}>{category(a)}</option>)}
                  </select>
                  <button className="btn sm" type="submit" disabled={!newStepTitle.trim() || acting}>{t('view.addStep')}</button>
                </form>
              )}

              {step && (
                <StepInspector
                  key={step.id}
                  workflow={wf}
                  step={step}
                  gaps={data.gaps}
                  actorWarning={warnings.find((w) => w.stepId === step.id)}
                  canEdit={data.canEdit}
                  mutate={mutate}
                  onDirtyChange={onDirtyChange}
                  onClose={() => navigate({ kind: 'step', stepId: null })}
                />
              )}
            </>
          )}

          {/* ── MARKDOWN ── */}
          {panel === 'markdown' && (
            <div className="k-md-panel">
              <div className="k-md-head">
                {/* i18n-ignore — the source file's own name, never translated */}
                <span className="mono" style={{ fontSize: 12 }}>workflow.md{mdDirty ? ' •' : ''}</span>
                {/* Your buffer was kept (a commit elsewhere reloaded the file underneath it). */}
                {mdBehind && (
                  <span className="badge warn" style={{ fontSize: 10 }}
                    title={t('view.md.behindTitle')}>
                    {t('view.md.behind')}
                  </span>
                )}
                {data.canEdit ? (
                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    {mdMsg && <span className={mdMsg.startsWith('✓') ? 'hint' : 'error'} style={{ fontSize: 12, margin: 0 }}>{mdMsg}</span>}
                    <button className="btn sm" onClick={() => void saveMarkdown()} disabled={mdSaving || !mdDirty}>
                      {mdSaving ? <span className="spin" /> : mdDirty ? t('view.md.saveCommit') : t('view.md.saved')}
                    </button>
                  </div>
                ) : <span className="badge muted">{t('view.md.readOnly')}</span>}
              </div>
              <textarea
                className="k-md-editor mono"
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                disabled={!data.canEdit}
                spellCheck={false}
                rows={24}
              />
            </div>
          )}

          {/* ── ACTORS (the workflow's first-class actor registry) ── */}
          {panel === 'actors' && (
            <>
              <ActorsPanel
                workflow={wf}
                canEdit={data.canEdit}
                selectedActorId={selectedActor}
                onSelect={(id) => navigate({ kind: 'actor', actorId: selectedActor === id ? null : id })}
                mutate={mutate}
              />
              {actor && (
                <ActorInspector
                  key={actor.id ?? actor.name}
                  workflow={wf}
                  actor={actor}
                  canEdit={data.canEdit}
                  mutate={mutate}
                  onDirtyChange={onDirtyChange}
                  onSelectStep={(stepId) => { setPendingStepJump(stepId); navigate({ kind: 'panel', panel: 'visual' }); }}
                  onClose={() => navigate({ kind: 'actor', actorId: null })}
                />
              )}
            </>
          )}

          {/* ── BUSINESS RULES (workflow-level + guardrail apply) ── */}
          {panel === 'rules' && (
            <RulesPanel
              workflow={wf}
              workflowId={workflowId}
              canEdit={data.canEdit}
              mutate={(next) => void mutate(next)}
            />
          )}

          {/* ── EXPERT KNOWLEDGE (sibling tacit.md — internal name stays `tacit`) ── */}
          {panel === 'tacit' && (
            <TacitPanel
              workflowId={workflowId}
              initialTacit={data.tacit}
              canEdit={data.canEdit}
            />
          )}

          {/* ── DATA & METRICS (linked governed datasets + KPIs) ── */}
          {panel === 'links' && (
            <DataMetricsPanel
              workflowId={workflowId}
              links={data.links}
              canEdit={data.canEdit}
              onChanged={() => void reload()}
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
                <div className="stub-page">{t('view.gaps.none')}</div>
              ) : (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>
                    {t('view.gaps.intro')}
                  </p>
                  {data.gaps.map((g, i) => (
                    <div key={`${g.stepId}-${g.link.type}-${g.link.ref}-${i}`} className="k-gap-row">
                      <span className="badge err">{linkType(g.link.type)}</span>
                      <div className="k-gap-info">
                        <span className="k-gap-step">{g.stepTitle}</span>
                        <span className="k-gap-ref mono">{g.link.label || g.link.ref}</span>
                      </div>
                      <a className="btn ghost sm" href={g.buildHref}>{t('view.gaps.buildIn', { tab: t(`buildTab.${g.buildTab}`) })}</a>
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
.k-guard {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12.5px;
  padding: 10px 12px; margin-bottom: 10px;
  border: 1px solid var(--gold-line); border-radius: 9px; background: var(--gold-soft);
}
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
