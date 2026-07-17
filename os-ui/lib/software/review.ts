/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import {
  getAppByIdInternal,
  persistApp,
  templateFiles,
  newId,
  withStatus,
  type App,
} from '@/lib/software/apps';
import { trace } from '@/lib/infra/agent-governed';
import { enqueue, decide as decideApproval, listApprovals } from '@/lib/governance/approvals';
import { securityScan } from './scan.ts';
import { detectSurface } from './metadata.ts';
import { getSnapshot } from './server.ts';
import { deployApp, runnerStatus, type RunnerApp, type RunnerOutcome, type RunnerStatus } from './runner.ts';
import { roleAtLeast } from '@/lib/core/session';
import { config } from '@/lib/core/config';

/** The app's live host, ALWAYS computed from the CURRENT apps domain — not the
 *  `app.subdomain` stored at creation time (which may carry a stale default like
 *  `apps.local` for apps created before OS_APPS_DOMAIN was configured). This keeps
 *  the served Ingress host + the UI link on the real, resolvable wildcard domain. */
function appHost(app: App): string {
  return `${app.slug}.${app.domain}.${config.appsBaseDomain}`;
}
import type {
  DeployEnvelope,
  DiffSummary,
  ResourceFootprint,
  ReviewCard,
  ScaffoldFile,
} from './model.ts';

/**
 * The deploy review gate (Software golden path §D) — the platform's top deploy
 * security control and an Opus-owned, explicitly-tested invariant:
 *
 *   • PREVIEW IS FREE. The creator runs a private sandbox preview themselves
 *     (`startPreview`); no review.
 *   • GOING LIVE IN THE DOMAIN IS BUILDER-REVIEWED. `requestDeploy` assembles a
 *     review card — security scan + the governed resources the app declares +
 *     its cost/resource footprint + the change diff — and routes it to a Builder.
 *   • A NON-BUILDER CANNOT APPROVE (`decideDeploy` role gate → 403).
 *   • Review the FIRST deploy and any SCOPE-BROADENING change; ROUTINE updates
 *     inside the approved envelope auto-deploy without re-review.
 *   • A failing security scan (secret leak / high/critical) BLOCKS approval.
 *
 * This holds regardless of which front door requested the deploy (chat, Platform
 * MCP, git push, git import) — they all converge here. Cards live in-process
 * (authoritative locally) and also land in the Governance approval inbox.
 */

const CARDS_KEY = Symbol.for('soa.software.review');
function cards(): Map<string, ReviewCard> {
  const g = globalThis as unknown as Record<symbol, Map<string, ReviewCard> | undefined>;
  if (!g[CARDS_KEY]) g[CARDS_KEY] = new Map();
  return g[CARDS_KEY]!;
}

// Per-runtime cost/resource footprint surfaced on the card (rough monthly USD).
const FOOTPRINT: Record<App['template'], ResourceFootprint> = {
  'nextjs-supabase': { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
  service: { cpu: '100m', memory: '128Mi', estMonthlyUsd: 6 },
  script: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 2 },
  dashboard: { cpu: '200m', memory: '256Mi', estMonthlyUsd: 10 },
};

function isBuilder(user: CurrentUser): boolean {
  return roleAtLeast(user.role, 'builder');
}

/** The minimal runnable shape the in-cluster runner needs, derived from an app. */
function runnerAppFor(app: App): RunnerApp {
  return {
    slug: app.slug,
    host: appHost(app),
    runImage: app.runImage,
    footprint: FOOTPRINT[app.template] ?? FOOTPRINT['nextjs-supabase'],
  };
}

/**
 * Reflect the REAL runner outcome onto the app's deploy fields — honestly. When
 * the cluster is unreachable we leave `previewUrl` null and `pipeline.live`
 * `pending` (never fabricate a live URL); the served URL only appears once the
 * pod is actually `running` (the status route reconciles it as readiness lands).
 */
function applyRunnerOutcome(app: App, outcome: RunnerOutcome): void {
  if (!outcome.live) {
    app.deploy.previewUrl = null;
    app.pipeline.live = 'pending';
    return;
  }
  const running = outcome.phase === 'running';
  app.deploy.previewUrl = running ? outcome.url : null;
  app.pipeline.live = running ? 'ok' : 'pending';
}

/** The exact governed scope a deploy is asking for (the envelope under review). */
export function requestedEnvelope(app: App): DeployEnvelope {
  return {
    writeTools: app.mcpTools.filter((t) => t.write).map((t) => t.name).sort(),
    connections: [...app.manifest.connections, ...app.consumes.filter((c) => c.kind === 'connection').map((c) => c.ref)]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort(),
    data: [...app.manifest.data].sort(),
    knowledge: [...app.manifest.knowledge].sort(),
    footprint: FOOTPRINT[app.template] ?? FOOTPRINT['nextjs-supabase'],
  };
}

/**
 * Does the requested scope BROADEN the approved one? True if it adds any write
 * tool, connection, data product, or knowledge grant, or raises the cost
 * footprint. Routine updates (subset of the approved envelope) return false and
 * auto-deploy. This is the "routine-update envelope" decision made concrete.
 */
export function scopeBroadened(approved: DeployEnvelope | null, requested: DeployEnvelope): boolean {
  if (!approved) return true; // first deploy always reviews
  const broadensList = (a: string[], b: string[]) => b.some((x) => !a.includes(x));
  return (
    broadensList(approved.writeTools, requested.writeTools) ||
    broadensList(approved.connections, requested.connections) ||
    broadensList(approved.data, requested.data) ||
    broadensList(approved.knowledge, requested.knowledge) ||
    requested.footprint.estMonthlyUsd > approved.footprint.estMonthlyUsd
  );
}

function diffFromFiles(files: ScaffoldFile[], changed?: DiffSummary['files']): DiffSummary {
  const list =
    changed ??
    files.map((f) => ({ path: f.path, added: f.content.split('\n').length, removed: 0 }));
  return {
    files: list,
    added: list.reduce((n, f) => n + f.added, 0),
    removed: list.reduce((n, f) => n + f.removed, 0),
  };
}

/** Gather the app's repo files for the scan/diff: the latest committed snapshot
 *  if there is one (so the scan sees what was committed), else the template seed. */
function appFiles(app: App): ScaffoldFile[] {
  return getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
}

// --------------------------------------------------------------- Preview -------

/**
 * The HONEST preview note used when the in-cluster runner is UNREACHABLE (a
 * laptop with no cluster). The build + commit loop is real either way; when the
 * k8s API cannot be reached the runner provisions nothing and we NEVER fabricate
 * a URL. When a cluster IS reachable, `startPreview`/`decideDeploy` provision a
 * real Deployment+Service+Ingress and the served URL appears once the pod is ready.
 */
export const PREVIEW_PENDING_NOTE =
  'Preview runner unreachable — your commits are real, but no in-cluster runner could be provisioned; ' +
  'the served preview URL is pending until the Kubernetes API is reachable.';

/**
 * Honest pending-preview note. Distinguishes the two very different pending
 * states so we never claim "runner unreachable / API not reachable" when the
 * app IS provisioned and we're simply waiting on the image:
 *   • cluster unreachable (phase offline)  → PREVIEW_PENDING_NOTE
 *   • provisioned, pod not yet running     → image build in progress
 */
function previewPendingNote(outcome: RunnerOutcome): string {
  if (!outcome.live) return PREVIEW_PENDING_NOTE;
  return (
    'Image build in progress — the app is provisioned and the preview URL appears once CI ' +
    'publishes the image and the pod becomes ready.'
  );
}

/**
 * Start a PRIVATE sandbox preview the creator runs themselves — no review. Any
 * owner (or a Builder in the domain) can preview. This is the free-iteration
 * loop; only going live in the domain is gated. Phase 2: this provisions the REAL
 * in-cluster runner (Deployment+Service+Ingress); the served URL surfaces once
 * the pod is ready. Offline (no cluster) it stays honestly pending (no URL).
 */
export async function startPreview(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder = app.owner === user.id || (isBuilder(user) && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can preview this app'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot run a preview'), 409);
  app.deploy.state = app.deploy.state === 'live' ? 'live' : 'preview';

  // Provision the real runner; reflect its outcome honestly (no fake URL offline).
  const runner = await deployApp(runnerAppFor(app));
  applyRunnerOutcome(app, runner);
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'start_preview', by: user.id },
    output:
      runner.live && runner.phase === 'running'
        ? { preview: runner.phase, url: app.deploy.previewUrl, host: runner.host }
        : { preview: runner.live ? runner.phase : 'pending-runner', note: previewPendingNote(runner) },
    decision: 'allow',
  });
  return app;
}

// ---------------------------------------------------------- Request deploy -----

/** The just-filed Governance approval, minimally described for the UI's shared
 *  "this needs approval" notice (Policies & Approvals link + inline-approve gate). */
export type FiledApprovalRef = { id: string; domain: string; approverRole: 'builder' | 'domain_admin' | 'admin'; scope: 'own' | 'domain' | 'tenant' };

export type DeployRequestResult =
  | { kind: 'auto-deployed'; app: App }
  | { kind: 'review'; app: App; card: ReviewCard; approval: FiledApprovalRef };

/**
 * Request a domain deploy. Routine in-envelope updates to an already-live app
 * auto-deploy; the first deploy and any scope-broadening change open a Builder
 * review card. The creator can call this; a Builder approves it.
 */
export async function requestDeploy(
  appId: string,
  user: CurrentUser,
  opts: { changedFiles?: DiffSummary['files']; scanMode?: 'live' | 'offline-mock' } = {},
): Promise<DeployRequestResult> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  if (app.owner !== user.id && !isBuilder(user)) {
    throw withStatus(new Error('Only the creator or a Builder can request a deploy'), 403);
  }
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot deploy'), 409);

  // Detect the app's UI/API surface at deploy from the code + manifest the agent
  // wrote (the deploy manifest reveals whether it binds a web server vs only an
  // API), so the monitor view is honest to what actually ships.
  app.surface = detectSurface(appFiles(app));

  const requested = requestedEnvelope(app);
  const broadened = scopeBroadened(app.deploy.approved, requested);
  // The security scan runs on EVERY deploy request (CI scans every push). A
  // routine update can only auto-deploy when it is BOTH in-envelope AND clean.
  const scan = securityScan(appFiles(app), opts.scanMode ?? 'offline-mock');

  // Routine update within the approved envelope + a clean scan → auto-deploy.
  if (app.deploy.state === 'live' && !broadened && scan.passed) {
    app.deploy.reviewCardId = null;
    app.deploy.releases += 1; // a routine update ships a new release/version.
    // Roll the new release onto the real runner (idempotent replace).
    applyRunnerOutcome(app, await deployApp(runnerAppFor(app)));
    await persistApp(app);
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'request_deploy', by: user.id, routine: true },
      output: { autoDeployed: true, envelope: requested },
      decision: 'allow',
    });
    return { kind: 'auto-deployed', app };
  }

  // First deploy, scope-broadening change, OR a scan finding → Builder review card.
  const card: ReviewCard = {
    id: newId('rev'),
    appId: app.id,
    appName: app.name,
    domain: app.domain,
    requestedBy: user.id,
    requestedAt: new Date().toISOString(),
    reason: app.deploy.approved ? 'scope-broadened' : 'first-deploy',
    scan,
    requested,
    diff: diffFromFiles(appFiles(app), opts.changedFiles),
    decision: 'pending',
  };
  cards().set(card.id, card);

  app.deploy.state = 'review';
  app.deploy.reviewCardId = card.id;
  await persistApp(app);

  // Surface in the Governance inbox so a Domain admin sees it alongside other holds.
  const approval = enqueue({
    kind: 'app_deploy',
    title: `Deploy review: ${app.name}`,
    detail:
      `${card.reason === 'first-deploy' ? 'First deploy' : 'Scope-broadening change'} — ` +
      `scan ${scan.passed ? 'passed' : 'FAILED'} (${scan.findings.length} findings), ` +
      `${requested.connections.length} connections, ${requested.writeTools.length} write tools, ` +
      `~$${requested.footprint.estMonthlyUsd}/mo.`,
    agent: app.mcpPrincipal,
    domain: app.domain,
    requestedBy: user.id,
    tool: 'request_deploy',
    payload: { appId: app.id, cardId: card.id },
    approverRole: 'domain_admin',
  });

  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'request_deploy', by: user.id, reason: card.reason },
    output: { cardId: card.id, scanPassed: scan.passed },
    decision: scan.passed ? 'requires_approval' : 'deny',
  });
  return {
    kind: 'review',
    app,
    card,
    approval: { id: approval.id, domain: approval.domain, approverRole: approval.approverRole, scope: approval.scope },
  };
}

// ----------------------------------------------------------- Decide deploy -----

/**
 * Approve or deny a deploy. THE ROLE GATE: only a Builder/Admin in the app's
 * domain may decide — a Creator/non-Builder gets 403. Approval additionally
 * REQUIRES a passing security scan (a leaked secret / high finding blocks the
 * go-live). On approval the app goes live and the approved envelope is recorded
 * so later in-envelope updates auto-deploy.
 */
export async function decideDeploy(
  cardId: string,
  user: CurrentUser,
  decision: 'approve' | 'deny',
  note?: string,
): Promise<{ app: App; card: ReviewCard }> {
  const card = cards().get(cardId);
  if (!card) throw withStatus(new Error('Review card not found'), 404);
  if (card.decision !== 'pending') throw withStatus(new Error('This review is already decided'), 409);

  // The gate: a non-Builder cannot approve OR deny a deploy.
  if (!isBuilder(user) || !user.domains.includes(card.domain)) {
    throw withStatus(new Error('Only a Builder or Administrator in this domain can review a deploy'), 403);
  }

  const app = await getAppByIdInternal(card.appId);
  if (!app) throw withStatus(new Error('App not found'), 404);

  if (decision === 'approve') {
    if (!card.scan.passed) {
      throw withStatus(
        new Error('Cannot approve: the security scan did not pass (fix the findings and re-request).'),
        409,
      );
    }
    card.decision = 'approved';
    app.deploy.state = 'live';
    app.deploy.approved = card.requested;
    app.deploy.reviewCardId = null;
    app.deploy.releases += 1; // approved go-live ships a new release/version.
    // Provision the real in-cluster runner on the app's per-app host; the served
    // URL + `pipeline.live = ok` only land once the pod is actually running
    // (offline stays honestly pending — the go-live decision is still recorded).
    applyRunnerOutcome(app, await deployApp(runnerAppFor(app)));
  } else {
    card.decision = 'denied';
    app.deploy.state = 'preview'; // back to the free preview loop to fix it
    app.deploy.reviewCardId = null;
  }
  card.decidedBy = user.id;
  card.decidedAt = new Date().toISOString();
  card.note = note;
  cards().set(card.id, card);
  await persistApp(app);

  // Reflect the decision into the Governance inbox record.
  for (const a of listGovernanceForCard(card.id)) decideApproval(a, decision === 'approve' ? 'approve' : 'reject', user.id);

  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'decide_deploy', by: user.id, role: user.role, decision },
    output: { cardId: card.id, state: app.deploy.state },
    decision: decision === 'approve' ? 'allow' : 'deny',
  });
  return { app, card };
}

// Link Governance approval ids back to a card (best-effort; in-process).
function listGovernanceForCard(cardId: string): string[] {
  return listApprovals({ status: 'pending' })
    .filter((a) => a.kind === 'app_deploy' && (a.payload as { cardId?: string })?.cardId === cardId)
    .map((a) => a.id);
}

// ------------------------------------------------------- Runner status poll ----

/**
 * Poll the app's REAL in-cluster runner status and reconcile the deploy fields
 * off ACTUAL pod state (the `deploying → running → failed` transition is driven
 * by the Deployment's readyReplicas/conditions, never a timer). The served URL
 * only appears once the pod is `running`; a failed rollout marks `pipeline.live`
 * accordingly. Offline (no cluster) mutates nothing — it cannot confirm state.
 */
export async function reconcileDeployStatus(
  appId: string,
  user: CurrentUser,
): Promise<{ app: App; status: RunnerStatus }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder = app.owner === user.id || (isBuilder(user) && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator or a Builder can read this app runner status'), 403);

  const status = await runnerStatus({ slug: app.slug });
  if (status.live) {
    const running = status.phase === 'running';
    app.deploy.previewUrl = running ? `https://${appHost(app)}` : null;
    if (app.deploy.state === 'live') {
      app.pipeline.live = running ? 'ok' : status.phase === 'failed' ? 'offline' : 'pending';
    }
    await persistApp(app);
  }
  return { app, status };
}

// ------------------------------------------------------------- Readers ---------

export function getReviewCard(cardId: string): ReviewCard | null {
  return cards().get(cardId) ?? null;
}

export function listReviewCards(opts: { domain?: string; pendingOnly?: boolean } = {}): ReviewCard[] {
  return [...cards().values()]
    .filter((c) => (opts.domain ? c.domain === opts.domain : true))
    .filter((c) => (opts.pendingOnly ? c.decision === 'pending' : true))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}
