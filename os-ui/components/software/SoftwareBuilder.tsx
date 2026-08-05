/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import CodePanel from '@/components/CodePanel';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import ReviewCard, { type ReviewCardData } from '@/components/ReviewCard';
import ProgressStepper from '@/components/core/ProgressStepper';
import DomainTag from '@/components/DomainTag';
import { useToolWindow } from '@/components/ToolWindowProvider';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import { roleAtLeast, type Role as SessionRole } from '@/lib/core/session';
import StageShell from '@/components/core/StageShell';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import StageAssistantChat from '@/components/core/StageAssistantChat';
import SoftwareContextGrants from './SoftwareContextGrants';
import BuildChat, { type FileChange } from './BuildChat';
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
  applySpecSuggestion,
  type SuggestedGrant,
  type SuggestedEpic,
  type SuggestedStoriesForEpic,
  type RawImprovementSuggestion,
} from '@/lib/software/assistant-suggestions';
import {
  normalizeImprovement,
  dropImprovement,
  markDesignedById,
  markBuiltById,
  designAll,
  buildAll,
  refinementsToDesign,
  refinementsToBuild,
  type Improvement,
} from '@/lib/software/improvements';
import RefinementList, { type RefineHandlers } from './RefinementList';
import { buildableBatch } from './refinement-view';
import StageConversation from '@/components/core/StageConversation';
import { initialStageState, canEnter, isSatisfied, markDone, type StageState } from '@/lib/core/stages';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { buildStatusRail } from '@/lib/software/build-activity';
import { type BuildTarget } from '@/lib/software/build-target';
import { everyStoryHasSpec, specHasContent, type StorySpec } from '@/lib/software/story-spec';
import {
  BUILD_BATCH_CAP,
  pruneSelection,
  selectedCount,
  toggleFeature as toggleFeatureSel,
  toggleGroup as toggleGroupSel,
} from '@/lib/software/build-selection';
import { defineContextNote } from '@/lib/software/define-context';
import { modelRoleForMode, tierNote } from '@/lib/software/chat-modes';
import TeamPanel from '@/app/(build)/software/TeamPanel';
import DesignEpicDetail from './DesignEpicDetail';
import SpecTree, { type SpecNode } from './SpecTree';
import SpecDetailPanel from './SpecDetailPanel';
import { SW_STAGES, type SwStageId, type SwCtx } from './stages';
import { derivePipelineView, type PipelineView } from '@/lib/software/pipeline-view';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type Tool = { name: string; description: string; write: boolean };
type ChatMsg = { role: 'user' | 'assistant'; content: string; at: string };

/** A Design user story (mirrors lib/software/apps.ts AppStory). */
type Story = { id: string; title: string; asA: string; iWant: string; soThat: string; acceptance: string; status?: 'todo' | 'building' | 'done'; spec?: StorySpec };
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
  /** The scaffold the app was created from — locked after creation. */
  template: string;
  purpose: string;
  epics: Epic[];
  grants: ContextGrantsValue;
  owner: string;
  domain: string;
  visibility: Visibility;
  mode: 'live' | 'offline';
  /** Phase D: 'image' (default) served by a per-app image, or 'runtime' served by the OS. */
  serveMode?: 'image' | 'runtime';
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

const MODE_KEY = 'software.viewMode';
/** A stable empty selection set (Design passes this — it has no build-select). */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
/** The context kinds the Software Define stage offers. */
const SW_GRANT_KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

/** Display names for the app's scaffold template (locked after creation). */
const TEMPLATE_LABEL: Record<string, string> = {
  'sovereign-app': 'Application',
  website: 'Website',
  'api-service': 'APIs only',
  empty: 'Empty App',
  'vite-os': 'Vite OS app (legacy)',
  'nextjs-supabase': 'Next.js + Supabase (legacy)',
  service: 'Service (legacy)',
  script: 'Script (legacy)',
  dashboard: 'Dashboard (legacy)',
};

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

  // The scope the Build stage acts on — General (whole app), an EPIC, or a story.
  const [target, setTarget] = useState<BuildTarget | null>(null);
  // The Test→Build improvement to-dos (session-scoped): concrete fixes the Test verifier
  // (or free-text feedback) drafted, shown as pending items in the Build tree. Lifted here
  // so Test authors them and Build consumes them.
  const [improvements, setImprovements] = useState<Improvement[]>([]);
  const addImprovements = (raws: RawImprovementSuggestion[]) => {
    const findStory = (sid: string) => {
      const e = (app.epics ?? []).find((ep) => ep.stories.some((s) => s.id === sid));
      return e ? { epicId: e.id } : null;
    };
    const cleaned = raws.map((r) => normalizeImprovement(r, findStory)).filter((i): i is Improvement => i !== null);
    if (cleaned.length) setImprovements((prev) => [...prev, ...cleaned]);
  };

  // Resolve a story-id → its human title (for refinement attribution + build targeting).
  const storyById = (sid: string) => (app.epics ?? []).flatMap((e) => e.stories ?? []).find((s) => s.id === sid) ?? null;
  const storyTitleOf = (sid: string) => storyById(sid)?.title?.trim() || 'story';

  // Draft a concrete Design spec for ONE refinement on the REASONING model (the design
  // conversation route), so the design output is REAL — shown inline, then fed to the build.
  // Honest fallback: if the route can't answer, we draft from the note itself rather than fake.
  async function draftSpecFor(imp: Improvement): Promise<string> {
    const story = storyById(imp.storyId);
    const prompt = `Draft a concrete Design spec addition for this refinement so it can be built. Refinement: "${imp.note}". Target story: "${story?.title?.trim() || imp.storyId}". Return the specific feature(s), non-functional requirement(s) and rule(s) to add — terse, buildable.`;
    try {
      const res = await fetch(`/api/apps/${app.id}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'design', messages: [{ role: 'user', content: prompt }] }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      const text = (data.message ?? '').trim();
      if (text) return text;
    } catch {
      /* fall through to the honest local draft */
    }
    return `Spec for “${imp.note}” (story: ${story?.title?.trim() || imp.storyId}).`;
  }

  // Advance ONE refinement to 'designed' with a real drafted spec.
  async function designRefinement(imp: Improvement): Promise<void> {
    const spec = await draftSpecFor(imp);
    setImprovements((prev) => markDesignedById(prev, imp.id, spec));
  }
  // Advance ONE refinement to 'built' (its rebuild/build ran).
  function buildRefinement(imp: Improvement): void {
    setImprovements((prev) => markBuiltById(prev, imp.id));
  }
  // Accelerator: design (if needed) THEN build one item — the design output still lands
  // in state first (visible), then the build advances it to 'built'.
  async function designAndBuildRefinement(imp: Improvement): Promise<void> {
    if (refinementsToDesign([imp]).length > 0) {
      const spec = await draftSpecFor(imp);
      setImprovements((prev) => markBuiltById(markDesignedById(prev, imp.id, spec), imp.id));
    } else {
      setImprovements((prev) => markBuiltById(prev, imp.id));
    }
  }
  // Batch: design every designable refinement (each gets a real drafted spec).
  async function designAllRefinements(): Promise<void> {
    const toDraft = refinementsToDesign(improvements);
    const specs = new Map<string, string>();
    for (const imp of toDraft) specs.set(imp.id, await draftSpecFor(imp));
    setImprovements((prev) => designAll(prev, (i) => specs.get(i.id) ?? `Spec for “${i.note}”.`));
  }
  // Batch: build every currently-buildable refinement, capped for a reviewable batch.
  function buildAllRefinements(): void {
    const batch = new Set(buildableBatch(improvements).map((i) => i.id));
    setImprovements((prev) => prev.map((i) => (batch.has(i.id) ? markBuiltById([i], i.id)[0] : i)));
  }
  // Batch accelerator: design all, then build all — both steps applied, designs retained.
  async function designAndBuildAllRefinements(): Promise<void> {
    const toDraft = refinementsToDesign(improvements);
    const specs = new Map<string, string>();
    for (const imp of toDraft) specs.set(imp.id, await draftSpecFor(imp));
    setImprovements((prev) => buildAll(designAll(prev, (i) => specs.get(i.id) ?? `Spec for “${i.note}”.`)));
  }

  // The one handler bundle every stage's RefinementList consumes (same list, same lifecycle).
  const refineHandlers: RefineHandlers = {
    onDesign: designRefinement,
    onBuild: buildRefinement,
    onDesignAndBuild: designAndBuildRefinement,
    onDesignAll: designAllRefinements,
    onBuildAll: buildAllRefinements,
    onDesignAndBuildAll: designAndBuildAllRefinements,
    onDismiss: (id) => setImprovements((prev) => dropImprovement(prev, id)),
  };

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
    designSpecComplete: everyStoryHasSpec(epics),
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

  /**
   * Phase D — flip the app between image and OS runtime serving. Edit-scoped in the
   * lib (owner / in-domain admin); the server ALSO refuses 'runtime' for a non-Vite
   * shape (400), whose message we surface honestly here.
   */
  async function setServeMode(mode: 'image' | 'runtime'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serveMode: mode }),
      });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error}`);
      else setDeployMsg(mode === 'runtime' ? '✓ Runtime serving enabled — the OS serves this app directly.' : '✓ Image serving restored.');
      onReload();
    } catch (e) {
      setDeployMsg((e as Error).message);
    } finally {
      setBusy(false);
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

  // Manual recovery for an app whose Forgejo repo vanished (pipeline.forgejo ===
  // 'failing', the honest repo-404 signal). Calls the existing audited heal endpoint;
  // a normal build then commits + rebuilds from the re-provisioned scaffold.
  async function healRepo() {
    if (busy) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/deploy?action=heal-repo`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error ?? body.heal?.detail ?? 'Heal failed.'}`);
      else setDeployMsg(`✓ ${body.heal?.detail ?? 'Repository re-provisioned.'} Re-run your build to rebuild from the recovered scaffold.`);
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

  /**
   * Re-vendor the OS-client SDK into this EXISTING app (owner / in-domain admin) so it
   * gains the latest governed surface (e.g. `os.records.*` + app-scoped `os.context()`).
   * Honest feedback: re-vendored (files committed), no-op (skipped/non-frontend), or a
   * gate rejection — surfaced verbatim from the server, never a fake success.
   */
  async function refreshSdk() {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/refresh-sdk`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else if (body.skipped) setMsg(`• No-op: ${body.reason}`);
      else setMsg(body.ok ? `✓ SDK refreshed — ${body.detail}` : `✗ ${body.detail}`);
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

  // The ONE honest pipeline derivation — shared with Publish so Test and Publish
  // can never disagree. A live/serving app shows all upstream stages complete;
  // a real failure surfaces the same marked stage in both surfaces.
  const pipe = useMemo(
    () => derivePipelineView(app.pipeline, { state: app.deploy.state, releases: app.deploy.releases, serveMode: app.serveMode }),
    [app.pipeline, app.deploy.state, app.deploy.releases, app.serveMode],
  );

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
            <button
              className="btn sm"
              onClick={refreshSdk}
              disabled={busy}
              title="Re-vendor the OS-client SDK into this app (latest governed surface)"
            >
              {busy ? <span className="spin" /> : 'Refresh SDK'}
            </button>
          ) : null}
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
            <DesignStage
              app={app} epics={epics} canEdit={canEdit} onSave={(next) => saveDesign({ epics: next })} onReload={onReload}
              refinements={improvements} refineHandlers={refineHandlers} storyTitleOf={storyTitleOf}
            />
          ) : null}

          {stage.current === 'build' ? (
            <BuildStage
              app={app} epics={epics} canEditCode={canEditCode} onBuilt={onReload}
              target={target} setTarget={setTarget}
              onSaveEpics={canEdit ? (next) => saveDesign({ epics: next }) : undefined}
              onGoDesign={() => setStage((s) => ({ ...s, current: 'design' }))}
              improvements={improvements}
              refineHandlers={refineHandlers}
              storyTitleOf={storyTitleOf}
            />
          ) : null}

          {stage.current === 'test' ? (
            <TestStage
              app={app} epics={epics} surface={surface} pipe={pipe}
              busy={busy} onPreview={() => deployAction('preview')}
              deployMsg={deployMsg}
              offlineAck={previewAck} onOfflineAck={() => { setPreviewAck(true); setStage((s) => markDone(s, 'test')); }}
              connTools={connection?.tools ?? app.mcpTools}
              improvements={improvements}
              onAddImprovements={addImprovements}
              onGoBuild={() => setStage((s) => ({ ...s, current: 'build' }))}
              onGoDesign={() => setStage((s) => ({ ...s, current: 'design' }))}
              refineHandlers={refineHandlers}
              storyTitleOf={storyTitleOf}
            />
          ) : null}

          {stage.current === 'publish' ? (
            <PublishStage
              app={app} surface={surface} user={user} pipe={pipe}
              connTools={connection?.tools ?? app.mcpTools}
              reviewCard={reviewCard}
              publishLabel={publishLabel} publishDisabled={publishDisabled} inReview={inReview}
              onPublish={() => deployAction()} deployMsg={deployMsg}
              toolOut={toolOut} toolNote={toolNote} onCallTool={callTool}
              onOpenRepo={() => {
                // Open the EXTERNAL browsable repo URL directly — Forgejo's console is a
                // full app whose root-relative assets/redirects break inside the embedding
                // proxy (the 404 the user hit). The htmlUrl is now the external host.
                if (app.repo.htmlUrl) window.open(app.repo.htmlUrl, '_blank', 'noreferrer');
                else if (app.repo.fullName) openTool('forgejo', `${app.name} · repo`, app.repo.fullName);
              }}
              canPromoteUI={canPromoteUI} onPromote={promote}
              canDemoteUI={canDemoteUI} demoteLabel={demoteLabel} confirmDemoteLabel={confirmDemoteLabel}
              confirmDemote={confirmDemote} setConfirmDemote={setConfirmDemote} onDemote={demote}
              busy={busy} onLifecycle={lifecycle} msg={msg} onHealRepo={healRepo}
              canEdit={canEdit} onSetServeMode={setServeMode}
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
  // Developer layout: the BUILD / DEPLOY CONSOLE sits at the TOP, full screen width; the
  // code (which needs the room) sits BELOW it at full width.
  return (
    <div style={{ marginTop: 4 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        The raw surface: the live build/deploy console up top, then the app’s committed files
        below (edit + commit in-browser). Everything here is real app state — nothing is simulated.
      </p>

      {/* Build / deploy console — TOP, full width. */}
      <div className="grant-block" style={{ marginTop: 12 }}>
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

      {/* Code — BELOW, full width (code needs the space). */}
      <div style={{ marginTop: 16 }}>
        {canEditCode ? (
          <CodePanel appId={app.id} repoFullName={app.repo.fullName} />
        ) : (
          <div className="grant-block">
            <div className="comp-label">App files</div>
            <p className="hint" style={{ marginTop: 4 }}>Editing the code is builder-only. Repo: <span className="mono">{app.repo.fullName || '(not scaffolded)'}</span>.</p>
          </div>
        )}
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
  // everyone else caps at read+propose (writes held for approval). New grants START
  // at read-only (the safe default) — the user raises each item to Read+propose /
  // Read+write up to the ceiling when they actually need write access.
  const cap = { ...contextAccessCap(canEdit ? 'read-write' : 'read-propose'), default: 'read-only' as const };

  const dirty = purpose !== (app.purpose ?? '');

  // Apply an assistant purpose suggestion → editable draft the user confirms.
  const applyPurpose = (p: string) => {
    setPurpose(applyPurposeSuggestion(p));
    setSuggested(true);
  };
  // Apply assistant grant suggestions → fold into the current grants (clamped to cap) + persist.
  const applyGrants = (sg: SuggestedGrant[]) => onSaveGrants(applyGrantsSuggestion(grants, sg, cap));

  const grantCount = SW_GRANT_KINDS.reduce((n, k) => n + (grants[k]?.length ?? 0), 0);
  const purposeSet = !!(app.purpose ?? '').trim();

  // Structure — the app's spec being shaped: its purpose and the governed context it may
  // use. This is the direct-manipulation twin of the conversation; the assistant's
  // suggestions flow straight into these controls.
  const structure = (
    <>
      <label className="comp-label">Purpose</label>
      <p className="hint" style={{ marginTop: 0 }}>
        What is this app for? One or two sentences — Define is complete once a purpose is set.
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
        Connections, Data, Knowledge, Files and Metrics this app may use, at folder or item level.
      </p>
      <SoftwareContextGrants
        value={grants}
        onChange={onSaveGrants}
        kinds={SW_GRANT_KINDS}
        cap={cap}
        canEdit={canEdit}
      />
    </>
  );

  return (
    <div className="agent-editor" {...anchorAttr(ANCHORS.software.define)}>
      <StageConversation
        context={
          <>
            <span className="sc-scope">{app.name}</span>
            <span className="sc-hint">
              id <code>{app.slug}</code> · template{' '}
              <span className="badge muted" title="Chosen at creation — locked afterwards">
                {TEMPLATE_LABEL[app.template] ?? app.template}
              </span>{' '}
              · surface <code>{surfaceLabel}</code>
            </span>
            <span className="sc-hint sc-spacer">Describe the app — the conversation shapes its purpose &amp; the context it may use.</span>
          </>
        }
        structure={structure}
        conversation={
          <StageAssistantChat
            appId={app.id}
            stage="define"
            intro="Improve the purpose and suggest which governed context to grant."
            starters={['Sharpen my purpose', 'What context should this app be granted?']}
            onApplyPurpose={canEdit ? applyPurpose : undefined}
            onApplyGrants={canEdit ? applyGrants : undefined}
          />
        }
        outcome={
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="comp-label" style={{ margin: 0 }}>Defined</span>
            <span className={`badge ${purposeSet ? 'ok' : 'muted'}`}>{purposeSet ? 'Purpose set' : 'Purpose pending'}</span>
            <span className="badge muted">{grantCount} context grant{grantCount === 1 ? '' : 's'}</span>
          </div>
        }
      />
    </div>
  );
}

/* ─────────────────────────── Design ─────────────────────────── */

/** Set one story's spec inside the epics tree, returning a new array (immutable). */
function withStorySpec(epics: Epic[], epicId: string, storyId: string, spec: StorySpec): Epic[] {
  return epics.map((e) =>
    e.id !== epicId ? e : { ...e, stories: e.stories.map((s) => (s.id === storyId ? { ...s, spec } : s)) },
  );
}

/**
 * The Design stage — the SPECIFICATION, read-first, ONE EPIC AT A TIME. Layout is
 * Assistant on the LEFT, the epic detail on the RIGHT (StageConversation `reverse`) —
 * Design has no build-tree, so the assistant leads. The right panel
 * (components/software/DesignEpicDetail.tsx) shows a single epic with a prev/next
 * switcher, clean read mode by default and an explicit Edit toggle; each user story is
 * an EXPANDING row revealing its Features · NFRs · Rules. Expanding a story makes it the
 * assistant's target, so `suggestedSpec` folds into THAT story;
 * `suggestedEpics`/`suggestedStories` still grow the backlog. Every write goes through
 * the SAME governed `onSave` (→ patchAppDesign).
 */
function DesignStage({
  app, epics, canEdit, onSave, onReload, refinements, refineHandlers, storyTitleOf,
}: {
  app: SoftwareApp;
  epics: Epic[];
  canEdit: boolean;
  onSave: (epics: Epic[]) => void;
  onReload: () => void;
  refinements: Improvement[];
  refineHandlers: RefineHandlers;
  storyTitleOf: (storyId: string) => string;
}) {
  const applyEpics = (sug: SuggestedEpic[]) => onSave(applyEpicsSuggestion(epics, sug));
  const applyStories = (groups: SuggestedStoriesForEpic[]) => onSave(applyStoriesSuggestion(epics, groups));

  // The story the user is focused on (the expanded row) — the assistant's spec target.
  const [activeStory, setActiveStory] = useState<{ epicId: string; storyId: string } | null>(null);
  const targetStory = activeStory
    ? epics.find((e) => e.id === activeStory.epicId)?.stories.find((s) => s.id === activeStory.storyId) ?? null
    : null;

  const applySpec = (partial: Partial<StorySpec>) => {
    if (!activeStory || !targetStory) return;
    onSave(withStorySpec(epics, activeStory.epicId, activeStory.storyId, applySpecSuggestion(targetStory.spec, partial)));
  };

  const hasStories = epics.some((e) => (e.stories?.length ?? 0) > 0);
  const stories = epics.flatMap((e) => e.stories ?? []);
  const specced = stories.filter((s) => specHasContent(s.spec)).length;
  const purpose = (app.purpose ?? '').trim();

  return (
    <div {...anchorAttr(ANCHORS.software.design)}>
      <StageConversation
        reverse
        context={
          <>
            <span className="sc-scope">Design</span>
            <span className="badge muted" title="Design does all the planning on the reasoning model">Design · reasoning model</span>
            <span className="sc-hint">{purpose ? `for “${purpose}”` : 'specify the app story by story'}</span>
            <span className="sc-hint sc-spacer">Expand a story, discuss what it should do — watch its Features · NFRs · Rules fill.</span>
          </>
        }
        structure={
          <>
            <DesignEpicDetail epics={epics} canEdit={canEdit} onSave={onSave} onActiveStory={setActiveStory} />
            {canEdit && refinements.length > 0 ? (
              <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <RefinementList
                  refinements={refinements}
                  storyTitle={storyTitleOf}
                  variant="design"
                  handlers={refineHandlers}
                />
              </div>
            ) : null}
          </>
        }
        conversation={
          <StageAssistantChat
            appId={app.id}
            stage="design"
            intro={targetStory ? `Specify “${targetStory.title.trim() || 'this story'}” — features, NFRs and rules.` : 'Propose EPICs and user stories, or expand a story to specify it.'}
            starters={targetStory
              ? ['List features for this story', 'What rules and NFRs should it have?']
              : ['Suggest EPICs for this app', 'Add user stories to my EPICs']}
            onApplyEpics={canEdit ? applyEpics : undefined}
            onApplyStories={canEdit ? applyStories : undefined}
            onApplySpec={canEdit && targetStory ? applySpec : undefined}
            specTargetLabel={targetStory?.title.trim() || undefined}
          />
        }
        outcome={
          <>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: canEdit ? 12 : 0 }}>
              <span className="comp-label" style={{ margin: 0 }}>Specification</span>
              <span className={`badge ${stories.length > 0 ? 'ok' : 'muted'}`}>{stories.length} stor{stories.length === 1 ? 'y' : 'ies'}</span>
              <span className={`badge ${specced === stories.length && stories.length > 0 ? 'ok' : 'muted'}`}>{specced} / {stories.length} specified</span>
            </div>
            {canEdit ? <ShipDesignPanel app={app} hasStories={hasStories} onReload={onReload} /> : null}
          </>
        }
      />
    </div>
  );
}

/**
 * Ship the design outward — the three governed Design actions:
 *   • Push to Jira — each EPIC → a Jira Epic issue, each story → a Story issue, via the
 *     user's OWN governed Atlassian connection (jira_create_issue, Write-approval).
 *   • Hand off to GitHub — file a governed code-handoff issue on a target repo via the
 *     user's OWN GitHub connection (create_issue, Write-approval).
 *   • Import Claude Design — paste a Claude-generated frontend (code or URL); it seeds
 *     the app's src/ through the governed commit path as the AI build's starting point.
 * Every message is HONEST: "connect X first", a queued approval, or a real key/URL —
 * never a fake success. Governance is enforced server-side; we only surface its state.
 */
function ShipDesignPanel({ app, hasStories, onReload }: { app: SoftwareApp; hasStories: boolean; onReload: () => void }) {
  const [jiraKey, setJiraKey] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [design, setDesign] = useState('');
  const [designUrl, setDesignUrl] = useState('');
  const [busy, setBusy] = useState<'jira' | 'git' | 'import' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  async function post(kind: 'jira' | 'git' | 'import', path: string, body: Record<string, unknown>) {
    setBusy(kind);
    setNote(null);
    try {
      const res = await fetch(`/api/apps/${app.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        const connectMsg = data.connectHref ? `${data.error} ` : data.error;
        setNote({ tone: 'err', text: connectMsg || 'Request failed.' });
        return;
      }
      if (kind === 'jira') {
        const created = (data.created ?? []).length;
        const queued = (data.queued ?? []).length;
        const failed = (data.failed ?? []).length;
        const parts = [
          created ? `${created} created` : '',
          queued ? `${queued} awaiting approval` : '',
          failed ? `${failed} failed` : '',
        ].filter(Boolean).join(' · ');
        setNote({ tone: failed ? 'warn' : 'ok', text: `Jira push (${data.total}): ${parts || 'nothing to do'}.` });
      } else if (kind === 'git') {
        if (data.queued) setNote({ tone: 'warn', text: 'Code hand-off filed for approval — approve it in Policies & Approvals.' });
        else setNote({ tone: 'ok', text: `Code hand-off issue opened on ${data.repo} (${data.filesListed} files listed).` });
      } else {
        setNote({ tone: 'ok', text: `Seeded frontend: ${(data.seeded ?? []).join(', ')} (${data.mode}).` });
        setDesign('');
        setDesignUrl('');
        onReload();
      }
    } catch (e) {
      setNote({ tone: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grant-block" style={{ marginTop: 16 }}>
      <div className="comp-label">Ship this design</div>
      <p className="hint" style={{ marginTop: 4 }}>
        Push the backlog to Jira, hand the code to GitHub, or seed the frontend from a Claude
        design — all through your OWN governed connections. Writes respect approval; nothing is faked.
      </p>

      {/* Push to Jira */}
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={jiraKey}
          onChange={(e) => setJiraKey(e.target.value)}
          placeholder="Jira project key (e.g. OPS)"
          style={{ width: 220 }}
        />
        <button
          className="btn"
          disabled={busy !== null || !jiraKey.trim() || !hasStories}
          onClick={() => post('jira', 'jira-push', { projectKey: jiraKey.trim() })}
          title={hasStories ? 'Create Jira Epic + Story issues' : 'Add EPICs and stories first'}
        >
          {busy === 'jira' ? <span className="spin" /> : 'Push to Jira'}
        </button>
      </div>

      {/* Hand off to GitHub */}
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={ghRepo}
          onChange={(e) => setGhRepo(e.target.value)}
          placeholder="GitHub repo (owner/repo)"
          style={{ width: 220 }}
        />
        <button
          className="btn ghost"
          disabled={busy !== null || !ghRepo.trim()}
          onClick={() => post('git', 'git-push', { repo: ghRepo.trim() })}
          title="File a governed code hand-off issue on the target repo"
        >
          {busy === 'git' ? <span className="spin" /> : 'Push code to Git'}
        </button>
      </div>

      {/* Import Claude Design */}
      <div style={{ marginTop: 14 }}>
        <label className="comp-label" style={{ fontSize: 12 }}>Import a Claude design → seed the frontend</label>
        <textarea
          value={design}
          onChange={(e) => setDesign(e.target.value)}
          rows={4}
          placeholder="Paste Claude-generated frontend code (HTML / React)…"
          style={{ width: '100%', marginTop: 4, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
        />
        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
          <span className="hint" style={{ margin: 0 }}>or a URL:</span>
          <input
            type="text"
            value={designUrl}
            onChange={(e) => setDesignUrl(e.target.value)}
            placeholder="https://…"
            style={{ width: 240 }}
          />
          <button
            className="btn"
            disabled={busy !== null || (!design.trim() && !designUrl.trim())}
            onClick={() => post('import', 'import-design', design.trim() ? { code: design } : { url: designUrl.trim() })}
          >
            {busy === 'import' ? <span className="spin" /> : 'Seed frontend from this'}
          </button>
        </div>
      </div>

      {note ? (
        <div className={note.tone === 'err' ? 'error' : 'answer'} style={{ marginTop: 12 }}>
          {note.tone === 'warn' ? '⚠ ' : note.tone === 'ok' ? '✓ ' : '✗ '}{note.text}
          {note.tone === 'err' && /connect/i.test(note.text) ? (
            <> <Link className="sw-quiet-link" href="/connections">Open Connections →</Link></>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Build ─────────────────────────── */

/** Set one story's status inside the epics tree, returning a new array (immutable). */
function withStoryStatus(epics: Epic[], epicId: string, storyId: string, status: 'todo' | 'building' | 'done'): Epic[] {
  return epics.map((e) =>
    e.id !== epicId ? e : { ...e, stories: e.stories.map((s) => (s.id === storyId ? { ...s, status } : s)) },
  );
}

/**
 * Persistent Build ▸ Preview ▸ Deploy status rail. Read-only, wired to the SAME
 * live state the stage already reads (`app.pipeline`, `app.deploy.*`) — it is the
 * honest single-glance answer to "where is this app?". Never fabricates a state it
 * can't see (Preview is live only when a URL is actually served).
 */
function BuildStatusRail({ app }: { app: SoftwareApp }) {
  const segments = buildStatusRail(app);
  const sha = app.repo.seeded.length > 0 || app.pipeline.forgejo === 'ok' ? app.repo.fullName.split('/').pop() : null;
  return (
    <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--panel)', marginBottom: 12 }}>
      {segments.map((seg, i) => (
        <div key={seg.label} className="row" style={{ gap: 8, alignItems: 'center' }}>
          {i > 0 ? <span className="muted" aria-hidden="true" style={{ opacity: 0.4 }}>·</span> : null}
          <span className={`sw-dot ${seg.tone === 'ok' ? 'on' : 'off'}`} aria-hidden="true" style={seg.tone === 'active' ? { background: 'var(--gold)' } : undefined} />
          <span style={{ fontSize: 12 }}>
            <strong>{seg.label}:</strong>{' '}
            <span className="muted">{seg.value}</span>
          </span>
        </div>
      ))}
      {app.deploy.previewUrl ? (
        <a href={app.deploy.previewUrl} target="_blank" rel="noreferrer" className="sw-quiet-link" style={{ fontSize: 12, marginLeft: 'auto' }}>
          Open preview ↗
        </a>
      ) : null}
    </div>
  );
}

/** Which stories own the selected feature-ids (by parsing the `${storyId}#f${i}` ids). */
function selectedStoryIds(selected: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of selected) out.add(id.split('#')[0]);
  return out;
}

/**
 * Map the SELECTED feature-set to the tightest existing BuildTarget so the one Build
 * press builds exactly that scope (its specs travel into the prompt):
 *   • features from ONE story  → that story;
 *   • features across stories of ONE epic → that epic (built story-by-story);
 *   • features across MULTIPLE epics → the whole app (remaining stories).
 * Honest: the target we build is always the smallest scope that covers the selection.
 */
function selectionToTarget(epics: Epic[], selected: ReadonlySet<string>): BuildTarget | null {
  const storyIds = selectedStoryIds(selected);
  if (storyIds.size === 0) return null;
  const epicOf = (sid: string) => epics.find((e) => e.stories.some((s) => s.id === sid));
  if (storyIds.size === 1) {
    const sid = [...storyIds][0];
    const epic = epicOf(sid);
    if (!epic) return null;
    return { kind: 'story', epicId: epic.id, storyId: sid };
  }
  const epicIds = new Set([...storyIds].map((sid) => epicOf(sid)?.id).filter(Boolean) as string[]);
  if (epicIds.size === 1) return { kind: 'epic', epicId: [...epicIds][0] };
  return { kind: 'app' };
}

function BuildStage({
  app, epics, canEditCode, onBuilt, target, setTarget, onSaveEpics, onGoDesign, improvements, refineHandlers, storyTitleOf,
}: {
  app: SoftwareApp;
  epics: Epic[];
  canEditCode: boolean;
  onBuilt: () => void;
  target: BuildTarget | null;
  setTarget: (t: BuildTarget | null) => void;
  /** Persist an updated epics array (per-story status). Undefined when the viewer can't edit. */
  onSaveEpics?: (epics: Epic[]) => void;
  /** Jump back to the Design stage (the tree's empty-state pointer). */
  onGoDesign?: () => void;
  /** Test→Build refinement to-dos to show as pending items in the tree. */
  improvements: Improvement[];
  /** The shared refinement lifecycle handlers (design/build/design&build + batches). */
  refineHandlers: RefineHandlers;
  /** Resolve a story-id → its title. */
  storyTitleOf: (storyId: string) => string;
}) {
  // Plan ⇄ Build: Plan discusses/plans with ZERO code changes; Build executes end-to-end.
  const [buildMode, setBuildMode] = useState<'plan' | 'build'>('build');
  // Bumped after each Build commit so the instant preview re-fetches the new files.
  const [previewKey, setPreviewKey] = useState(0);
  // Live run signals: is a run streaming, and which stories' LAST Build run failed.
  const [running, setRunning] = useState(false);
  const [failedStoryIds, setFailedStoryIds] = useState<ReadonlySet<string>>(new Set());

  // The DETAIL node open on the right (nav) — always-visible spec + built-state.
  const [node, setNode] = useState<SpecNode>({ kind: 'app' });
  // The features QUEUED for the next build (capped batch-select).
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_SET);
  // Bumped to fire a build of the current target from the one Build button.
  const [buildTrigger, setBuildTrigger] = useState(0);
  // The story-ids this build run targets (captured at press) — so on success we mark
  // EVERY targeted story done + clear its selection, even for an epic/whole-app scope
  // where `target` is not a single story. Honest: these are exactly the stories whose
  // features the user queued and the run built.
  const [buildingStoryIds, setBuildingStoryIds] = useState<string[]>([]);

  // Prune selections that no longer exist when the spec changes upstream.
  useEffect(() => { setSelected((sel) => pruneSelection(sel, epics)); }, [epics]);

  const selCount = selectedCount(selected);
  const buildTargetForSelection = useMemo(() => selectionToTarget(epics, selected), [epics, selected]);

  // On a successful BUILD run, mark every story that was in the batch done, clear its
  // selection, and clear any prior failure. Works for story, epic and whole-app scopes.
  const handleBuilt = (changes: FileChange[]) => {
    if (buildingStoryIds.length > 0 && changes.length > 0) {
      if (onSaveEpics) {
        let next = epics;
        for (const sid of buildingStoryIds) {
          const epic = next.find((e) => e.stories.some((s) => s.id === sid));
          if (epic) next = withStoryStatus(next, epic.id, sid, 'done');
        }
        onSaveEpics(next);
      }
      const builtSet = new Set(buildingStoryIds);
      setSelected((sel) => {
        const nx = new Set<string>();
        for (const id of sel) if (!builtSet.has(id.split('#')[0])) nx.add(id);
        return nx;
      });
      setFailedStoryIds((prev) => {
        const n = new Set(prev);
        for (const sid of buildingStoryIds) n.delete(sid);
        return n;
      });
    }
    if (changes.length > 0) setPreviewKey((k) => k + 1);
    onBuilt();
  };

  const handleRunEnd = (failed: boolean, runMode: string) => {
    setRunning(false);
    if (failed && runMode === 'build' && buildingStoryIds.length > 0) {
      setFailedStoryIds((prev) => { const n = new Set(prev); for (const sid of buildingStoryIds) n.add(sid); return n; });
    }
  };

  // The one "Build" press: map the selection to a target, remember the batch's stories,
  // set the target, and fire the run.
  const runBuild = () => {
    const t = buildTargetForSelection;
    if (!t || running) return;
    setBuildingStoryIds([...selectedStoryIds(selected)]);
    setTarget(t);
    setBuildMode('build');
    // The target prop flows to BuildChat; bump the trigger next tick so the chat sees it.
    setBuildTrigger((n) => n + 1);
  };

  const toggleFeat = (fid: string) => setSelected((sel) => toggleFeatureSel(sel, fid));
  const toggleGrp = (fids: string[]) => setSelected((sel) => toggleGroupSel(sel, fids));

  // The effective target for the ONE assistant (BuildChat). A batch build sets `target`
  // explicitly; a free-text build with nothing queued attributes to the STORY the user
  // has selected in the detail (so a typed "add a login form" is still attributed +
  // ticked). Falls back to null (whole-app) only when nothing is selected.
  const nodeStoryTarget: BuildTarget | null = node.kind === 'story'
    ? { kind: 'story', epicId: node.epicId, storyId: node.storyId }
    : node.kind === 'feature'
      ? { kind: 'story', epicId: node.epicId, storyId: node.storyId }
      : null;
  const chatTarget = target ?? nodeStoryTarget;

  const capNote = `Build in focused batches of up to ${BUILD_BATCH_CAP} features so each result is reliable and reviewable.`;
  const buildLabel = (() => {
    if (buildTargetForSelection?.kind === 'story') {
      const done = epics.find((e) => e.id === (buildTargetForSelection as { epicId: string }).epicId)
        ?.stories.find((s) => s.id === (buildTargetForSelection as { storyId: string }).storyId)?.status === 'done';
      return done ? 'Rebuild this user story' : 'Build this user story';
    }
    return `Build ${selCount} selected feature${selCount === 1 ? '' : 's'}`;
  })();

  // The structured LEFT surface: the capped-batch spec tree + the one Build button.
  const structure = (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="comp-label" style={{ margin: 0 }}>Epics · stories · features</div>
        <span className={`badge ${selCount >= BUILD_BATCH_CAP ? 'warn' : 'muted'}`} title={capNote}>{selCount} / {BUILD_BATCH_CAP} selected</span>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        Tick the features to build next (selecting a story or EPIC cascades to its features). {capNote} A feature with no Design spec can&apos;t be built — specify it in Design first.
      </p>
      <div style={{ marginTop: 10 }}>
        {epics.length === 0 ? (
          <div className="db-empty" style={{ padding: 18, border: '1px dashed var(--border)', borderRadius: 10, textAlign: 'center' }}>
            <p className="muted" style={{ margin: 0 }}>No stories yet — specify the app in Design first.</p>
            {onGoDesign ? <button className="btn sm" style={{ marginTop: 10 }} onClick={onGoDesign}>Go to Design →</button> : null}
          </div>
        ) : (
          <SpecTree
            epics={epics}
            selected={node}
            onSelectNode={setNode}
            selectable
            selectedFeatures={selected}
            onToggleFeature={toggleFeat}
            onToggleGroup={toggleGrp}
            onGoDesign={onGoDesign}
          />
        )}
      </div>

      {/* Test → Build refinements: the SAME lifecycle list, here in its Build lane. Only
          buildable items (rebuild-proposed / designed) build; a proposed design-kind is
          gated (design-before-build) and points to Design. Built items stay visible. */}
      {improvements.length > 0 ? (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <RefinementList
            refinements={improvements}
            storyTitle={storyTitleOf}
            variant="build"
            handlers={refineHandlers}
            onGoDesign={onGoDesign}
          />
        </div>
      ) : null}

      {/* The ONE primary Build button — builds the selected set (tightest scope). */}
      <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn lg"
          disabled={!buildTargetForSelection || running}
          onClick={runBuild}
          title={buildTargetForSelection ? 'Build the selected features — commits real code' : 'Select at least one feature to build'}
        >
          {running ? <span className="spin" /> : buildLabel}
        </button>
        {selCount === 0 ? <span className="muted" style={{ fontSize: 12 }}>Select features on the left to build.</span> : null}
      </div>

      {/* Always-visible detail: the selected item's spec + honest built-state. */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <SpecDetailPanel node={node} epics={epics} />
      </div>
    </div>
  );

  return (
    <div {...anchorAttr(ANCHORS.software.build)}>
      <BuildStatusRail app={app} />
      <div style={{ marginTop: 4, marginBottom: 12 }}>
        <TeamPanel onBuilt={onBuilt} />
      </div>
      <StageConversation
        context={
          <>
            <span className="sc-scope">Build</span>
            <span className="badge muted" title="The build runs code generation on the standard model — no reasoning escalation">Build · {tierNote(modelRoleForMode('build'))}</span>
            <span className="sc-hint">Context from Define: {defineContextNote({ template: app.template, purpose: app.purpose })}</span>
            <span className="sc-hint sc-spacer">Tick features → Build the batch on the standard model, grounded in the Design spec. The assistant refines &amp; gives feedback.</span>
          </>
        }
        structure={structure}
        conversation={
          <BuildChat
            appId={app.id}
            appName={app.name}
            mode={buildMode}
            target={chatTarget}
            epics={epics}
            actions={[]}
            buildTrigger={buildTrigger}
            initialMessages={app.chat
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({ role: m.role, content: m.content }))}
            onBuilt={handleBuilt}
            onRunStart={() => { setRunning(true); if (buildingStoryIds.length === 0 && chatTarget?.kind === 'story') setBuildingStoryIds([chatTarget.storyId]); }}
            onRunEnd={(failed, m) => { handleRunEnd(failed, m); setBuildingStoryIds([]); }}
            onModeChange={setBuildMode}
            showDetails={canEditCode}
          />
        }
        outcome={
          app.surface?.ui ? (
            <div className="grant-block">
              <div className="comp-label">Preview · live data</div>
              {app.deploy.previewUrl ? (
                <>
                  <p className="hint" style={{ marginTop: 4, marginBottom: 10 }}>
                    The deployed build served by the runner, calling the governed OS API as you — real granted data or a real error.
                  </p>
                  <iframe
                    key={previewKey}
                    src={app.deploy.previewUrl}
                    title="Live app preview"
                    style={{ width: '100%', height: 420, border: '1px solid var(--line)', borderRadius: 10, background: '#0b0b0d' }}
                  />
                  <a href={app.deploy.previewUrl} target="_blank" rel="noreferrer" className="sw-quiet-link" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>Open app UI ↗</a>
                </>
              ) : (
                <p className="hint" style={{ marginTop: 4 }}>
                  No live preview yet — provision one in the <strong>Test</strong> stage after your first build. This shows the real deployed app, never a mock.
                </p>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/* ─────────────────────────── Test (replaces Preview) ─────────────────────────── */

/**
 * The Test stage — run the app and LLM-test each BUILT story against its Design spec.
 * It keeps the LIVE-POD view (the real deployed/preview iframe + provision control — the
 * honest "see it running" surface) and adds the test conversation: stage="test" reads
 * the committed code + each story's spec and reports PASS/FAIL per item (grounded, never
 * fabricated). Structured: the runner monitor + a "what will be tested" spec summary;
 * conversation: the LLM tester; outcome: the live-pod iframe.
 */
function TestStage({
  app, epics, surface, pipe, busy, onPreview, deployMsg, offlineAck, onOfflineAck, connTools,
  improvements, onAddImprovements, onGoBuild, onGoDesign, refineHandlers, storyTitleOf,
}: {
  app: SoftwareApp;
  epics: Epic[];
  surface: { ui: boolean; api: boolean };
  pipe: PipelineView;
  busy: boolean;
  onPreview: () => void;
  deployMsg: string;
  offlineAck: boolean;
  onOfflineAck: () => void;
  connTools: Tool[];
  improvements: Improvement[];
  onAddImprovements: (raws: RawImprovementSuggestion[]) => void;
  onGoBuild: () => void;
  onGoDesign: () => void;
  refineHandlers: RefineHandlers;
  storyTitleOf: (storyId: string) => string;
}) {
  const [showApi, setShowApi] = useState(false);
  // "Verify & Improve" run state — fires the reasoning verifier + folds its improvements
  // into the shared Build to-do list. Honest: it only proposes; nothing auto-builds.
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState('');
  const stories = epics.flatMap((e) => e.stories ?? []);
  const builtStories = stories.filter((s) => s.status === 'done');

  async function verifyAndImprove() {
    if (verifying) return;
    setVerifying(true);
    setVerifyMsg('');
    try {
      const res = await fetch(`/api/apps/${app.id}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'test', messages: [{ role: 'user', content: 'Verify every built story against its Design spec and draft concrete improvements for anything that falls short.' }] }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; suggestions?: { suggestedImprovements?: RawImprovementSuggestion[] }; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      const imps = data.suggestions?.suggestedImprovements ?? [];
      if (imps.length) { onAddImprovements(imps); setVerifyMsg(`✓ ${imps.length} refinement${imps.length === 1 ? '' : 's'} found — shown below (Proposed).`); }
      else setVerifyMsg(data.message ? '✓ Verified — no shortfalls flagged.' : '✓ Verified.');
    } catch (e) {
      setVerifyMsg(`✗ ${(e as Error).message}`);
    } finally {
      setVerifying(false);
    }
  }

  // Structure — the deployed build the runner serves + provision controls + pipeline
  // health, and a summary of which built stories the LLM tester will check against spec.
  const structure = (
    <>
      <div className="grant-block" style={{ marginBottom: 12 }}>
        <div className="comp-label" style={{ margin: 0 }}>Verify against spec</div>
        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`badge ${builtStories.length > 0 ? 'ok' : 'muted'}`}>{builtStories.length} built stor{builtStories.length === 1 ? 'y' : 'ies'}</span>
          <span className="muted" style={{ fontSize: 12 }}>{stories.length - builtStories.length} not built yet</span>
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          The reasoning verifier reads the committed code and each built story&apos;s spec (features · NFRs · rules), reports PASS/FAIL per item (grounded, never fabricated), and drafts a concrete improvement for anything that falls short.
        </p>
        <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" disabled={verifying || builtStories.length === 0} onClick={verifyAndImprove} title={builtStories.length === 0 ? 'Build a story first' : 'Verify each built story vs its spec and draft refinements'}>
            {verifying ? <span className="spin" /> : 'Verify & Improve'}
          </button>
          {improvements.length > 0 ? (
            <span className="badge muted" title="Findings render below as refinement cards">{improvements.length} refinement{improvements.length === 1 ? '' : 's'} below</span>
          ) : null}
        </div>
        {verifyMsg ? <div className={verifyMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 10 }}>{verifyMsg}</div> : null}
        <p className="hint" style={{ marginTop: 8 }}>
          Refinements land as reviewable to-dos — nothing auto-runs. A missed spec item becomes a <strong>rebuild</strong> (standard model); feedback that changes the requirement is routed to <strong>Design</strong> first.
        </p>
      </div>

      {/* The findings, right here as refinement cards (Proposed) — the SAME lifecycle list
          shown in Design/Build, so a finding's dimension + target story + state is legible
          the moment it's flagged. Read-only in Test: you act on them in Design / Build. */}
      {improvements.length > 0 ? (
        <div className="grant-block" style={{ marginBottom: 12 }}>
          <RefinementList
            refinements={improvements}
            storyTitle={storyTitleOf}
            variant="test"
            handlers={{ onDismiss: refineHandlers.onDismiss }}
          />
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {refinementsToBuild(improvements).length > 0 ? (
              <button className="btn ghost sm" onClick={onGoBuild} title="Act on the buildable refinements in Build">{refinementsToBuild(improvements).length} → Build</button>
            ) : null}
            {refinementsToDesign(improvements).length > 0 ? (
              <button className="btn ghost sm" onClick={onGoDesign} title="Design the scope-changing refinements first">{refinementsToDesign(improvements).length} → Design</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {surface.ui ? <div className="comp-label" style={{ marginBottom: 6 }}>Deployed build · exactly what ships</div> : null}
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
            commentary={pipe.commentary}
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
    </>
  );

  return (
    <div {...anchorAttr(ANCHORS.software.test)}>
      <StageConversation
        context={
          <>
            <span className="sc-scope">Test</span>
            <span className="badge muted" title="Verification runs on the reasoning model">Test · reasoning model</span>
            <span className="sc-hint mono">{app.subdomain}</span>
            <span className={`badge ${app.deploy.previewUrl ? 'ok' : 'muted'}`}>{app.deploy.previewUrl ? 'Preview running' : 'Runner pending'}</span>
            <span className="sc-hint sc-spacer">Run the app, and LLM-test each built story against its Design spec.</span>
          </>
        }
        structure={structure}
        conversation={
          <StageAssistantChat
            appId={app.id}
            stage="test"
            intro="Verify the built stories against their spec, give feedback, or ask why the pod isn't ready. Improvements become Build to-dos."
            starters={['Verify the built stories against their spec', 'Why is the pod not ready?']}
            onApplyImprovements={onAddImprovements}
          />
        }
        outcome={
          surface.ui ? (
            <div className="grant-block">
              <div className="comp-label">Preview · live data</div>
              {app.deploy.previewUrl ? (
                <>
                  <p className="hint" style={{ marginTop: 4, marginBottom: 10 }}>
                    The deployed build served by the runner, calling the governed OS API as you —
                    real granted data, or a real error.
                  </p>
                  <iframe
                    title="App preview"
                    src={app.deploy.previewUrl}
                    style={{ width: '100%', height: 420, border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg)' }}
                  />
                  <a href={app.deploy.previewUrl} target="_blank" rel="noreferrer" className="sw-quiet-link" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>Open app UI ↗</a>
                </>
              ) : (
                <p className="hint" style={{ marginTop: 4 }}>
                  No live preview yet — provision a runner above. The URL appears once the pod is
                  ready; this shows the real deployed app, never a mock.
                </p>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/* ─────────────────────────── Publish (replaces Operate) ─────────────────────────── */

function PublishStage({
  app, surface, user, pipe, connTools, reviewCard,
  publishLabel, publishDisabled, inReview, onPublish, deployMsg,
  toolOut, toolNote, onCallTool, onOpenRepo,
  canPromoteUI, onPromote, canDemoteUI, demoteLabel, confirmDemoteLabel,
  confirmDemote, setConfirmDemote, onDemote, busy, onLifecycle, msg, onHealRepo,
  canEdit, onSetServeMode,
}: {
  app: SoftwareApp;
  surface: { ui: boolean; api: boolean };
  user: { id: string; role: SessionRole };
  pipe: PipelineView;
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
  msg: string;
  onHealRepo: () => void;
  canEdit: boolean;
  onSetServeMode: (mode: 'image' | 'runtime') => void;
}) {
  const version = app.deploy.releases > 0 ? `v${app.deploy.releases}` : 'Unpublished';
  const dep = deployBadge(app.deploy.state);
  const isRuntime = app.serveMode === 'runtime';
  // The OS runtime can only serve Vite-shaped SPAs — the same scope the server enforces.
  const runtimeEligible = app.template === 'sovereign-app' || app.template === 'vite-os' || app.template === 'empty' || app.template === 'website';

  // Structure — the governed control surface for the deployed app: publish a release, the
  // in-review card, and the promotion + lifecycle rungs. These are the direct-manipulation
  // controls the conversation reasons about (justify go-live, triage a finding).
  const structure = (
    <>
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

        {/* ── Phase D: OS runtime serving (beta) — honest, minimal opt-in ── */}
        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 8, alignItems: 'center', margin: 0 }}>
            <input
              type="checkbox"
              checked={isRuntime}
              disabled={!canEdit || busy || (!isRuntime && !runtimeEligible)}
              onChange={(e) => onSetServeMode(e.target.checked ? 'runtime' : 'image')}
            />
            <span style={{ fontSize: 13 }}>Runtime serving (beta)</span>
          </label>
          <span className="hint" style={{ margin: 0, fontSize: 12 }}>
            Served by the OS from the app&apos;s committed tree — no image build. Vite-shaped apps only.
          </span>
          {isRuntime ? (
            <a className="sw-quiet-link" href={`/api/apps/runtime/${app.slug}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              Open runtime app ↗
            </a>
          ) : null}
          {!isRuntime && !runtimeEligible ? (
            <span className="muted" style={{ fontSize: 12 }}>This app&apos;s shape can&apos;t be runtime-served.</span>
          ) : null}
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

      {/* Archive / Restore / Delete live in the persistent app header (reachable from any stage).
          Only the "Use as Data" action is stage-specific to Operate. */}
      <div className="section-title">Data integration</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn ghost" onClick={() => onLifecycle('use-as-data')} disabled={busy || app.usedAsData}>
          {app.usedAsData ? 'Used as Data ✓' : 'Use as Data'}
        </button>
        <span className={`badge ${app.status === 'active' ? 'ok' : 'muted'}`}>{app.status}</span>
      </div>
      {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}
    </>
  );

  return (
    <div {...anchorAttr(ANCHORS.software.publish)}>
      <StageConversation
        context={
          <>
            <span className="sc-scope">Publish</span>
            <span className={dep.cls}>{dep.label}</span>
            <span className="badge muted">{version}</span>
            <span className="sc-hint mono">{app.subdomain}</span>
            <span className="sc-hint sc-spacer">Publish, promote and run the live app — the conversation helps justify go-live &amp; triage it.</span>
          </>
        }
        structure={structure}
        conversation={
          <StageAssistantChat
            appId={app.id}
            stage="publish"
            intro="Explain scan findings, justify go-live, or triage the live app."
            starters={['Justify going live', 'Triage the live app']}
          />
        }
        outcome={
          <>
            {/* ── Live pod state — the deployed app, with its direct links ── */}
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

              {/* HONEST "no app link yet" reason — a UI app with no served URL is not a
                  silent blank: say WHY (the image build/runner hasn't produced a URL) and
                  point at the pipeline below, so Publish never looks broken when it's pending. */}
              {surface.ui && !app.deploy.previewUrl ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  {app.deploy.state === 'live'
                    ? 'Published — no live app URL yet: the container image build must succeed and the runner start serving before the link appears. Track the stages below (a failed stage shows the reason).'
                    : 'No app link yet — the app goes live after Publish is approved and the image build succeeds. Track progress in the stages below.'}
                </p>
              ) : null}

              {/* ── Live DEPLOY stepper — the SAME shared pipeline-view derivation Test reads,
                   rendered on the core ProgressStepper so a deploy/go-live is VISIBLE as it
                   runs (Scaffold → Build image → Registry → Deploy → Live), never a silent
                   badge flip. A real failure surfaces the marked stage here too. ── */}
              <div className="sw-health">
                <ProgressStepper
                  steps={pipe.steps}
                  active={pipe.active}
                  done={pipe.done}
                  ok={pipe.ok}
                  commentary={pipe.commentary}
                />
              </div>

              {/* REPO MISSING → manual heal. `pipeline.forgejo === 'failing'` is the honest
                  repo-404 signal (refreshActionsStage downgrades a vanished repo). Re-provisions
                  the scaffold so a subsequent build commits + rebuilds from a clean base. */}
              {app.pipeline.forgejo === 'failing' ? (
                <div className="hint" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>The app’s repository is missing (404) — CI cannot build until it is re-provisioned.</span>
                  <button className="btn ghost sm" onClick={onHealRepo} disabled={busy} title="Re-provision the missing repo from the scaffold + any surviving snapshot">
                    {busy ? <span className="spin" /> : 'Heal repository'}
                  </button>
                </div>
              ) : null}
            </div>

            {/* ── Governed tool-call surface — the app's MCP capabilities + real call output ── */}
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
          </>
        }
      />
    </div>
  );
}
