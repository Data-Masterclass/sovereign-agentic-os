/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
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
import { initialStageState, markDone, type StageState } from '@/lib/core/stages';
import TeamPanel from '@/app/software/TeamPanel';
import StageAssistant from './StageAssistant';
import { SW_STAGES, type SwStageId, type SwCtx } from './stages';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type Tool = { name: string; description: string; write: boolean };
type ChatMsg = { role: 'user' | 'assistant'; content: string; at: string };
type Consumed = { kind: string; ref: string; label: string; scope: string };
export type SoftwareApp = {
  id: string;
  slug: string;
  name: string;
  description: string;
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
  consumes: Consumed[];
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

/**
 * Map the pipeline's per-stage status (`ok | pending | offline | disabled`) onto the shared
 * <ProgressStepper> states, driven by ACTUAL status — not a timer (the P0-fixed honest
 * mapping, moved verbatim from the old detail page): ok/disabled → done, offline → fail,
 * the first pending → active, the rest pending.
 */
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
 * The Software guided builder — Describe · Build · Preview · Publish · Operate on the OS-wide
 * staged primitive (lib/core/stages.ts + components/core/StageShell.tsx; the Agents
 * SimpleBuilder and Dashboards DashboardBuilder are the reference adoptions). It re-hosts the
 * tab's EXISTING (P0-fixed) bodies — the delivery-team chat, the build chat, the code editor,
 * the honest pipeline stepper, the real security-scan review card, the live tool-call surface
 * and lifecycle — as stage bodies; nothing is rewritten, only re-hosted. Every gate reads the
 * REAL app state handed in (`app.pipeline`, `deploy.state`, `deploy.previewUrl`,
 * `deploy.releases`), so a fresh app walks forward as its real state settles and an existing
 * live app opens straight on Operate.
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
  /** The open deploy-review card for this app (Publish stage), fetched by the page. */
  reviewCard: ReviewCardData | null;
  /** Refetch the app after any mutation (deploy/promote/lifecycle/tool). */
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

  // Granted-resources picker (moved out of the old buried Manage panel).
  const [connRef, setConnRef] = useState('');
  const [connLabel, setConnLabel] = useState('');
  const [connScope, setConnScope] = useState<'read' | 'write-bounded'>('read');

  const surface = app.surface ?? { ui: true, api: true };
  const dep = deployBadge(app.deploy.state);
  const version = app.deploy.releases > 0 ? `v${app.deploy.releases}` : 'Unpublished';
  const canEditCode = roleAtLeast(user.role, 'builder');
  const canPromoteUI = promoteLabel(app.visibility);
  const canDemoteUI =
    (app.visibility === 'Certified' && user.role === 'admin') ||
    (app.visibility === 'Shared' && roleAtLeast(user.role, 'builder'));
  const demoteLabel = app.visibility === 'Certified' ? 'Revoke from Company' : 'Unshare';
  const confirmDemoteLabel = app.visibility === 'Certified' ? 'Confirm revoke → Domain' : 'Confirm unshare → My';
  const inReview = app.deploy.state === 'review';
  const publishDisabled = busy || inReview;
  const publishLabel = inReview ? 'Awaiting review' : app.deploy.releases > 0 ? 'Publish next release' : 'Publish release';

  // The live ctx the stage gates/✓ read — REAL app state, never faked.
  const committed = app.pipeline.forgejo === 'ok' || app.repo.seeded.length > 0;
  const ctx: SwCtx = {
    named: !!app.name.trim(),
    committed,
    previewed: !!app.deploy.previewUrl || previewAck,
    deployed: app.deploy.releases > 0,
    live: app.deploy.state === 'live',
  };

  // Open on the stage matching REAL app state: a live app on Operate, a shipped one on
  // Publish, a built (committed) one on Preview, and a fresh/uncommitted app straight on
  // Build — that's where the delivery team + build chat live, so creation continues
  // seamlessly (Build is reachable the moment the app is named). Describe stays a click back.
  const [stage, setStage] = useState<StageState<SwStageId>>(() => {
    const base = initialStageState(SW_STAGES);
    const start: SwStageId = ctx.live
      ? 'operate'
      : ctx.deployed
        ? 'publish'
        : ctx.committed
          ? 'preview'
          : 'build';
    return { ...base, current: start };
  });

  async function deployAction(action?: 'preview') {
    if (busy) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/deploy${action ? `?action=${action}` : ''}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error}`);
      else if (action === 'preview')
        setDeployMsg(
          body.app?.deploy?.previewUrl
            ? '✓ Preview running — open the app UI above.'
            : '✓ Preview requested — the in-cluster runner is provisioning; the URL appears once the pod is ready (or stays pending if no cluster is reachable).',
        );
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
      // HONESTY (P0): flag demo-seed results — this did NOT come from the deployed app.
      const result = body?.result as { source?: string; note?: string } | undefined;
      if (result?.source === 'demo-seed') setToolNote(result.note ?? 'Demo seed data — not from the deployed app.');
    } catch (e) {
      setToolOut((e as Error).message);
    }
  }

  async function lifecycle(action: string, resource?: unknown) {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, resource }),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else if (body.deleted) {
        window.location.href = '/software';
        return;
      } else setMsg(`✓ ${action} done.`);
      if (action === 'consume') {
        setConnRef('');
        setConnLabel('');
      }
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
      {/* Persistent header — badges + prominent promote/demote, above the guided path. */}
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
          {(app.owner === user.id || roleAtLeast(user.role, 'domain_admin')) ? (
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

      <StageShell
        stages={SW_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Software stages"
        assistant={(st) =>
          st.id === 'describe' ? (
            <StageAssistant
              appId={app.id} stage="describe"
              label="Suggest the app's surface and the first capabilities to build."
              cta="Suggest a plan"
            />
          ) : st.id === 'build' ? (
            <StageAssistant
              appId={app.id} stage="build"
              label="Explain a file or what to ask the build chat next."
              cta="Explain"
            />
          ) : st.id === 'preview' ? (
            <StageAssistant
              appId={app.id} stage="preview"
              label="Read the runner conditions — why isn't the pod ready?"
              cta="Explain the wait"
            />
          ) : st.id === 'publish' ? (
            <StageAssistant
              appId={app.id} stage="publish"
              label="Explain scan findings and propose fixes to hand to the team."
              cta="Explain findings"
            />
          ) : (
            <StageAssistant
              appId={app.id} stage="operate"
              label="Triage a denial, error or unexpected tool result on the live app."
              cta="Triage"
            />
          )
        }
      >
        {/* ─────────── Describe ─────────── */}
        {stage.current === 'describe' ? (
          <DescribeStage
            app={app}
            connection={connection}
            consumes={app.consumes}
            connRef={connRef} setConnRef={setConnRef}
            connLabel={connLabel} setConnLabel={setConnLabel}
            connScope={connScope} setConnScope={setConnScope}
            onGrant={() => lifecycle('consume', { kind: 'connection', ref: connRef.trim(), label: connLabel.trim() || connRef.trim(), scope: connScope })}
            busy={busy}
          />
        ) : null}

        {/* ─────────── Build ─────────── */}
        {stage.current === 'build' ? (
          <BuildStage app={app} canEditCode={canEditCode} onBuilt={onReload} />
        ) : null}

        {/* ─────────── Preview ─────────── */}
        {stage.current === 'preview' ? (
          <PreviewStage
            app={app} surface={surface} pipe={pipe}
            busy={busy} onPreview={() => deployAction('preview')}
            deployMsg={deployMsg}
            offlineAck={previewAck} onOfflineAck={() => { setPreviewAck(true); setStage((s) => markDone(s, 'preview')); }}
            connTools={connection?.tools ?? app.mcpTools}
          />
        ) : null}

        {/* ─────────── Publish ─────────── */}
        {stage.current === 'publish' ? (
          <PublishStage
            app={app} reviewCard={reviewCard}
            publishLabel={publishLabel} publishDisabled={publishDisabled} inReview={inReview}
            onPublish={() => deployAction()} deployMsg={deployMsg}
          />
        ) : null}

        {/* ─────────── Operate ─────────── */}
        {stage.current === 'operate' ? (
          <OperateStage
            app={app} surface={surface} user={user}
            connTools={connection?.tools ?? app.mcpTools}
            toolOut={toolOut} toolNote={toolNote} onCallTool={callTool}
            onOpenRepo={() => app.repo.fullName && openTool('forgejo', `${app.name} · repo`, app.repo.fullName)}
            canPromoteUI={canPromoteUI} onPromote={promote}
            canDemoteUI={canDemoteUI} demoteLabel={demoteLabel} confirmDemoteLabel={confirmDemoteLabel}
            confirmDemote={confirmDemote} setConfirmDemote={setConfirmDemote} onDemote={demote}
            busy={busy} onLifecycle={lifecycle} onReload={onReload} msg={msg}
          />
        ) : null}
      </StageShell>
    </>
  );
}

/* ─────────────────────────── Describe ─────────────────────────── */

function DescribeStage({
  app, connection, consumes,
  connRef, setConnRef, connLabel, setConnLabel, connScope, setConnScope, onGrant, busy,
}: {
  app: SoftwareApp;
  connection: Connection;
  consumes: Consumed[];
  connRef: string; setConnRef: (v: string) => void;
  connLabel: string; setConnLabel: (v: string) => void;
  connScope: 'read' | 'write-bounded'; setConnScope: (v: 'read' | 'write-bounded') => void;
  onGrant: () => void;
  busy: boolean;
}) {
  const surfaceLabel = [app.surface?.ui ? 'UI' : '', app.surface?.api ? 'API' : ''].filter(Boolean).join(' + ') || 'inferred on build';
  return (
    <div className="agent-editor" style={{ marginTop: 4 }}>
      <label className="comp-label">App name</label>
      <input type="text" value={app.name} readOnly title="Named on create — rename via the delivery team or build chat" />
      <div className="hint" style={{ marginTop: 6 }}>
        id: <code>{app.slug}</code> · surface: <code>{surfaceLabel}</code> ·{' '}
        the build agent infers UI/API from what it actually builds — no upfront type to pick.
      </div>

      <label className="comp-label" style={{ marginTop: 16 }}>Brief</label>
      <p className="hint" style={{ marginTop: 0 }}>
        {app.description || 'No brief captured yet — describe the app in the delivery-team chat or build chat on the Build stage; design decisions are captured under the app as it builds.'}
      </p>

      <div className="section-title">Granted resources (no raw credentials)</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Apps consume governed resources, OPA-scoped and run AS you — never raw secrets. Grant a
        connection the app may use; it is enforced server-side.
      </p>
      {consumes.length > 0 ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {consumes.map((c) => (
            <span key={`${c.kind}:${c.ref}`} className="badge muted mono" style={{ fontSize: 11 }}>
              {c.kind}:{c.label} ({c.scope})
            </span>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>None yet.</div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" value={connRef} onChange={(e) => setConnRef(e.target.value)} placeholder="Connection ref (e.g. salesforce)" style={{ flex: 1, minWidth: 160 }} />
        <input type="text" value={connLabel} onChange={(e) => setConnLabel(e.target.value)} placeholder="Label" style={{ flex: 1, minWidth: 120 }} />
        <select value={connScope} onChange={(e) => setConnScope(e.target.value as 'read' | 'write-bounded')}>
          <option value="read">read</option>
          <option value="write-bounded">write-bounded</option>
        </select>
        <button className="btn ghost" disabled={busy || !connRef.trim()} onClick={onGrant}>Grant</button>
      </div>

      {connection ? (
        <p className="hint" style={{ marginTop: 12 }}>
          This app already exposes a governed MCP connection (<span className="mono">{connection.principal}</span>) with {connection.tools.length} tool{connection.tools.length === 1 ? '' : 's'}.
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Build ─────────────────────────── */

function BuildStage({ app, canEditCode, onBuilt }: { app: SoftwareApp; canEditCode: boolean; onBuilt: () => void }) {
  return (
    <div style={{ marginTop: 4 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        Build with the governed delivery team (it asks questions, plans, then commits real
        code), or with the per-app build chat. {canEditCode ? 'Edit the code directly beside it.' : 'A Builder can also edit code directly.'} Every commit lands in this app’s sovereign in-cluster repo.
      </p>

      {/* The delivery-team launcher — now IN the detail build flow, seeded per-app. */}
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

        {/* The honest, status-driven pipeline stepper (P0-preserved). */}
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

/* ─────────────────────────── Publish ─────────────────────────── */

function PublishStage({
  app, reviewCard, publishLabel, publishDisabled, inReview, onPublish, deployMsg,
}: {
  app: SoftwareApp;
  reviewCard: ReviewCardData | null;
  publishLabel: string;
  publishDisabled: boolean;
  inReview: boolean;
  onPublish: () => void;
  deployMsg: string;
}) {
  return (
    <div style={{ marginTop: 4 }}>
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

      {/* The REAL deploy-review card for this app (the P0-fixed security scan + envelope +
          diff), shown read-only here so the requester sees exactly what a Builder reviews. */}
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
    </div>
  );
}

/* ─────────────────────────── Operate ─────────────────────────── */

function OperateStage({
  app, surface, user, connTools, toolOut, toolNote, onCallTool, onOpenRepo,
  canPromoteUI, onPromote, canDemoteUI, demoteLabel, confirmDemoteLabel,
  confirmDemote, setConfirmDemote, onDemote, busy, onLifecycle, onReload, msg,
}: {
  app: SoftwareApp;
  surface: { ui: boolean; api: boolean };
  user: { id: string; role: SessionRole };
  connTools: Tool[];
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
  return (
    <div style={{ marginTop: 4 }}>
      {/* Live pod state. */}
      <div className="sw-monitor">
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

      {/* Governed tool-call surface — the REAL per-app tools; results flag demo-seed data. */}
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

      {/* Promotion + lifecycle. */}
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
        {(app.owner === user.id || roleAtLeast(user.role, 'domain_admin')) ? null : (
          <span className="muted" style={{ fontSize: 12 }}>Lifecycle is limited to the owner and domain admins.</span>
        )}
      </div>
      {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}
    </div>
  );
}
