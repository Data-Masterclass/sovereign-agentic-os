/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import CodePanel from '@/components/CodePanel';
import AgentChat from '@/components/AgentChat';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import ReviewCard, { type ReviewCardData } from '@/components/ReviewCard';
import ProgressStepper, { type Step, type StepState } from '@/components/core/ProgressStepper';
import DomainTag from '@/components/DomainTag';
import { useToolWindow } from '@/components/ToolWindowProvider';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import { roleAtLeast, type Role as SessionRole } from '@/lib/core/session';
import StageShell from '@/components/core/StageShell';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import StageAssistantChat from '@/components/core/StageAssistantChat';
import SoftwareContextGrants from './SoftwareContextGrants';
import DesignBoard from './DesignBoard';
import type { ViewMode } from '@/lib/core/view-mode';
import {
  contextAccessCap,
  normalizeContextGrants,
  type ContextGrants as ContextGrantsValue,
  type ContextKind,
} from '@/lib/core/context-grants';
import {
  applyPurposeSuggestion,
  applyGrantsSuggestion,
  applyEpicsSuggestion,
  applyStoriesSuggestion,
  type SuggestedGrant,
  type SuggestedEpic,
  type SuggestedStoriesForEpic,
} from '@/lib/software/assistant-suggestions';
import { initialStageState, canEnter, isSatisfied, markDone, type StageState } from '@/lib/core/stages';
import TeamPanel from '@/app/software/TeamPanel';
import StageAssistant from './StageAssistant';
import { SW_STAGES, type SwStageId, type SwCtx } from './stages';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type Tool = { name: string; description: string; write: boolean };
type ChatMsg = { role: 'user' | 'assistant'; content: string; at: string };

/** A Design user story (mirrors lib/software/apps.ts AppStory). */
type Story = { id: string; title: string; asA: string; iWant: string; soThat: string; acceptance: string };
/** A Design epic (mirrors lib/software/apps.ts AppEpic). */
type Epic = {
  id: string;
  title: string;
  description: string;
  requirements: { technical: string; ux: string; governance: string };
  stories: Story[];
};

export type SoftwareApp = {
  id: string;
  slug: string;
  name: string;
  description: string;
  purpose: string;
  epics: Epic[];
  grants: ContextGrantsValue;
  owner: string;
  domain: string;
  visibility: Visibility;
  mode: 'live' | 'offline';
  repo: { fullName: string; htmlUrl: string; seeded: string[] };
  subdomain: string;
  pipeline: Record<string, string>;
  chat: ChatMsg[];
  mcpPrincipal: string;
  mcpTools: Tool[];
  status: 'active' | 'archived';
  deploy: {
    state: 'building' | 'preview' | 'review' | 'live';
    previewUrl: string | null;
    reviewCardId: string | null;
    releases: number;
  };
  manifest: { connections: string[]; data: string[]; knowledge: string[]; hasOpenApi: boolean; missing: string[] };
  surface: { ui: boolean; api: boolean };
  usedAsData: boolean;
};
type Connection = { id: string; name: string; principal: string; visibility: Visibility; tools: Tool[] } | null;

const STAGES = ['forgejo', 'actions', 'harbor', 'argocd', 'live'] as const;
const STAGE_STEP_LABEL: Record<(typeof STAGES)[number], string> = {
  forgejo: 'Scaffold repo',
  actions: 'Build image (CI)',
  harbor: 'Publish to registry',
  argocd: 'Deploy',
  live: 'Live / health',
};

const MODE_KEY = 'software.viewMode';
/** The context kinds the Software Define stage offers. */
const SW_GRANT_KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

function pipelineSteps(pipeline: Record<string, string>): { steps: Step[]; active: boolean; done: boolean; ok: boolean } {
  let firstPendingSeen = false;
  const steps: Step[] = STAGES.map((s) => {
    const status = pipeline[s] ?? 'pending';
    let state: StepState;
    if (status === 'ok' || status === 'disabled') state = 'done';
    else if (status === 'offline') state = 'fail';
    else {
      state = firstPendingSeen ? 'pending' : 'active';
      firstPendingSeen = true;
    }
    return { key: s, label: STAGE_STEP_LABEL[s], state };
  });
  const anyFail = steps.some((st) => st.state === 'fail');
  const anyPending = steps.some((st) => st.state === 'active' || st.state === 'pending');
  const done = anyFail || !anyPending;
  return { steps, active: !done, done, ok: !anyFail };
}

function visBadge(v: Visibility): string {
  return `badge vis-${v.toLowerCase()}`;
}
function visDisplayLabel(v: Visibility): string {
  if (v === 'Shared') return 'Domain';
  if (v === 'Certified') return 'Company';
  return v;
}
function deployBadge(state: SoftwareApp['deploy']['state']): { cls: string; label: string } {
  if (state === 'live') return { cls: 'badge ok', label: 'Live' };
  if (state === 'review') return { cls: 'badge warn', label: 'In review' };
  if (state === 'preview') return { cls: 'badge muted', label: 'Preview' };
  return { cls: 'badge muted', label: 'Draft' };
}
function promoteLabel(v: Visibility): string | null {
  if (v === 'Personal') return 'Promote to Domain';
  if (v === 'Shared') return 'Certify to Company';
  return null;
}


/**
 * The Software guided builder — Define · Design · Build · Preview · Operate on the OS-wide
 * staged primitive (lib/core/stages.ts + components/core/StageShell.tsx), with a Simple ⇄
 * Developer toggle (components/core/BuilderModeToggle). Simple is the five-stage flow;
 * Developer surfaces the REAL raw app files (the in-browser code panel that commits) beside
 * the build/deploy console. Every gate reads the REAL app state handed in (`app.purpose`,
 * `app.epics`, `app.pipeline`, `deploy.state`, `deploy.previewUrl`, `deploy.releases`), so a
 * fresh app opens on Define (never Preview) and walks forward as its real state settles.
 */
export default function SoftwareBuilder({
  app,
  connection,
  user,
  reviewCard,
  onReload,
}: {
  app: SoftwareApp;
  connection: Connection;
  user: { id: string; role: SessionRole };
  reviewCard: ReviewCardData | null;
  onReload: () => void;
}) {
  const { openTool } = useToolWindow();
  const { notifyApprovalFiled } = useApprovalNotifier();

  const [busy, setBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState('');
  const [msg, setMsg] = useState('');
  const [previewAck, setPreviewAck] = useState(false);
  const [toolOut, setToolOut] = useState('');
  const [toolNote, setToolNote] = useState('');
  const [confirmDemote, setConfirmDemote] = useState(false);

  // Simple ⇄ Developer view mode (persisted per user, defaults to Simple).
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(MODE_KEY, m);
  };

  // The build target the Build stage points at (an epic/story from Design).
  const [target, setTarget] = useState<{ epicId: string; storyId: string } | null>(null);

  const canEditCode = roleAtLeast(user.role, 'builder');
  const canEdit = app.owner === user.id || roleAtLeast(user.role, 'domain_admin');

  const surface = app.surface ?? { ui: true, api: true };
  const dep = deployBadge(app.deploy.state);
  const version = app.deploy.releases > 0 ? `v${app.deploy.releases}` : 'Unpublished';
  const canPromoteUI = promoteLabel(app.visibility);
  const canDemoteUI =
    (app.visibility === 'Certified' && user.role === 'admin') ||
    (app.visibility === 'Shared' && roleAtLeast(user.role, 'builder'));
  const demoteLabel = app.visibility === 'Certified' ? 'Revoke from Company' : 'Unshare';
  const confirmDemoteLabel = app.visibility === 'Certified' ? 'Confirm revoke → Domain' : 'Confirm unshare → My';
  const inReview = app.deploy.state === 'review';
  const publishDisabled = busy || inReview;
  const publishLabel = inReview ? 'Awaiting review' : app.deploy.releases > 0 ? 'Publish next release' : 'Publish release';

  // Real app state, defaulted for backward-compat (pre-Define/Design apps).
  const epics = app.epics ?? [];
  const grants = useMemo(() => normalizeContextGrants(app.grants), [app.grants]);

  // The live ctx the stage gates/✓ read — REAL app state, never faked.
  const committed = app.pipeline.forgejo === 'ok' || app.repo.seeded.length > 0;
  const ctx: SwCtx = {
    named: !!app.name.trim(),
    hasPurpose: !!(app.purpose ?? '').trim(),
    hasDesign: epics.some((e) => (e.stories?.length ?? 0) > 0),
    committed,
    previewed: !!app.deploy.previewUrl || previewAck,
    deployed: app.deploy.releases > 0,
    live: app.deploy.state === 'live',
  };

  // Open on the FIRST INCOMPLETE stage that is reachable — a fresh app lands on
  // Define (purpose not set), never Preview. Falls back to the first stage.
  const [stage, setStage] = useState<StageState<SwStageId>>(() => {
    const base = initialStageState(SW_STAGES);
    const firstIncomplete = SW_STAGES.find((s) => canEnter(SW_STAGES, s.id, ctx) && !isSatisfied(SW_STAGES, s.id, ctx));
    return firstIncomplete ? { ...base, current: firstIncomplete.id } : base;
  });

  async function saveDesign(patch: { purpose?: string; epics?: Epic[]; grants?: ContextGrantsValue }): Promise<void> {
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      onReload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function deployAction(action?: 'preview') {
    if (busy) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/deploy${action ? `?action=${action}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error}`);
      else if (action === 'preview') {
        if (body.app?.deploy?.previewUrl) {
          setDeployMsg('✓ Preview running — open the app UI above.');
        } else if (body.runnerNote) {
          // Surface the specific runner outcome so the operator knows whether the
          // pod is provisioning (image build in progress) or failed (RBAC missing,
          // cluster unreachable, etc.) rather than a generic "pending" blurb.
          const isFailure = /rejected|forbidden|403|failed|unreachable/i.test(body.runnerNote as string);
          setDeployMsg(isFailure ? `⚠ Preview provisioning issue: ${body.runnerNote}` : `✓ Preview provisioned — ${body.runnerNote}`);
        } else {
          setDeployMsg('✓ Preview requested — the in-cluster runner is provisioning; the URL appears once the pod is ready (or stays pending if no cluster is reachable).');
        }
      }
      else if (body.kind === 'review') {
        setDeployMsg('✓ Deploy review filed — approve it in Policies & Approvals.');
        const approval = body.approval as FiledApproval | undefined;
        if (approval?.id) notifyApprovalFiled(approval, 'app deploy', onReload);
      } else setDeployMsg('✓ Routine update — published within the approved envelope.');
      onReload();
    } catch (e) {
      setDeployMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/promote`, { method: 'POST' });
      const body = await res.json();
      setMsg(res.ok ? `✓ Promoted to ${visDisplayLabel(body.app.visibility)}.` : `✗ ${body.error}`);
      onReload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function demote() {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/demote`, { method: 'POST' });
      const body = await res.json();
      setMsg(res.ok ? `✓ Revoked → ${visDisplayLabel(body.app.visibility)}.` : `✗ ${body.error}`);
      onReload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function callTool(tool: string) {
    setToolOut('');
    setToolNote('');
    try {
      const res = await fetch(`/api/apps/${app.id}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args: tool.startsWith('add_') ? { name: 'NewCo', amount: 9000 } : {} }),
      });
      const body = await res.json();
      setToolOut(JSON.stringify(body, null, 2));
      const result = body?.result as { source?: string; note?: string } | undefined;
      if (result?.source === 'demo-seed') setToolNote(result.note ?? 'Demo seed data — not from the deployed app.');
    } catch (e) {
      setToolOut((e as Error).message);
    }
  }

  async function lifecycle(action: string) {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else if (body.deleted) {
        window.location.href = '/software';
        return;
      } else setMsg(`✓ ${action} done.`);
      onReload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pipe = useMemo(() => pipelineSteps(app.pipeline), [app.pipeline]);

  return (
    <>
      {/* Persistent header — badges + prominent promote/demote + the view toggle. */}
      <div className="sw-app-head">
        <div className="sw-app-head-meta">
          <span className={visBadge(app.visibility)}>{visDisplayLabel(app.visibility)}</span>
          {(app.visibility === 'Shared' || app.visibility === 'Certified') ? <DomainTag domain={app.domain} /> : null}
          {canPromoteUI &&
          ((app.visibility === 'Personal' && roleAtLeast(user.role, 'builder')) ||
            (app.visibility === 'Shared' && user.role === 'admin')) ? (
            <button className="btn sm" onClick={promote} disabled={busy} title="Promote this app's visibility">
              {busy ? <span className="spin" /> : canPromoteUI}
            </button>
          ) : null}
          <span className={dep.cls}>{dep.label}</span>
          <span className="badge muted">{version}</span>
          {app.mode === 'offline' ? <span className="badge muted">git not ready</span> : null}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <BuilderModeToggle
            mode={viewMode}
            onChange={setModePersisted}
            developerHint="The raw app files + build/deploy console"
          />
          {canEdit ? (
            <LifecycleActions
              id={app.id}
              name={app.name}
              kind="app"
              visibility={app.visibility === 'Shared' ? 'shared' : app.visibility === 'Certified' ? 'certified' : 'personal'}
              archived={app.status === 'archived'}
              handlers={{
                onArchive: () => lifecycle('archive'),
                onRestore: () => lifecycle('unarchive'),
                onDelete: () => lifecycle('delete'),
              }}
              onChanged={onReload}
              showVersions={false}
              compact
            />
          ) : null}
          <Link className="sw-quiet-link" href="/software">All software</Link>
        </div>
      </div>
      {app.description ? <p className="sw-app-lead">{app.description}</p> : null}

      {viewMode === 'developer' ? (
        <DeveloperSurface app={app} canEditCode={canEditCode} deployMsg={deployMsg} toolOut={toolOut} msg={msg} />
      ) : (
        <StageShell
          stages={SW_STAGES}
          state={stage}
          ctx={ctx}
          onState={setStage}
          ariaLabel="Software stages"
          assistant={(st) =>
            // Define + Design own their own StageAssistantChat inside the stage body (so
            // Apply can wire straight into purpose/grants/epics/stories). The other stages
            // keep the one-shot explainer here.
            st.id === 'build' ? (
              <StageAssistant appId={app.id} stage="build" label="Explain a file or what to ask the build chat next." cta="Explain" />
            ) : st.id === 'preview' ? (
              <StageAssistant appId={app.id} stage="preview" label="Read the runner conditions — why isn't the pod ready?" cta="Explain the wait" />
            ) : st.id === 'operate' ? (
              <StageAssistant appId={app.id} stage="operate" label="Explain scan findings, justify go-live, or triage the live app." cta="Help" />
            ) : null
          }
        >
          {stage.current === 'define' ? (
            <DefineStage
              app={app}
              grants={grants}
              canEdit={canEdit}
              onSavePurpose={(purpose) => saveDesign({ purpose })}
              onSaveGrants={(g) => saveDesign({ grants: g })}
            />
          ) : null}

          {stage.current === 'design' ? (
            <DesignStage appId={app.id} epics={epics} canEdit={canEdit} onSave={(next) => saveDesign({ epics: next })} />
          ) : null}

          {stage.current === 'build' ? (
            <BuildStage
              app={app} epics={epics} canEditCode={canEditCode} onBuilt={onReload}
              target={target} setTarget={setTarget}
            />
          ) : null}

          {stage.current === 'preview' ? (
            <PreviewStage
              app={app} surface={surface} pipe={pipe}
              busy={busy} onPreview={() => deployAction('preview')}
              deployMsg={deployMsg}
              offlineAck={previewAck} onOfflineAck={() => { setPreviewAck(true); setStage((s) => markDone(s, 'preview')); }}
              connTools={connection?.tools ?? app.mcpTools}
            />
          ) : null}

          {stage.current === 'operate' ? (
            <OperateStage
              app={app} surface={surface} user={user}
              connTools={connection?.tools ?? app.mcpTools}
              reviewCard={reviewCard}
              publishLabel={publishLabel} publishDisabled={publishDisabled} inReview={inReview}
              onPublish={() => deployAction()} deployMsg={deployMsg}
              toolOut={toolOut} toolNote={toolNote} onCallTool={callTool}
              onOpenRepo={() => app.repo.fullName && openTool('forgejo', `${app.name} · repo`, app.repo.fullName)}
              canPromoteUI={canPromoteUI} onPromote={promote}
              canDemoteUI={canDemoteUI} demoteLabel={demoteLabel} confirmDemoteLabel={confirmDemoteLabel}
              confirmDemote={confirmDemote} setConfirmDemote={setConfirmDemote} onDemote={demote}
              busy={busy} onLifecycle={lifecycle} onReload={onReload} msg={msg}
            />
          ) : null}
        </StageShell>
      )}
    </>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

/**
 * The Developer view — the RAW technical surface. Left: the real in-browser code
 * panel (the app's committed file tree; edits commit to the sovereign repo). Right:
 * the honest build/deploy console (the actual last deploy/tool output + status
 * message). Nothing fabricated — a non-Builder sees the files read-only note from
 * CodePanel and the console; only Builders get the editor.
 */
function DeveloperSurface({
  app, canEditCode, deployMsg, toolOut, msg,
}: {
  app: SoftwareApp;
  canEditCode: boolean;
  deployMsg: string;
  toolOut: string;
  msg: string;
}) {
  const consoleLines = [msg, deployMsg, toolOut].filter(Boolean).join('\n\n');
  return (
    <div style={{ marginTop: 4 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        The raw surface: the app’s committed files (edit + commit in-browser) and the live
        build/deploy console. Everything here is real app state — nothing is simulated.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: 16,
          alignItems: 'start',
          marginTop: 12,
        }}
      >
        {canEditCode ? (
          <CodePanel appId={app.id} repoFullName={app.repo.fullName} />
        ) : (
          <div className="grant-block">
            <div className="comp-label">App files</div>
            <p className="hint" style={{ marginTop: 4 }}>Editing the code is builder-only. Repo: <span className="mono">{app.repo.fullName || '(not scaffolded)'}</span>.</p>
          </div>
        )}
        <div className="grant-block">
          <div className="comp-label">Build / deploy console</div>
          {consoleLines ? (
            <pre className="answer mono" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{consoleLines}</pre>
          ) : (
            <p className="hint" style={{ marginTop: 4 }}>
              No console output yet — run a preview, publish, or call a tool from the Simple flow and the real output appears here.
              Pipeline: <span className="mono">{Object.entries(app.pipeline).map(([k, v]) => `${k}=${v}`).join(', ')}</span>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Define ─────────────────────────── */

function DefineStage({
  app, grants, canEdit, onSavePurpose, onSaveGrants,
}: {
  app: SoftwareApp;
  grants: ContextGrantsValue;
  canEdit: boolean;
  onSavePurpose: (purpose: string) => void;
  onSaveGrants: (grants: ContextGrantsValue) => void;
}) {
  const [purpose, setPurpose] = useState(app.purpose ?? '');
  // When the assistant proposes a purpose, we stage it as a confirmable draft (never a
  // blind write-through): the box adopts the text, marks itself as a pending suggestion,
  // and the user still presses "Save purpose".
  const [suggested, setSuggested] = useState(false);
  useEffect(() => { setPurpose(app.purpose ?? ''); setSuggested(false); }, [app.purpose]);
  const surfaceLabel = [app.surface?.ui ? 'UI' : '', app.surface?.api ? 'API' : ''].filter(Boolean).join(' + ') || 'inferred on build';

  // The context-grant safety ceiling for an app: builders may grant direct writes,
  // everyone else caps at read+propose (writes held for approval).
  const cap = contextAccessCap(canEdit ? 'read-write' : 'read-propose');

  const dirty = purpose !== (app.purpose ?? '');

  // Apply an assistant purpose suggestion → editable draft the user confirms.
  const applyPurpose = (p: string) => {
    setPurpose(applyPurposeSuggestion(p));
    setSuggested(true);
  };
  // Apply assistant grant suggestions → fold into the current grants (clamped to cap) + persist.
  const applyGrants = (sg: SuggestedGrant[]) => onSaveGrants(applyGrantsSuggestion(grants, sg, cap));

  return (
    <div className="agent-editor" style={{ marginTop: 4 }}>
      <label className="comp-label">App name</label>
      <input type="text" value={app.name} readOnly title="Named on create — rename via the delivery team or build chat" />
      <div className="hint" style={{ marginTop: 6 }}>
        id: <code>{app.slug}</code> · surface: <code>{surfaceLabel}</code> ·{' '}
        the build agent infers UI/API from what it actually builds — no upfront type to pick.
      </div>

      <label className="comp-label" style={{ marginTop: 16 }}>Purpose</label>
      <p className="hint" style={{ marginTop: 0 }}>
        What is this app for? One or two sentences in your own words — the Define stage is complete once a purpose is set.
      </p>
      <textarea
        value={purpose}
        onChange={(e) => { setPurpose(e.target.value); setSuggested(false); }}
        readOnly={!canEdit}
        rows={3}
        placeholder="e.g. Give the sales team a live view of overdue invoices with one-click reminders."
        style={{ width: '100%' }}
      />
      {canEdit ? (
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button className="btn" disabled={!dirty} onClick={() => { onSavePurpose(purpose.trim()); setSuggested(false); }}>Save purpose</button>
          {suggested ? <span className="badge">Assistant suggestion — review, then save</span>
            : dirty ? <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span> : null}
        </div>
      ) : null}

      <div className="section-title">Granted context (no raw credentials)</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Apps consume governed resources — OPA-scoped and run AS you, never raw secrets. Grant the
        Connections, Data, Knowledge, Files and Metrics this app may use. Expand a kind to grant at
        folder or item level, at Read / Read+propose / Read+write.
      </p>
      <SoftwareContextGrants
        value={grants}
        onChange={onSaveGrants}
        kinds={SW_GRANT_KINDS}
        cap={cap}
        canEdit={canEdit}
      />

      {/* The real, governed Define assistant — chat + apply-able suggestions. */}
      <StageAssistantChat
        appId={app.id}
        stage="define"
        intro="Improve the purpose and suggest which governed context to grant."
        starters={['Sharpen my purpose', 'What context should this app be granted?']}
        onApplyPurpose={canEdit ? applyPurpose : undefined}
        onApplyGrants={canEdit ? applyGrants : undefined}
      />
    </div>
  );
}

/* ─────────────────────────── Design ─────────────────────────── */

/**
 * The Design stage — the JIRA-like-but-simpler EPIC + user-story board
 * (components/software/DesignBoard.tsx), plus the governed Design assistant chat whose
 * suggestions Apply straight into the epics: `suggestedEpics` CREATE epics,
 * `suggestedStories` ADD stories under existing epics — both persisted through the SAME
 * governed `onSave` (→ patchAppDesign). The board persists the whole array on Save.
 * The assistant only suggests; Apply is the user-confirmed, governed write.
 */
function DesignStage({
  appId, epics, canEdit, onSave,
}: {
  appId: string;
  epics: Epic[];
  canEdit: boolean;
  onSave: (epics: Epic[]) => void;
}) {
  // Apply suggested epics → create them + persist immediately (governed path).
  const applyEpics = (sug: SuggestedEpic[]) => onSave(applyEpicsSuggestion(epics, sug));
  // Apply suggested stories → add under the referenced existing epics + persist.
  const applyStories = (groups: SuggestedStoriesForEpic[]) => onSave(applyStoriesSuggestion(epics, groups));

  return (
    <div style={{ marginTop: 4 }}>
      <DesignBoard epics={epics} canEdit={canEdit} onSave={onSave} />

      <StageAssistantChat
        appId={appId}
        stage="design"
        intro="Propose EPICs and user stories from the purpose — Apply creates them."
        starters={['Suggest EPICs for this app', 'Add user stories to my EPICs']}
        onApplyEpics={canEdit ? applyEpics : undefined}
        onApplyStories={canEdit ? applyStories : undefined}
      />
    </div>
  );
}

/* ─────────────────────────── Build ─────────────────────────── */

function BuildStage({
  app, epics, canEditCode, onBuilt, target, setTarget,
}: {
  app: SoftwareApp;
  epics: Epic[];
  canEditCode: boolean;
  onBuilt: () => void;
  target: { epicId: string; storyId: string } | null;
  setTarget: (t: { epicId: string; storyId: string } | null) => void;
}) {
  const storyOptions = epics.flatMap((e) => e.stories.map((s) => ({ epicId: e.id, storyId: s.id, label: `${e.title || 'Untitled EPIC'} › ${s.title || 'Untitled story'}` })));
  const selectedLabel = target ? storyOptions.find((o) => o.epicId === target.epicId && o.storyId === target.storyId)?.label : null;

  return (
    <div style={{ marginTop: 4 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        Build with the governed delivery team (it asks questions, plans, then commits real
        code), or with the per-app build chat. {canEditCode ? 'Edit the code directly beside it.' : 'A Builder can also edit code directly.'} Every commit lands in this app’s sovereign in-cluster repo.
      </p>

      {/* EPIC/story selector — the build targets a chosen story (threaded into the deploy payload). */}
      <div className="grant-block" style={{ marginTop: 10 }}>
        <div className="comp-label">Build target</div>
        {storyOptions.length === 0 ? (
          <p className="hint" style={{ marginTop: 4 }}>No stories yet — add EPICs and stories on the <strong>Design</strong> stage to target the build.</p>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 4 }}>
            <select
              value={target ? `${target.epicId}::${target.storyId}` : ''}
              onChange={(e) => {
                if (!e.target.value) { setTarget(null); return; }
                const [epicId, storyId] = e.target.value.split('::');
                setTarget({ epicId, storyId });
              }}
              style={{ minWidth: 320 }}
            >
              <option value="">— no specific story —</option>
              {storyOptions.map((o) => (
                <option key={`${o.epicId}::${o.storyId}`} value={`${o.epicId}::${o.storyId}`}>{o.label}</option>
              ))}
            </select>
            {selectedLabel ? <span className="badge">{selectedLabel}</span> : null}
          </div>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <TeamPanel onBuilt={onBuilt} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: canEditCode ? 'repeat(auto-fit, minmax(360px, 1fr))' : '1fr',
          gap: 16,
          alignItems: 'start',
          marginTop: 16,
        }}
      >
        <AgentChat
          agent="software"
          label="build assistant"
          variant="claude"
          endpoint={`/api/apps/${app.id}/chat`}
          initialMessages={app.chat
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content }))}
          placeholder={`Describe what to build or change in ${app.name}…`}
          minHeight={360}
        />
        {canEditCode ? <CodePanel appId={app.id} repoFullName={app.repo.fullName} /> : null}
      </div>
    </div>
  );
}

/* ─────────────────────────── Preview ─────────────────────────── */

function PreviewStage({
  app, surface, pipe, busy, onPreview, deployMsg, offlineAck, onOfflineAck, connTools,
}: {
  app: SoftwareApp;
  surface: { ui: boolean; api: boolean };
  pipe: { steps: Step[]; active: boolean; done: boolean; ok: boolean };
  busy: boolean;
  onPreview: () => void;
  deployMsg: string;
  offlineAck: boolean;
  onOfflineAck: () => void;
  connTools: Tool[];
}) {
  const [showApi, setShowApi] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      <div className="sw-monitor">
        <div className="sw-monitor-main">
          <div className="sw-monitor-status">
            <span className={`sw-dot ${app.deploy.state === 'live' ? 'on' : app.deploy.previewUrl ? 'on' : 'off'}`} aria-hidden="true" />
            <div>
              <div className="sw-monitor-state">{app.deploy.previewUrl ? 'Preview running' : 'Runner pending'}</div>
              <div className="sw-monitor-sub mono">{app.subdomain}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {surface.ui && app.deploy.previewUrl ? (
              <a href={app.deploy.previewUrl} target="_blank" rel="noreferrer" className="btn">Open app UI ↗</a>
            ) : surface.ui ? (
              <span className="muted" style={{ fontSize: 12 }}>App runner pending — provisioning, or no cluster reachable</span>
            ) : null}
            {surface.api ? (
              <button className={surface.ui ? 'btn ghost' : 'btn'} onClick={() => setShowApi((v) => !v)}>
                {showApi ? 'Hide API details' : 'API details'}
              </button>
            ) : null}
            <button className="btn ghost" onClick={onPreview} disabled={busy}>
              {busy ? <span className="spin" /> : app.deploy.previewUrl ? 'Rebuild preview' : 'Provision preview'}
            </button>
          </div>
        </div>

        <div className="sw-health">
          <ProgressStepper
            steps={pipe.steps}
            active={pipe.active}
            done={pipe.done}
            ok={pipe.ok}
            commentary={
              pipe.done
                ? pipe.ok ? 'Build & deploy complete.' : 'A build/deploy stage did not complete — see the marked stage.'
                : 'Building & deploying…'
            }
          />
        </div>

        {surface.api && showApi ? (
          <div className="sw-api">
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              Headless app — its capabilities are exposed as governed MCP tools (principal{' '}
              <span className="mono">{app.mcpPrincipal}</span>). OpenAPI spec:{' '}
              {app.manifest.hasOpenApi ? 'present' : 'not declared yet'}.
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Endpoint / tool</th><th>Kind</th><th>Description</th></tr></thead>
                <tbody>
                  {connTools.map((t) => (
                    <tr key={t.name}>
                      <td className="mono">{t.name}</td>
                      <td><span className={`badge ${t.write ? 'warn' : 'ok'}`}>{t.write ? 'write' : 'read'}</span></td>
                      <td className="muted">{t.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      {deployMsg ? <div className={deployMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 10 }}>{deployMsg}</div> : null}

      {!app.deploy.previewUrl ? (
        <div className="row" style={{ marginTop: 12, gap: 12, alignItems: 'center' }}>
          <span className="hint" style={{ margin: 0 }}>
            No cluster reachable? You can acknowledge preview is unavailable here and still request go-live.
          </span>
          <button className="btn ghost sm" onClick={onOfflineAck} disabled={offlineAck}>
            {offlineAck ? 'Acknowledged ✓' : 'Acknowledge offline'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Operate (merged Publish + Operate) ─────────────────────────── */

function OperateStage({
  app, surface, user, connTools, reviewCard,
  publishLabel, publishDisabled, inReview, onPublish, deployMsg,
  toolOut, toolNote, onCallTool, onOpenRepo,
  canPromoteUI, onPromote, canDemoteUI, demoteLabel, confirmDemoteLabel,
  confirmDemote, setConfirmDemote, onDemote, busy, onLifecycle, onReload, msg,
}: {
  app: SoftwareApp;
  surface: { ui: boolean; api: boolean };
  user: { id: string; role: SessionRole };
  connTools: Tool[];
  reviewCard: ReviewCardData | null;
  publishLabel: string;
  publishDisabled: boolean;
  inReview: boolean;
  onPublish: () => void;
  deployMsg: string;
  toolOut: string;
  toolNote: string;
  onCallTool: (tool: string) => void;
  onOpenRepo: () => void;
  canPromoteUI: string | null;
  onPromote: () => void;
  canDemoteUI: boolean;
  demoteLabel: string;
  confirmDemoteLabel: string;
  confirmDemote: boolean;
  setConfirmDemote: (v: boolean) => void;
  onDemote: () => void;
  busy: boolean;
  onLifecycle: (action: string) => void;
  onReload: () => void;
  msg: string;
}) {
  const version = app.deploy.releases > 0 ? `v${app.deploy.releases}` : 'Unpublished';
  const dep = deployBadge(app.deploy.state);
  const canManage = app.owner === user.id || roleAtLeast(user.role, 'domain_admin');
  return (
    <div style={{ marginTop: 4 }}>
      {/* ── Publish a release (merged from the old Publish stage) ── */}
      <div className="sw-publish">
        <div className="sw-publish-row">
          <div>
            <div className="sw-publish-title">Publish a release</div>
            <div className="hint" style={{ marginTop: 2 }}>
              Going live in the domain is Builder-reviewed: the security scan, the governed
              resources requested, its footprint and the change diff. Routine in-envelope updates ship automatically.
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn lg" onClick={onPublish} disabled={publishDisabled} title={inReview ? 'A deploy is awaiting a Builder in Deploy reviews' : undefined}>
              {publishLabel}
            </button>
          </div>
        </div>
        {app.manifest.missing.length > 0 ? (
          <div className="hint" style={{ marginTop: 8 }}>
            Complete app metadata: <span className="mono">{app.manifest.missing.join(', ')}</span>.
          </div>
        ) : null}
        {deployMsg ? <div className={deployMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 10 }}>{deployMsg}</div> : null}
        <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'center' }}>
          <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews →</Link>
          {app.repo.htmlUrl ? <a className="sw-quiet-link" href={app.repo.htmlUrl} target="_blank" rel="noreferrer">Native ↗</a> : null}
          <span className="muted" style={{ fontSize: 12 }}>{app.deploy.releases > 0 ? `${app.deploy.releases} release${app.deploy.releases === 1 ? '' : 's'} shipped` : 'No releases yet'}</span>
        </div>
      </div>

      {inReview && reviewCard ? (
        <div style={{ marginTop: 16 }}>
          <div className="section-title">In review — what a Builder sees</div>
          <ReviewCard card={reviewCard} canReview={false} />
        </div>
      ) : inReview ? (
        <div className="hint" style={{ marginTop: 16 }}>
          This deploy is awaiting a Builder in <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews</Link>.
        </div>
      ) : null}

      {/* ── Live pod state ── */}
      <div className="sw-monitor" style={{ marginTop: 16 }}>
        <div className="sw-monitor-main">
          <div className="sw-monitor-status">
            <span className={`sw-dot ${app.deploy.state === 'live' ? 'on' : 'off'}`} aria-hidden="true" />
            <div>
              <div className="sw-monitor-state">{dep.label} · {version}</div>
              <div className="sw-monitor-sub mono">{app.subdomain}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {surface.ui && app.deploy.previewUrl ? (
              <a href={app.deploy.previewUrl} target="_blank" rel="noreferrer" className="btn">Open app UI ↗</a>
            ) : null}
            {app.repo.fullName ? <button type="button" className="btn ghost" onClick={onOpenRepo}>Repo →</button> : null}
          </div>
        </div>
      </div>

      {/* ── Governed tool-call surface ── */}
      {surface.api ? (
        <div className="sw-api" style={{ marginTop: 12 }}>
          <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
            The app’s capabilities as governed MCP tools (principal <span className="mono">{app.mcpPrincipal}</span>). Every call runs AS you, OPA-checked and audit-traced.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tool</th><th>Kind</th><th>Description</th><th /></tr></thead>
              <tbody>
                {connTools.map((t) => (
                  <tr key={t.name}>
                    <td className="mono">{t.name}</td>
                    <td><span className={`badge ${t.write ? 'warn' : 'ok'}`}>{t.write ? 'write' : 'read'}</span></td>
                    <td className="muted">{t.description}</td>
                    <td><button className="btn ghost sm" onClick={() => onCallTool(t.name)}>Call</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {toolNote ? <div className="hint" style={{ marginTop: 10 }}>⚠ {toolNote}</div> : null}
          {toolOut ? <pre className="answer mono" style={{ marginTop: 10, fontSize: 12, whiteSpace: 'pre-wrap' }}>{toolOut}</pre> : null}
        </div>
      ) : null}

      {/* ── Promotion + lifecycle ── */}
      <div className="section-title">Promotion ladder</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        My → Domain (Builder/Admin) → Company (Admin only). Cascades to the app&apos;s data, files and MCP connection.
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        {canPromoteUI ? (
          <button className="btn" onClick={onPromote} disabled={busy}>{busy ? <span className="spin" /> : canPromoteUI}</button>
        ) : (
          <span className="badge vis-certified">In Company</span>
        )}
        {canDemoteUI ? (
          confirmDemote ? (
            <>
              <button className="btn sm" onClick={() => { setConfirmDemote(false); onDemote(); }} disabled={busy} style={{ background: 'var(--danger, #b42318)' }}>
                {busy ? <span className="spin" /> : confirmDemoteLabel}
              </button>
              <button className="btn ghost sm" onClick={() => setConfirmDemote(false)} disabled={busy}>Cancel</button>
            </>
          ) : (
            <button className="btn ghost sm" onClick={() => setConfirmDemote(true)} disabled={busy} title="Revoke this app's sharing one rung">
              {demoteLabel}
            </button>
          )
        ) : null}
      </div>

      <div className="section-title">Lifecycle</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn ghost" onClick={() => onLifecycle('use-as-data')} disabled={busy || app.usedAsData}>
          {app.usedAsData ? 'Used as Data ✓' : 'Use as Data'}
        </button>
        <LifecycleActions
          id={app.id}
          name={app.name}
          kind="app"
          visibility={app.visibility === 'Shared' ? 'shared' : app.visibility === 'Certified' ? 'certified' : 'personal'}
          archived={app.status === 'archived'}
          handlers={{
            onArchive: () => onLifecycle('archive'),
            onRestore: () => onLifecycle('unarchive'),
            onDelete: () => onLifecycle('delete'),
          }}
          api={`/api/apps/${app.id}`}
          onChanged={onReload}
          showVersions
        />
        <span className={`badge ${app.status === 'active' ? 'ok' : 'muted'}`}>{app.status}</span>
        {canManage ? null : (
          <span className="muted" style={{ fontSize: 12 }}>Lifecycle is limited to the owner and domain admins.</span>
        )}
      </div>
      {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}
    </div>
  );
}
