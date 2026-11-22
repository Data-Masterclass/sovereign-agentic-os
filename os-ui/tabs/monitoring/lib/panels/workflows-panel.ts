/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Workflows panels — the workflow store's lifecycle (draft · live · stale) and the approvals
 *             waiting on workflows, with how long they have waited
 * USER STORY: As a workflow owner or a domain admin I want to see which workflows are drafts, which are live, which
 *             were edited after going live, and which promotion requests have waited longest — and be told that runs
 *             are not recorded, instead of seeing a zero.
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Workflows = the Knowledge store's own scoped list (`listWorkflows`), injected through
 *     `sources.ts`; nothing is written and no run is started.
 *   - Lifecycle: `draft` and `live` are the record's own status; `stale` is a live workflow edited after it went live
 *     (`updatedAt` later than `publishedAt` by more than the few milliseconds one publish takes).
 *   - Approvals = the OS approvals store (`@core/policy/approvals`), kept to workflow promotions (artifactKind
 *     `knowledge`: the rung-1 `artifact_promote` and the rung-2 `promote_certify`) and narrowed by Governance's own
 *     `canSee` (admin all · builder and domain admin their domains · creator their own requests). A pending request's
 *     wait is now − createdAt; decided ones give the median createdAt → decidedAt.
 *   - Not available upstream (said in the payload): workflow runs. A workflow is process documentation and runs
 *     nothing; the run store (`run_jobs`) carries no workflow id, so no run can be attributed to one.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { ensureHydrated as ensureApprovalsHydrated, approvalsHydrationState, listApprovals, type Approval } from '@core/policy/approvals';
import { canSee } from '@core/policy/roles';
import { monitoringSources, SOURCES_MISSING, type KnowledgeRow } from '@tabs/monitoring/lib/panels/sources';
import { live, unavailable, type NotUpstream, type SourceState } from '@tabs/monitoring/lib/panels/panels-core';

export type WorkflowLifecycle = 'draft' | 'live' | 'stale';

export type WorkflowItem = {
  id: string;
  title: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  status: 'draft' | 'live';
  lifecycle: WorkflowLifecycle;
  certified: boolean;
  updatedAt: string;
  publishedAt: string | null;
  workflowUrl: string;
};

export type WorkflowApproval = {
  id: string;
  title: string;
  workflow: string;
  domain: string;
  requestedBy: string;
  kind: 'artifact_promote' | 'promote_certify';
  approverRole: string;
  since: string;
  waitingHours: number;
  approvalsUrl: string;
};

export type WorkflowsView = {
  view: 'workflows';
  generatedAt: string;
  sources: { inventory: SourceState; approvals: SourceState };
  summary: { total: number; draft: number; live: number; stale: number; certified: number; pendingApprovals: number | null; oldestWaitHours: number | null } | null;
  workflows: WorkflowItem[];
  approvals: { pending: WorkflowApproval[]; decided: { count: number; medianWaitHours: number | null; windowDays: number } };
  /** How the lifecycle is derived, so a reviewer can check it. */
  definitions: { stale: string };
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'Workflow runs', reason: 'A workflow is process documentation and runs nothing, and the run store (run_jobs) carries no workflow id, so no run can be attributed to a workflow. Runs of agent systems are in Monitoring → Agents.' },
];

/** One publish writes `publishedAt` and `updatedAt` a few ms apart; anything beyond this is a real edit. */
const EDIT_TOLERANCE_MS = 250;
/** How far back decided requests count towards the median. */
const DECIDED_WINDOW_DAYS = 30;

export function lifecycleOf(r: Pick<KnowledgeRow, 'status' | 'updatedAt' | 'publishedAt'>): WorkflowLifecycle {
  if (r.status === 'draft') return 'draft';
  if (r.publishedAt && Date.parse(r.updatedAt) - Date.parse(r.publishedAt) > EDIT_TOLERANCE_MS) return 'stale';
  return 'live';
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const hours = (fromIso: string, toMs: number): number => Math.max(0, Math.round(((toMs - Date.parse(fromIso)) / 3600_000) * 10) / 10);
const isWorkflowPromotion = (a: Approval): a is Approval & { kind: 'artifact_promote' | 'promote_certify' } =>
  (a.kind === 'artifact_promote' || a.kind === 'promote_certify') && a.payload?.artifactKind === 'knowledge';

export async function workflowsView(user: CurrentUser, nowMs = Date.now()): Promise<WorkflowsView> {
  const src = monitoringSources();
  const listed = src?.knowledge
    ? await src.knowledge({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the Workflows reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  const workflows: WorkflowItem[] = (listed.ok ? listed.rows : []).map((r) => ({
    id: r.id, title: r.title, domain: r.domain, scope: r.scope, status: r.status, lifecycle: lifecycleOf(r), certified: r.certified,
    updatedAt: r.updatedAt, publishedAt: r.publishedAt,
    workflowUrl: `/knowledge?workflow=${encodeURIComponent(r.id)}`,
  }));
  const order: Record<WorkflowLifecycle, number> = { stale: 0, draft: 1, live: 2 };
  workflows.sort((a, b) => order[a.lifecycle] - order[b.lifecycle] || a.title.localeCompare(b.title));

  const actor = { id: user.id, domains: user.domains, role: user.role };
  const approvals = await (async () => {
    try {
      await ensureApprovalsHydrated();
      if (approvalsHydrationState() !== 'hydrated') throw new Error('the approvals are not loaded — the store could not be read from OpenSearch');
      return { ok: true as const, all: listApprovals().filter((a) => isWorkflowPromotion(a) && canSee(actor, a)) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  const pending: WorkflowApproval[] = approvals.ok
    ? approvals.all
        .filter((a) => a.status === 'pending')
        .map((a) => ({
          id: a.id, title: a.title, workflow: String(a.payload?.name ?? a.payload?.id ?? ''), domain: a.domain, requestedBy: a.requestedBy,
          kind: a.kind as 'artifact_promote' | 'promote_certify', approverRole: a.approverRole, since: a.createdAt, waitingHours: hours(a.createdAt, nowMs),
          approvalsUrl: `/governance?approval=${encodeURIComponent(a.id)}`,
        }))
        .sort((x, y) => y.waitingHours - x.waitingHours)
    : [];
  const since = nowMs - DECIDED_WINDOW_DAYS * 86_400_000;
  const decided = approvals.ok
    ? approvals.all.filter((a) => (a.status === 'approved' || a.status === 'rejected') && a.decidedAt && Date.parse(a.decidedAt) >= since)
    : [];
  const waits = decided.map((a) => (Date.parse(a.decidedAt!) - Date.parse(a.createdAt)) / 3600_000);
  const med = median(waits);

  return {
    view: 'workflows',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`workflows: ${listed.error}`), approvals: approvals.ok ? live : unavailable(`approvals: ${approvals.error}`) },
    summary: listed.ok
      ? {
          total: workflows.length,
          draft: workflows.filter((w) => w.lifecycle === 'draft').length,
          live: workflows.filter((w) => w.lifecycle === 'live').length,
          stale: workflows.filter((w) => w.lifecycle === 'stale').length,
          certified: workflows.filter((w) => w.certified).length,
          pendingApprovals: approvals.ok ? pending.length : null,
          oldestWaitHours: approvals.ok && pending.length ? pending[0].waitingHours : null,
        }
      : null,
    workflows,
    approvals: { pending, decided: { count: decided.length, medianWaitHours: med === null ? null : Math.round(med * 10) / 10, windowDays: DECIDED_WINDOW_DAYS } },
    definitions: { stale: 'A live workflow edited after it went live: its updatedAt is later than its publishedAt.' },
    notUpstream: NOT_UPSTREAM,
  };
}
