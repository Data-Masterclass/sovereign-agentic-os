/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import {
  getAppByIdInternal,
  persistApp,
  templateFiles,
  newId,
  withStatus,
  type App,
} from '@/lib/apps';
import { trace } from '@/lib/agent-governed';
import { enqueue, decide as decideApproval, listApprovals } from '@/lib/approvals';
import { securityScan } from './scan.ts';
import { detectSurface } from './metadata.ts';
import { getSnapshot } from './server.ts';
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
  return user.role === 'builder' || user.role === 'admin';
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
 * The HONEST preview/deploy state for Phase 1. The build + commit loop is real
 * (real Forgejo commits), but no in-cluster runner serves a preview or live
 * workload yet — so we NEVER fabricate a URL (the old `…sandbox.local` host was
 * unresolvable). Preview enters the private iterate state; the served workload is
 * explicitly pending. Phase 2 wires the real runner and fills these URLs.
 */
export const PREVIEW_PENDING_NOTE =
  'Preview is not yet available — the in-cluster preview runner ships in the next release. ' +
  'Your commits are real; the served preview URL is pending.';

/**
 * Start a PRIVATE sandbox preview the creator runs themselves — no review. Any
 * owner (or a Builder in the domain) can preview. This is the free-iteration
 * loop; only going live in the domain is gated. Phase 1: this marks the app as
 * previewing but reports the runner as PENDING (no fabricated URL).
 */
export async function startPreview(appId: string, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder = app.owner === user.id || (isBuilder(user) && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can preview this app'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot run a preview'), 409);
  app.deploy.state = app.deploy.state === 'live' ? 'live' : 'preview';
  // Honest: no runner yet → no URL. Do not claim a working preview.
  app.deploy.previewUrl = null;
  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'start_preview', by: user.id },
    output: { preview: 'pending-runner', note: PREVIEW_PENDING_NOTE },
    decision: 'allow',
  });
  return app;
}

// ---------------------------------------------------------- Request deploy -----

export type DeployRequestResult =
  | { kind: 'auto-deployed'; app: App }
  | { kind: 'review'; app: App; card: ReviewCard };

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

  // Surface in the Governance inbox so a Builder sees it alongside other holds.
  enqueue({
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
  });

  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'request_deploy', by: user.id, reason: card.reason },
    output: { cardId: card.id, scanPassed: scan.passed },
    decision: scan.passed ? 'requires_approval' : 'deny',
  });
  return { kind: 'review', app, card };
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
    app.pipeline.live = 'ok';
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
