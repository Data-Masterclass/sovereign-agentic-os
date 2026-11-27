/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import {
  getAppByIdInternal,
  getAppForUser,
  persistApp,
  serveModeOf,
  templateFiles,
  newId,
  withStatus,
  type App,
} from '@tabs/software/lib/apps';
import { osMirror } from '@core/infra/os-mirror';
import { trace } from '@core/infra/agent-governed';
import {
  enqueue,
  decide as decideApproval,
  listApprovals,
  recordEffect,
  ensureHydrated as ensureApprovalsHydrated,
  AUDITED_OVERRIDE_REASON_MIN,
} from '@core/policy/approvals';
import { record as recordAudit } from '@core/policy/audit';
import { resolveScan, type ResolveScanOpts } from '@tabs/software/lib/scan';
import { gatePolicyFor } from '@tabs/software/lib/gate-policy';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { acquireGateSlot } from '@tabs/software/lib/gates-limits';
import type { GateVerdict } from '@tabs/software/lib/gates';
import { verdictOfRecord, recordVerdict, recordFor, withResult, type CheckRecord, type CheckTrigger } from '@tabs/software/lib/check-record';
import { defaultChecksRunner, type ChecksRunner } from '@tabs/software/lib/tekton-checks';
import { resolveSurface } from '@tabs/software/lib/metadata';
import { ungrantedDatasetWarningForApp } from '@tabs/software/lib/dataset-guard';
import { getSnapshot, hydrateSnapshot } from '@tabs/software/lib/snapshot';
import { assertNotSeeded } from '@tabs/software/lib/seeded-evidence';
import { readAppTreeState, appProjectGitEnabled } from '@tabs/software/lib/git-commit';
import { deployApp, runnerStatus, type RunnerApp, type RunnerOpts, type RunnerOutcome, type RunnerStatus } from '@tabs/software/lib/runner';
import { roleAtLeast } from '@core/kernel/session';
import { config } from '@core/kernel/config';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { canReview, currentGoLiveRules, goLiveDecision, scopeOfVisibility, type GoLiveScope } from '@core/policy/go-live-rules';
import { goLiveReviewerNotice } from '@core/policy/go-live-reviewers';
import { appResourceName, type AppRelease } from '@tabs/software/lib/app-builder-contracts';
import { deploymentStatus } from '@tabs/software/lib/runner';
import { currentRelease } from '@tabs/software/lib/releases/store';
import { envNamespaceOf, releaseUrl, rolloutRelease, type RolloutDeps } from '@tabs/software/lib/releases/rollout';
import { IMAGE_SCAN_CHECK } from '@tabs/software/lib/releases/auto-dev';
import { wakePreviews } from '@tabs/software/lib/releases/previews';
import { deleteLegacyAfterProd } from '@tabs/software/lib/releases/needs-rebuild';
import { unreviewedBlocksGoLive } from '@tabs/software/lib/stories/posthoc';

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
  ScanCategory,
  ScanMode,
  ScanResult,
  ScaffoldFile,
} from '@tabs/software/lib/model';

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
 * MCP, git import) — they all converge here. Cards are in-process
 * authoritative with a best-effort DURABLE mirror (`os-software-reviews`, the
 * same osMirror pattern as approvals) so a pod restart no longer empties the
 * `/software/reviews` inbox and loses the scan/diff; they also land in the
 * Governance approval inbox.
 */

const CARDS_KEY = Symbol.for('soa.software.review');
function cards(): Map<string, ReviewCard> {
  const g = globalThis as unknown as Record<symbol, Map<string, ReviewCard> | undefined>;
  if (!g[CARDS_KEY]) g[CARDS_KEY] = new Map();
  return g[CARDS_KEY]!;
}

// Durable mirror + one-shot hydration (rebuild the in-process map on first read
// after a pod roll). Best-effort: an unreachable mirror leaves cards in-memory.
const cardsMirror = osMirror({ index: 'os-software-reviews' });
const CARDS_HYDRATION_KEY = Symbol.for('soa.software.review.hydration');
function cardsHydration(): { p: Promise<void> | null } {
  const g = globalThis as unknown as Record<symbol, { p: Promise<void> | null } | undefined>;
  if (!g[CARDS_HYDRATION_KEY]) g[CARDS_HYDRATION_KEY] = { p: null };
  return g[CARDS_HYDRATION_KEY]!;
}
async function ensureCardsHydrated(): Promise<void> {
  const ref = cardsHydration();
  if (!ref.p) {
    ref.p = (async () => {
      const docs = (await cardsMirror.hydrate(2000)) ?? [];
      for (const c of docs as ReviewCard[]) {
        // Never clobber a card created in-process before hydration completed.
        if (c && c.id && !cards().has(c.id)) cards().set(c.id, c);
      }
    })();
  }
  return ref.p;
}
function saveCard(card: ReviewCard): void {
  cards().set(card.id, card);
  cardsMirror.writeThrough(card.id, card);
}

/** Test-only: drop the in-process cards + hydration state (fresh-pod simulation). */
export function __resetReviewCards(): void {
  cards().clear();
  cardsHydration().p = null;
  cardsMirror.__reset();
}

// Per-runtime cost/resource footprint surfaced on the card (rough monthly USD).
const FOOTPRINT: Record<App['template'], ResourceFootprint> = {
  'nextjs-supabase': { cpu: '250m', memory: '256Mi', estMonthlyUsd: 12 },
  'vite-os': { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  'sovereign-app': { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  website: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  'api-service': { cpu: '100m', memory: '128Mi', estMonthlyUsd: 6 },
  'nextjs-web': { cpu: '100m', memory: '256Mi', estMonthlyUsd: 8 },
  empty: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 3 },
  service: { cpu: '100m', memory: '128Mi', estMonthlyUsd: 6 },
  script: { cpu: '50m', memory: '64Mi', estMonthlyUsd: 2 },
  dashboard: { cpu: '200m', memory: '256Mi', estMonthlyUsd: 10 },
};

function isBuilder(user: CurrentUser): boolean {
  return roleAtLeast(user.role, 'builder');
}

/**
 * The runner's view of an app: its name, host and its tree AS COMMITTED IN GIT (WP-54). The
 * deploy applies the `k8s/` manifests of that tree — never the mirror cache, never a template —
 * so a git read failure is a refusal, not a fallback.
 */
async function runnerAppFor(app: App, ref?: string): Promise<RunnerApp> {
  const state = await readAppTreeState(app, ref ? { ref } : {});
  const tree: RunnerApp['tree'] =
    state.kind === 'tree'
      ? state.truncated
        ? { kind: 'failed', reason: 'the app tree is larger than one bounded read; it was not deployed from a partial tree' }
        : { kind: 'tree', files: state.files, sha: ref ?? state.sha }
      : state;
  return { slug: app.slug, host: appHost(app), tree, ...(app.domain ? { live: { repo: app.domain, id: app.id } } : {}) };
}

/** The commit an image app's tree is at right now (pinned on a deploy request). */
async function currentAppSha(app: App): Promise<string | null> {
  if (serveModeOf(app) !== 'image') return null;
  const state = await readAppTreeState(app);
  return state.kind === 'tree' && state.sha ? state.sha : null;
}

/**
 * PIN FIRST. The commit a deploy request is for: the app's current commit in git; or, when git holds
 * no tree for the app yet (a fresh scaffold lives only in the file cache), that tree committed now as
 * the requester, so the review and the deploy both read one commit. `null` when there is no git.
 */
async function pinCommitForReview(app: App, user: CurrentUser): Promise<string | null> {
  if (serveModeOf(app) !== 'image' || !appProjectGitEnabled()) return null;
  const state = await readAppTreeState(app);
  if (state.kind === 'tree') return state.sha || null;
  if (state.kind === 'failed') return null; // pinnedTreeForReview refuses with the reason below
  const { commitAppTree } = await import('@tabs/software/lib/git-commit');
  const out = await commitAppTree(app, user, await appFilesForScan(app), { action: 'request_deploy', reason: 'pin the reviewed tree' });
  return out.ok && out.recorded ? out.sha : null;
}

/** The app tree at the pinned commit, read from git; a review of anything else is refused. */
async function pinnedTreeForReview(app: App, sha: string | null): Promise<ScaffoldFile[]> {
  const state = sha ? await readAppTreeState(app, { ref: sha }) : null;
  if (!sha || !state || state.kind !== 'tree' || state.truncated) {
    throw withStatus(
      new Error(
        'This app has no readable commit in its domain repository, so there is nothing to review: an image app is ' +
          'reviewed and deployed only as a git commit. Commit the app (push_app_files), then request the deploy again.',
      ),
      409,
    );
  }
  return state.files;
}

/** True when the app's tree is still at the commit a review was filed for. */
async function stillAtReviewedCommit(app: App, cardSha: string | null | undefined): Promise<boolean> {
  // No domain git: nothing is pinned and nothing can deploy (deployApproved needs an approved commit).
  if (serveModeOf(app) !== 'image' || !appProjectGitEnabled()) return true;
  return !!cardSha && (await currentAppSha(app)) === cardSha;
}

export const APPROVAL_REQUIRED_NOTE =
  'This app runs its committed k8s/ manifests only after a Builder approved that exact commit: ' +
  'request_deploy, then a Builder in the domain decides with decide_deploy. Nothing was applied.';

/**
 * WP-54: THE ONLY door to the runner. It applies the Builder-APPROVED commit's manifests and
 * nothing else; with no approved commit it refuses with zero Kubernetes calls. A Creator alone
 * therefore can never put a manifest on the cluster — not by preview, not by re-deploy, not by
 * the status self-heal.
 */
async function deployApproved(app: App, opts: RunnerOpts = {}): Promise<RunnerOutcome> {
  const sha = app.deploy.approvedSha;
  if (!sha) {
    return { ok: false, live: false, action: 'noop', name: `app-${app.slug}`, host: appHost(app), url: null, phase: 'failed', detail: APPROVAL_REQUIRED_NOTE };
  }
  return deployApp(await runnerAppFor(app, sha), opts);
}

/**
 * Reflect the REAL runner outcome onto the app's deploy fields — honestly. When
 * the cluster is unreachable we leave `previewUrl` null (never fabricate a live
 * URL); the served URL only appears once the pod is actually `running` (the status
 * route reconciles it as readiness lands).
 */
function applyRunnerOutcome(app: App, outcome: RunnerOutcome): void {
  if (!outcome.live) {
    app.deploy.previewUrl = null;
    return;
  }
  app.deploy.previewUrl = outcome.phase === 'running' ? outcome.url : null;
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

/**
 * Gather the app's source files for the scan/diff — the code that will ACTUALLY
 * ship: the durable source tree (every governed commit AND every editor save lands
 * there), else the template seed for an app with no tree yet. Hydrated from the
 * mirror first so a scan after a restart sees the app's REAL last committed tree.
 */
async function appFilesForScan(app: App): Promise<ScaffoldFile[]> {
  await hydrateSnapshot(app.id);
  return getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug, app.templateVersion);
}

// --------------------------------------------------------------- Preview -------

/**
 * The HONEST preview note used when the in-cluster runner is UNREACHABLE (a
 * laptop with no cluster). The build + commit loop is real either way; when the
 * k8s API cannot be reached the runner provisions nothing and we NEVER fabricate
 * a URL. When a cluster IS reachable, `startPreview`/`decideDeploy` provision a
 * real Deployment+Service+Ingress and the served URL appears once the pod is ready.
 */
export { deployStatusOf, declarativePreviewNote, isDeclarative } from '@tabs/software/lib/deploy-status';

export const PREVIEW_PENDING_NOTE =
  'Preview runner unreachable — your commits are real, but no in-cluster runner could be provisioned; ' +
  'the served preview URL is pending until the Kubernetes API is reachable.';

/**
 * Honest pending-preview note. Distinguishes the two very different pending
 * states so we never claim "runner unreachable / API not reachable" when the
 * app IS provisioned and we're simply waiting on the pod:
 *   • cluster unreachable (phase offline)  → PREVIEW_PENDING_NOTE
 *   • provisioned, pod not yet running     → image pull / start in progress
 */
export const IMAGE_BUILDING_NOTE =
  'Image build in progress — the app is provisioned and the preview URL appears once ' +
  'its image is available and the pod becomes ready.';

/**
 * THE DEFECT THIS CLOSES (2026-11-19). A FAIL-CLOSED runner refusal — today the only one is
 * a WP-54 deploy refusal (no committed k8s/ manifests, image not built), which `deployApp` returns as
 * `{ ok:false, live:false, phase:'failed', detail:<the honest reason> }` — fell through to
 * `PREVIEW_PENDING_NOTE` because that branch keys on `live`. The user was therefore told
 * "Preview runner unreachable … pending until the Kubernetes API is reachable" when the
 * Kubernetes API was fine and the app simply had no image, and `detail` was discarded. A
 * configuration problem reported as an outage sends the operator to debug the wrong thing.
 *
 * So: an explained `failed` outcome says what it says. Only a genuinely silent cluster gets
 * the unreachable note.
 */
function previewPendingNote(outcome: RunnerOutcome): string {
  if (outcome.phase === 'failed' && outcome.detail) return outcome.detail;
  return outcome.live ? IMAGE_BUILDING_NOTE : PREVIEW_PENDING_NOTE;
}

/**
 * The honest preview note for a status READ (get_software_status), derived from the
 * FRESH runner poll (0.6.114): a `running` pod is SERVED — no note ('' — its URL stands
 * on its own); a provisioned-but-not-yet-running pod (deploying/absent, `live` true) is
 * honestly "image build in progress"; a genuinely offline cluster is the unreachable note.
 * A null status (reconcile unavailable — e.g. a non-owner read) falls back to the
 * unreachable note so a stale null URL is never dressed up as served.
 */
export function previewNoteForRunner(status: RunnerStatus | null): string {
  if (!status) return PREVIEW_PENDING_NOTE;
  if (status.phase === 'running') return ''; // served — the URL says it, no note needed
  return status.live ? IMAGE_BUILDING_NOTE : PREVIEW_PENDING_NOTE;
}

/**
 * Start a PRIVATE sandbox preview the creator runs themselves — no review. Any
 * owner (or a Builder in the domain) can preview. This is the free-iteration
 * loop; only going live in the domain is gated. Phase 2: this provisions the REAL
 * in-cluster runner (Deployment+Service+Ingress); the served URL surfaces once
 * the pod is ready. Offline (no cluster) it stays honestly pending (no URL).
 */
export type PreviewResult = {
  app: App;
  /**
   * The human-readable preview outcome surfaced to the client, or null when there is nothing
   * left to say because the app is already reachable. The deploy route forwards it so the UI can
   * tell the four cases apart instead of showing one "pending" blurb for all of them:
   *   • DECLARATIVE, spec authored  → null (it is served at `/apps/<slug>`; the URL says it)
   *   • DECLARATIVE, no spec yet    → "…served same-origin as soon as it has a validated spec",
   *                                    naming `set_app_spec` / `generate_app_spec`
   *   • CODED, provisioning         → the image-build / pod-starting note
   *   • CODED, refused or offline   → the runner's OWN reason (e.g. no image reference is set),
   *                                    and only a genuinely silent cluster gets the
   *                                    "Kubernetes API unreachable" note
   */
  runnerNote: string | null;
};

export async function startPreview(appId: string, user: CurrentUser, opts: { runner?: RunnerOpts } = {}): Promise<PreviewResult> {
  // EXISTENCE FIRST (F2-1): invisible ⇒ `not_found`, the same answer the read doors give.
  const app = await getAppForUser(appId, user);
  const ownerOrBuilder = app.owner === user.id || (isBuilder(user) && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can preview this app'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot run a preview'), 409);
  // App Builder (C2): a v2 app's preview IS its Dev release and its two slots; nothing is applied here.
  if (isAppBuilderApp(app)) return startPreviewV2(app);
  app.deploy.state = app.deploy.state === 'live' ? 'live' : 'preview';

  // DECLARATIVE APPS (2026-11-19). A `serveMode:'spec'` app is rendered SAME-ORIGIN by the OS at
  // `/apps/<slug>` under the viewer's own session — there is no image, no pod and nothing for the
  // runner to provision. Calling `deployApp` for one attempted an image deploy that fail-closed on
  // a missing image, so `start_preview` on the DEFAULT app kind reported a failure for an app that
  // was already viewable. Its private preview is that same-origin URL, gated by the app's own
  // visibility (Personal ⇒ only the owner reaches it), so return it and say what backs it.
  if (serveModeOf(app) === 'spec') {
    const servedUrl = `/apps/${app.slug}`;
    app.deploy.previewUrl = app.spec ? servedUrl : null;
    await persistApp(app);
    const runnerNote = app.spec
      ? null
      : 'This is a declarative app: it is served same-origin at ' +
        servedUrl +
        ' as soon as it has a validated spec. There is no spec yet — author one with set_app_spec (or scaffold it with generate_app_spec).';
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'start_preview', by: user.id, serveMode: 'spec' },
      output: { preview: app.spec ? 'served' : 'no-spec', url: app.deploy.previewUrl },
      decision: 'allow',
    });
    return { app, runnerNote };
  }

  // Provision the real runner; reflect its outcome honestly (no fake URL offline).
  // WP-54: a preview re-applies the APPROVED commit only; without one it applies nothing.
  const runner = await deployApproved(app, opts.runner);
  applyRunnerOutcome(app, runner);
  await persistApp(app);

  // Surface the actionable outcome: null when the pod is already running (URL is
  // live, nothing to explain); the pending note when provisioning is in progress;
  // or the specific runner failure detail so the UI never silently hangs on "pending".
  const runnerNote: string | null =
    runner.live && runner.phase === 'running'
      ? null
      : runner.live && !runner.ok
        ? runner.detail   // e.g. "Kubernetes rejected part of the deploy (deployment 403, …)"
        : previewPendingNote(runner);

  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'start_preview', by: user.id },
    output:
      runner.live && runner.phase === 'running'
        ? { preview: runner.phase, url: app.deploy.previewUrl, host: runner.host }
        : { preview: runner.live ? runner.phase : 'pending-runner', note: runnerNote },
    decision: 'allow',
  });
  return { app, runnerNote };
}

// ---------------------------------------------------------- Request deploy -----

/** The just-filed Governance approval, minimally described for the UI's shared
 *  "this needs approval" notice (Policies & Approvals link + inline-approve gate). */
export type FiledApprovalRef = { id: string; domain: string; approverRole: 'builder' | 'domain_admin' | 'admin'; scope: 'own' | 'domain' | 'tenant' };

export type DeployRequestResult =
  | { kind: 'auto-deployed'; app: App }
  | { kind: 'review'; app: App; card: ReviewCard; approval: FiledApprovalRef; /** App Builder (H): nobody but the requester may approve it. */ noReviewer?: string };

/**
 * Request a domain deploy. Routine in-envelope updates to an already-live app
 * auto-deploy; the first deploy and any scope-broadening change open a Builder
 * review card. The creator can call this; a Builder approves it.
 */
/**
 * TEST SEAM (like `__setAppProjectGitForTests`): unit suites that exercise something OTHER than the gates
 * install a checks runner here so their container-app deploy requests do not need a cluster. Production never
 * sets it; with it unset the default is the real engine, and no engine means a block (never a pass).
 */
let checksRunnerForTests: ChecksRunner | null = null;
export function __setChecksRunnerForTests(run: ChecksRunner | null): void {
  checksRunnerForTests = run;
}

/** One person cannot hold more than a few checks runs at once (gates-limits.ts); per app the engine supersedes. */
async function withChecksSlot<T>(userId: string, appId: string, fn: () => Promise<T>): Promise<T> {
  const slot = acquireGateSlot({ userId, appId });
  try {
    return await fn();
  } finally {
    slot.release();
  }
}

/**
 * Run an app's quality checks on its committed head WITHOUT asking for a deploy: the same Tekton run (one per
 * commit, idempotent) every trigger uses, and the same verdict `requestDeploy` applies. Owner or an
 * owning-domain builder. `force` ("Run checks") starts a new attempt when the commit's run has finished;
 * `waitMs` bounds how long the call waits (0 = return the running record at once).
 */
export async function runAppTests(
  appId: string,
  user: CurrentUser,
  opts: { checks?: ChecksRunner; trigger?: CheckTrigger; force?: boolean; waitMs?: number } = {},
): Promise<{ commit: string; template: string | null; verdict: GateVerdict; record: CheckRecord }> {
  const app = await getAppForUser(appId, user);
  if (app.owner !== user.id && !(isBuilder(user) && user.domains.includes(app.domain))) {
    throw withStatus(new Error('Only the creator or a builder of the owning domain can run the app tests'), 403);
  }
  // The decision comes from what the OS stored (template + serve mode), never from the tree.
  const policy = gatePolicyFor(app);
  if (!policy.required) throw withStatus(new Error(`This app has no factory gates: ${policy.reason}`), 409);
  const state = appProjectGitEnabled() ? await readAppTreeState(app) : null;
  const files = state?.kind === 'tree' ? state.files : await appFilesForScan(app);
  if (state?.kind !== 'tree') throw withStatus(new Error('The checks run on a commit, and this app has none in the domain repository yet (is the domain git enabled?)'), 409);
  const commit = state.sha;
  // The result belongs to the commit it ran on: stored on the app, shown in the Software tab, and the
  // only thing a deploy of that commit accepts.
  const result = await withChecksSlot(user.id, app.id, () => (opts.checks ?? checksRunnerForTests ?? defaultChecksRunner)({ slug: app.slug, domain: app.domain, sha: commit, trigger: opts.trigger ?? 'mcp', force: opts.force, waitMs: opts.waitMs, templateVersion: templateVersionOf(app) }));
  app.checks = withResult(app.checks, result);
  await persistApp(app);
  return { commit, template: policy.profile, verdict: verdictOfRecord(result.record, commit), record: result.record };
}

export async function requestDeploy(
  appId: string,
  user: CurrentUser,
  opts: { sha?: string; changedFiles?: DiffSummary['files']; scanMode?: ScanMode; scan?: ResolveScanOpts; runner?: RunnerOpts; checks?: ChecksRunner } = {},
): Promise<DeployRequestResult> {
  // EXISTENCE FIRST (F2-1) — see startPreview.
  const app = await getAppForUser(appId, user);
  if (app.owner !== user.id && !isBuilder(user)) {
    throw withStatus(new Error('Only the creator or a Builder can request a deploy'), 403);
  }
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot deploy'), 409);
  // App Builder (C2): a v2 app goes live by taking a Dev release to Prod under the go-live rule table.
  if (isAppBuilderApp(app)) return requestProdGoLive(app, user, { runner: opts.runner });

  // The files under review: the app's durable source tree (what will actually ship —
  // editor saves + governed commits included).
  // WP-54 follow-up (TOCTOU): PIN THE COMMIT FIRST, then review exactly that commit as git holds
  // it. For an image app the scan, the diff and the card are built from the git tree at `sha` —
  // never the OS file cache — so what the Builder reads is byte-identical to what deploys.
  const sha = await pinCommitForReview(app, user);
  // With no domain git at all (DATA_PROJECT_GIT off: a laptop or unit harness) there is no commit to
  // pin and the runner can deploy nothing (it applies only an approved commit); the card then shows
  // the cache, and says nothing is pinned (`sha: null`).
  const files = serveModeOf(app) === 'image' && appProjectGitEnabled() ? await pinnedTreeForReview(app, sha) : await appFilesForScan(app);

  // Resolve the app's UI/API surface at deploy from the code + manifest the agent
  // wrote (the deploy manifest reveals whether it binds a web server vs only an
  // API), so the monitor view is honest to what actually ships — but a declaration
  // (the creator's recorded intent) WINS over the heuristic.
  app.surface = resolveSurface(files, app.declaredSurface);

  // NIGHT-2 S3: a `demo-seed` result is STRUCTURALLY unusable as evidence. The tree under
  // review must be the app's real source, never placeholder rows that reached it because no
  // runner was live — an approval grounded in seeded data is a governance failure wearing a
  // green tick. Refused with a typed 409 BEFORE a card or an approval exists.
  assertNotSeeded('a deploy request', files);

  // SOFTWARE FACTORY: every app served as a container carries the quality gates (tests, type check, lint,
  // build, policy). Whether they apply is decided from what the OS STORED about the app (template + serve
  // mode, gate-policy.ts), never from a line of the author's own tree. They run as a Tekton PipelineRun over
  // exactly this commit, judged by the platform's own gate script and policy, and a deploy is not even
  // REQUESTED while one fails or cannot run: unavailable is not a pass.
  const gatePolicy = gatePolicyFor(app);
  if (gatePolicy.required) {
    // An explicit `sha` is a promise about WHICH commit is meant: it must be the pinned head, and the
    // record stored for it must be green. No record for it means the checks run now, on that commit.
    if (opts.sha && sha && opts.sha !== sha) {
      throw withStatus(new Error(`The requested commit ${opts.sha.slice(0, 12)} is not the app's head ${sha.slice(0, 12)}; push or select the head and run its checks first`), 409);
    }
    const stored = sha ? recordFor(app.checks, sha) : null;
    if (stored && stored.status === 'finished' && !stored.error) {
      // A finished record for exactly this sha is a fact: it is read, not re-run.
      const v = recordVerdict(stored, sha as string);
      if (!v.green) throw withStatus(new Error(`Quality checks for ${(sha as string).slice(0, 12)} are not green: ${v.reason}`), 422);
    } else {
      if (!sha) throw withStatus(new Error('The quality checks run on a commit, and this app has none in the domain repository yet (is the domain git enabled?)'), 409);
      // No record, an unfinished one, one that could not run, or a superseded one: ask the engine. It is idempotent per
      // commit, so a run already in progress is joined, not duplicated.
      const result = await withChecksSlot(user.id, app.id, () => (opts.checks ?? checksRunnerForTests ?? defaultChecksRunner)({ slug: app.slug, domain: app.domain, sha, trigger: 'deploy', force: stored?.status === 'superseded', templateVersion: templateVersionOf(app) }));
      app.checks = withResult(app.checks, result);
      await persistApp(app);
      if (result.record.status === 'running') {
        throw withStatus(new Error(`The quality checks for ${sha.slice(0, 12)} are still running (${result.record.runRef ?? 'run'}); request the deploy again when they have finished`), 409);
      }
      const verdict = verdictOfRecord(result.record, sha);
      if (!verdict.passed) throw withStatus(new Error(verdict.summary), 422);
    }
  }

  const requested = requestedEnvelope(app);
  const broadened = scopeBroadened(app.deploy.approved, requested);

  // UNGRANTED-DATASET GUARD (0.6.97): does the code that will ship reference any
  // dataset the app is NOT granted? Such a reference is the root of the live
  // `Forbidden: … not granted ds_…`. It is a non-blocking WARNING on the review card
  // (the scanner reads code as text, so a hard block risks a false positive) — but it
  // MUST NOT auto-deploy silently: a routine in-envelope update that would otherwise
  // auto-deploy is forced onto the review card when there is a dataset warning.
  const datasetWarning = await ungrantedDatasetWarningForApp(app, files);
  const warnings = datasetWarning ? [datasetWarning] : [];
  // The security scan runs on EVERY deploy request over the files resolved above. A routine
  // update can only auto-deploy when BOTH in-envelope AND clean.
  //
  // The `?? 'offline-mock'` default that used to sit here is GONE (2026-11-18): it meant the
  // card's engine label was never a decision, so on the cluster every scan claimed the offline
  // engine and `decideDeploy` below — which approves only on `scan.passed` — was green by
  // construction.
  //
  // 2026-11-19: and this is now where the LIVE engine answers. `resolveScan` runs Trivy as one
  // Kubernetes Job over exactly these files and labels the result `live` ONLY when that Job
  // completed; a failed Job, a timeout or an unreachable API server leave the scan
  // `unavailable` with the real cause, and `decideDeploy` below still refuses to approve one.
  // Passing a mode here wins, which is what the unit suite does.
  const scan = await resolveScan(app.slug, files, opts.scanMode, opts.scan);

  // Routine update within the approved envelope + a clean scan + NO dataset warning →
  // auto-deploy. An ungranted-dataset reference re-opens the review gate so it is seen.
  // WP-54: for an IMAGE app only when nothing new was committed (HEAD is the approved commit, so
  // the re-apply is of approved manifests) — a new commit carries new k8s/ manifests, and only a
  // Builder's approval of that commit may apply them. Spec/runtime apps are served by the OS.
  const image = serveModeOf(app) === 'image';
  const approvedCommit = !image || (!!sha && sha === app.deploy.approvedSha);
  if (approvedCommit && app.deploy.state === 'live' && !broadened && scan.passed && warnings.length === 0) {
    app.deploy.reviewCardId = null;
    app.deploy.releases += 1; // a routine update ships a new release/version.
    if (image) applyRunnerOutcome(app, await deployApproved(app, opts.runner));
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

  // SELF-SERVE go-live (0.6.102): a Builder deploying their OWN Personal ("My") app
  // publishes in ONE action — no separate approval step, no admin. They are already
  // entitled to approve it themselves (decideDeploy is builder+), so folding
  // request+approve just removes the friction of a personal app you own. Still fully
  // SECURITY-GATED: only on a PASSING scan and with NO ungranted-dataset warning — a
  // scan finding or a dataset warning falls through to the review card so it is seen.
  // Shared / Domain / Company tiers are unaffected: they keep the Builder review gate,
  // and promotion to a higher tier remains separately role-gated.
  if (app.owner === user.id && isBuilder(user) && app.visibility === 'Personal' && scan.passed && warnings.length === 0) {
    // A Builder approving their OWN Personal app: the same approval, of the commit read just now.
    await applyDeployDecisionToApp(app, 'approve', requested, sha, opts.runner);
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'request_deploy', by: user.id, selfServe: true, tier: 'Personal' },
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
    sha,
    requested,
    diff: diffFromFiles(files, opts.changedFiles),
    warnings,
    decision: 'pending',
  };
  // The card IS the evidence an approver reads: it may not carry a seeded value either (S3).
  assertNotSeeded('a deploy review card', card);
  saveCard(card);

  app.deploy.state = 'review';
  app.deploy.reviewCardId = card.id;
  await persistApp(app);

  // Surface in the Governance inbox too. ONE gate: software deploys are
  // BUILDER-reviewed — the same floor `decideDeploy` enforces and the UI copy
  // promises (previously this filed at domain_admin, so the two inboxes gated
  // the SAME decision at different ranks).
  const approval = enqueue({
    kind: 'app_deploy',
    title: `Deploy review: ${app.name}`,
    detail:
      `${card.reason === 'first-deploy' ? 'First deploy' : 'Scope-broadening change'} — ` +
      // Review M1: "scan FAILED (0 findings)" was what an approver read when NOTHING had
      // scanned — the one wording that makes the two different facts look identical.
      `scan ${scan.unavailable ? 'NOT RUN' : scan.passed ? 'passed' : 'FAILED'} ` +
      `(${scan.findings.length} findings` +
      `${scan.engine ? ` from ${scan.engine}` : ' from the offline baseline'}` +
      `${scan.notRun?.length ? `; ${scan.notRun.join('/')} not covered` : ''}), ` +
      `${requested.connections.length} connections, ${requested.writeTools.length} write tools, ` +
      `~$${requested.footprint.estMonthlyUsd}/mo.` +
      (warnings.length ? ` ⚠ references ungranted datasets — see the review card.` : ''),
    agent: app.mcpPrincipal,
    domain: app.domain,
    requestedBy: user.id,
    tool: 'request_deploy',
    payload: { appId: app.id, cardId: card.id },
    approverRole: 'builder',
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
 * The app-state transition a decided deploy applies — the ONE seam both the
 * normal `decideDeploy` path and the self-heal reconcile share, so a healed app
 * lands in exactly the same state (envelope recorded + release bumped + runner
 * rolled on approve; back to preview on deny). Mutates + persists the app.
 */
async function applyDeployDecisionToApp(
  app: App,
  decision: 'approve' | 'deny',
  approvedEnvelope: DeployEnvelope | null,
  sha?: string | null,
  runnerOpts: RunnerOpts = {},
): Promise<void> {
  if (decision === 'approve') {
    app.deploy.state = 'live';
    app.deploy.approved = approvedEnvelope ?? requestedEnvelope(app);
    app.deploy.reviewCardId = null;
    app.deploy.releases += 1; // approved go-live ships a new release/version.
    // Provision the real in-cluster runner on the app's per-app host; the served
    // URL only lands once the pod is actually running (offline stays honestly
    // pending — the go-live decision is still recorded). `state: 'live'` records the
    // DECISION; the badge says "Live" only once a URL is really served (deploy-status.ts).
    // Only an IMAGE app has a runner: a declarative or runtime app is served by the OS itself.
    // WP-54: the approval covers exactly the commit the request was filed for.
    if (serveModeOf(app) === 'image') {
      app.deploy.approvedSha = sha ?? null;
      applyRunnerOutcome(app, await deployApproved(app, runnerOpts));
    }
  } else {
    app.deploy.state = 'preview'; // back to the free preview loop to fix it
    app.deploy.reviewCardId = null;
  }
}

/**
 * WHY a scan did not pass — because the three answers need three different behaviours, and the
 * first implementation of the hatch had only two (PR #63 re-review H-1).
 *
 *   `passed`    — nothing to decide.
 *   `blocking`  — the engine found something: a secret, or a high/critical finding. NEVER
 *                 acknowledgeable. Fix it and re-request.
 *   `no-verdict`— no engine ran at all (`unavailable`). The audited admin hatch exists for this.
 *   `uncovered` — the engine RAN, found nothing blocking, and declared a category it could not
 *                 cover (`notRun` beyond the always-uncovered `sast`): today `deps`, when a tree
 *                 declares dependencies and commits no lockfile — or commits one that no longer
 *                 matches its manifest (`lockfile-evidence.ts`). This was the DEAD END: `passed`
 *                 is false and `unavailable` is unset, so the old code took the "fix the findings"
 *                 branch — for a card with zero findings — and refused the hatch, which made every
 *                 generated app undeployable on a scanner-enabled cluster. It is acknowledgeable,
 *                 on the same admin-only, written-reason, audited terms as `no-verdict`.
 *
 * `sast` is excluded from `uncovered` deliberately: no allowlisted SAST engine exists, the card
 * says so on every scan, and treating it as a gap would mean every deploy needed an
 * acknowledgement — which is how an audited exception becomes a rubber stamp.
 */
export type ScanGate =
  | { kind: 'passed' }
  | { kind: 'blocking' }
  | { kind: 'no-verdict' }
  | { kind: 'uncovered'; categories: ScanCategory[] };

export function scanGate(scan: ScanResult): ScanGate {
  if (scan.passed) return { kind: 'passed' };
  if (scan.unavailable) return { kind: 'no-verdict' };
  // `scan.findings` is CAPPED (`MAX_FINDINGS`) while `passed` counts every finding, so deriving
  // severity from the list alone could classify a card whose blocking findings sat past the cap
  // as "nothing blocking" — and hand it to the admin hatch, which is the one thing a real finding
  // must never be eligible for. `blockingBeyondCap` is what the capped list cannot say
  // (re-review L-B); the `??` keeps a card serialised before the field existed working.
  const blocking =
    scan.blockingBeyondCap === true ||
    scan.findings.some(
      (f) => f.category === 'secrets' || f.severity === 'high' || f.severity === 'critical',
    );
  if (blocking) return { kind: 'blocking' };
  const categories = (scan.notRun ?? []).filter((c) => c !== 'sast');
  if (categories.length > 0) return { kind: 'uncovered', categories };
  // A scan that did not pass, found nothing blocking and covered everything should not exist.
  // Treat the unknown case as blocking: an unexplained refusal must never open the hatch.
  return { kind: 'blocking' };
}

/**
 * The minimum a written acknowledgement must say before it counts as a record. The number itself
 * lives in `@core/policy/approvals` (`AUDITED_OVERRIDE_REASON_MIN`) — it is a platform-wide
 * property of an auditable justification, not this tab's preference — and is re-exported here
 * because this is where it is enforced.
 */
export const NO_SCAN_REASON_MIN = AUDITED_OVERRIDE_REASON_MIN;

/**
 * The explicit, admin-only acknowledgement that there is NO security verdict to approve
 * (2026-11-19). Both fields are required together: the checkbox without a reason is a shrug,
 * and a reason without the checkbox is a note.
 */
export type DecideDeployOpts = {
  acknowledgeNoScan?: boolean;
  reason?: string;
  /** Test seam for the runner (Kubernetes client, namespace, registry). */
  runner?: RunnerOpts;
};

/**
 * Approve or deny a deploy. THE ROLE GATE: only a Builder/Admin in the app's
 * domain may decide — a Creator/non-Builder gets 403. Approval additionally
 * REQUIRES a passing security scan (a leaked secret / high finding blocks the
 * go-live). On approval the app goes live and the approved envelope is recorded
 * so later in-envelope updates auto-deploy.
 *
 * THE ONE WAY PAST AN INCOMPLETE SCAN (2026-11-19) — `opts.acknowledgeNoScan` + `opts.reason`.
 * It is a governance control, not an exemption, and it is fenced four ways:
 *   • the scan must have produced NO VERDICT (`unavailable`, no engine ran) or an INCOMPLETE one
 *     (the engine ran, found nothing blocking, and declared a category it could not cover — see
 *     {@link scanGate}). A scan that FOUND something can never be acknowledged: a real finding
 *     still blocks, which is what keeps this from becoming "click here to skip security";
 *   • the actor must be `admin`. NOT `domain_admin`: that rank approves artefact promotions in
 *     its own domain and would otherwise inherit a tenant-wide security waiver by accident;
 *   • the acknowledgement must be explicit — the default path still returns the 409;
 *   • the written reason must be substantive (>= NO_SCAN_REASON_MIN characters), because the
 *     reason IS the record and "ok" is not a record.
 * It then writes three places: the card (`approvedWithoutScan` + `noScanReason`), the Governance
 * approval's effect, and a hash-chained audit row. Nothing about it touches `OS_OFFLINE_MOCK`,
 * and at no point does the OS claim a clean scan.
 */
export async function decideDeploy(
  cardId: string,
  user: CurrentUser,
  decision: 'approve' | 'deny',
  note?: string,
  opts: DecideDeployOpts = {},
): Promise<{ app: App; card: ReviewCard }> {
  await ensureCardsHydrated(); // a fresh pod rebuilds the cards from the mirror
  const card = cards().get(cardId);
  if (!card) throw withStatus(new Error('Review card not found'), 404);
  if (card.decision !== 'pending') throw withStatus(new Error('This review is already decided'), 409);

  // App Builder (C2): a v2 app's card is a go-live of a Dev release to Prod, decided by the go-live rule table.
  if (appBuilderEnabled()) {
    const v2 = await getAppByIdInternal(card.appId);
    if (v2 && isAppBuilderApp(v2)) return decideProdGoLive(card, v2, user, decision, note, opts);
  }

  // The gate: a non-Builder cannot approve OR deny a deploy.
  if (!isBuilder(user) || !user.domains.includes(card.domain)) {
    throw withStatus(new Error('Only a Builder or Administrator in this domain can review a deploy'), 403);
  }

  // NIGHT-2 S3: the decisive gate. An approval may never be grounded in demo-seed data, so the
  // card's own evidence is re-checked here — at the moment of the decision, not only when it was
  // filed — and a seeded card is refused with a typed 409 for approver AND denier alike.
  assertNotSeeded(`the approval of review card ${card.id}`, card);

  const app = await getAppByIdInternal(card.appId);
  if (!app) {
    // The card outlived its app — the classic multi-session churn: the app was
    // deleted/re-created (new id) after this review card + its Governance approval
    // were filed, so the card points at an id that resolves nowhere. A bare "App
    // not found" (which the UI then shows verbatim next to the card's own summary)
    // hid the real cause. Auto-retire the orphaned card + its governance record so
    // it stops blocking the inbox, and tell the user exactly what to do: re-request
    // the deploy on the CURRENT app. (A transient mirror miss self-heals on the next
    // press — getAppByIdInternal re-probes the durable mirror every call.)
    card.decision = 'denied';
    card.decidedBy = user.id;
    card.decidedAt = new Date().toISOString();
    card.note = `Auto-retired: referenced app ${card.appId} no longer exists.`;
    saveCard(card);
    for (const a of listGovernanceForCard(card.id)) decideApproval(a, 'reject', user.id);
    throw withStatus(
      new Error(
        `This deploy request references an app that no longer exists (${card.appId}) — it was ` +
          `re-created since the request was filed. The stale request has been dismissed; open the ` +
          `current app and press Build → Approve & go live again to file a fresh deploy request.`,
      ),
      409,
    );
  }

  // Set once every gate below holds; it is what makes the approval, the Governance effect and the
  // audit row say WHICH KIND of approval this was.
  let acknowledgedNoScan: string | null = null;
  let uncovered: ScanCategory[] | null = null;

  if (decision === 'approve') {
    // WP-54 follow-up (TOCTOU): the approval is of the commit the Builder reviewed. A new commit
    // since the scan invalidates it — re-request so the new commit is scanned and reviewed.
    if (!(await stillAtReviewedCommit(app, card.sha))) {
      throw withStatus(
        new Error(
          `Cannot approve: the app changed since this review (reviewed commit ${String(card.sha ?? 'none').slice(0, 12)}). ` +
            'Request the deploy again so the new commit is scanned and reviewed. Nothing was deployed.',
        ),
        409,
      );
    }
    const gate = scanGate(card.scan);
    if (gate.kind !== 'passed') {
      // THREE different facts, and an approver must be told which: something was FOUND, NOTHING
      // ran, or something ran and could not see part of the tree. Only the last two are
      // acknowledgeable, and the first used to be indistinguishable from the third — which is
      // what made every lockfile-less app undeployable (re-review H-1).
      if (gate.kind === 'blocking') {
        throw withStatus(
          new Error(
            'Cannot approve: the security scan did not pass (fix the findings and re-request). ' +
              'A scan that FOUND something cannot be acknowledged — the acknowledgement applies ' +
              'only when no engine ran, or when the engine could not cover a category.',
          ),
          409,
        );
      }
      if (!opts.acknowledgeNoScan) {
        throw withStatus(new Error(incompleteScanRefusal(card.scan, gate)), 409);
      }
      // ROLE: admin, and only admin. `isBuilder` above already let a builder/domain_admin in to
      // decide; this is a second, higher floor for the waiver specifically.
      if (!roleAtLeast(user.role, 'admin')) {
        throw withStatus(
          new Error(
            `Only an Administrator can approve a deploy on an incomplete security scan — your ` +
              `role is ${user.role}. ` +
              (gate.kind === 'uncovered'
                ? `Commit a lockfile that matches the manifest so the dependencies can be resolved, `
                : `Wire a scanner (osUI.software.scanner.enabled) or fix the scanner's failure, `) +
              `or ask an Administrator to acknowledge it.`,
          ),
          403,
        );
      }
      const reason = (opts.reason ?? '').trim();
      if (reason.length < NO_SCAN_REASON_MIN) {
        throw withStatus(
          new Error(
            `Approving on an incomplete security scan needs a written reason of at least ` +
              `${NO_SCAN_REASON_MIN} characters — it is the permanent record of why this shipped ` +
              `without ${gate.kind === 'uncovered' ? `a ${gate.categories.join('/')} verdict` : 'a scan'}.`,
          ),
          400,
        );
      }
      acknowledgedNoScan = reason;
      card.noScanReason = reason;
      if (gate.kind === 'uncovered') {
        // An engine DID run and the secret scan DID cover every file; saying "approved without a
        // security verdict" here would overstate the gap.
        uncovered = gate.categories;
        card.approvedWithUncoveredCategories = gate.categories;
      } else {
        card.approvedWithoutScan = true;
      }
    }
    card.decision = 'approved';
    await applyDeployDecisionToApp(app, 'approve', card.requested, card.sha ?? null, opts.runner);
  } else {
    card.decision = 'denied';
    await applyDeployDecisionToApp(app, 'deny', null);
  }
  card.decidedBy = user.id;
  card.decidedAt = new Date().toISOString();
  card.note = note;
  saveCard(card);
  await persistApp(app);

  // Reflect the decision into the Governance inbox record.
  for (const a of listGovernanceForCard(card.id)) {
    // Stamp the acknowledgement BEFORE deciding: `decide()` write-throughs the item, and an
    // effect recorded after it would be a second write that a crash in between could lose.
    if (acknowledgedNoScan !== null) {
      recordEffect(a, {
        applied: uncovered
          ? `deploy approved with an INCOMPLETE security scan (${uncovered.join(', ')} not covered)`
          : 'deploy approved WITHOUT a security verdict',
        live: app.deploy.state === 'live',
        approvedWithoutScan: {
          reason: acknowledgedNoScan,
          by: user.id,
          scanMode: card.scan.mode,
          ...(uncovered ? { uncoveredCategories: uncovered } : {}),
        },
      });
    }
    decideApproval(a, decision === 'approve' ? 'approve' : 'reject', user.id);
  }

  // THE AUDIT ROW. Only for the waiver: a normal approval is already recorded by the Governance
  // item and the run trace, and an audit log that carries every ordinary decision is one nobody
  // reads. This row is hash-chained, so the acknowledgement cannot be removed without
  // `verifyChain()` reporting it.
  if (acknowledgedNoScan !== null) {
    recordAudit({
      actor: user.id,
      action: 'deploy',
      subject: app.id,
      domain: card.domain,
      reason: acknowledgedNoScan,
      detail: {
        // Two distinct keys for two distinct facts, so an auditor can search for either: nothing
        // scanned, or something scanned and named what it could not see.
        ...(uncovered ? { approvedWithUncoveredCategories: uncovered } : { approvedWithoutScan: true }),
        cardId: card.id,
        appId: app.id,
        appName: app.name,
        role: user.role,
        scanMode: card.scan.mode,
        scanEngine: card.scan.engine ?? 'none',
        scanReason: card.scan.reason ?? 'no reason recorded on the card',
        findings: card.scan.findings.length,
      },
    });
  }

  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'decide_deploy', by: user.id, role: user.role, decision },
    output: {
      cardId: card.id,
      state: app.deploy.state,
      ...(acknowledgedNoScan === null
        ? {}
        : uncovered
          ? { approvedWithUncoveredCategories: uncovered, noScanReason: acknowledgedNoScan }
          : { approvedWithoutScan: true, noScanReason: acknowledgedNoScan }),
    },
    decision: decision === 'approve' ? 'allow' : 'deny',
  });
  return { app, card };
}

/**
 * What an approver is told when a scan is incomplete and they did not acknowledge it. The
 * `uncovered` wording is the point of re-review H-1(b): "fix the findings and re-request" was
 * read by a Builder looking at a card with ZERO findings, which names no action they can take.
 */
function incompleteScanRefusal(scan: ScanResult, gate: ScanGate): string {
  if (gate.kind === 'uncovered') {
    const cats = gate.categories.join(', ');
    const deps = gate.categories.includes('deps');
    return (
      // "found nothing" overstated it: medium/low findings may be listed on the card right above
      // this message. What is true is that nothing BLOCKING was found (re-review L-A).
      `Cannot approve: the security scan ran and found nothing blocking, but it could not cover ` +
      `${cats}. ` +
      (deps
        ? // Two causes share this gate and the scanner's own reason (appended) says which: no
          // lockfile at all, or one that no longer matches the manifest. The wording must be
          // true of both — "no lockfile" was wrong for an app whose lockfile had gone stale.
          `The dependency scan does not cover this tree (the lockfile is missing, or no longer ` +
          `matches the manifest) — commit a lockfile generated from the current manifest ` +
          `(package-lock.json / yarn.lock / poetry.lock / go.sum / …) and re-request the deploy, ` +
          `or an Administrator may acknowledge the gap in writing. `
        : `Commit what the scanner needs and re-request the deploy, or an Administrator may ` +
          `acknowledge the gap in writing. `) +
      (scan.reason ?? '')
    ).trim();
  }
  return `Cannot approve: there is no security verdict to approve. ${scan.reason ?? ''}`.trim();
}

// Link Governance approval ids back to a card (best-effort; in-process).
function listGovernanceForCard(cardId: string): string[] {
  return listApprovals({ status: 'pending' })
    .filter((a) => a.kind === 'app_deploy' && (a.payload as { cardId?: string })?.cardId === cardId)
    .map((a) => a.id);
}

// -------------------------------------------------------- Self-heal reconcile ---

/**
 * SELF-HEAL: an app stuck in `review` whose Governance app_deploy approval was
 * ALREADY decided must be reconciled to its true state on load. This heals apps
 * orphaned before the approve→decideDeploy write-back existed (the item is
 * `approved`/`rejected`, yet the app kept `deploy.state === 'review'` with a
 * `reviewCardId`) AND guards against any future effect that misses.
 *
 * We cannot route through `decideDeploy` for these: its in-process review card is
 * gone after a restart (that's why they orphaned). Instead we apply the SAME
 * transition via the shared `applyDeployDecisionToApp` seam, sourcing the approved
 * envelope from the card if it survives, else from the app's current requested
 * envelope. Idempotent (only fires while state === 'review' with a reviewCardId),
 * fail-soft (a reconcile error NEVER breaks loading the app), and a no-op when no
 * matching decided approval exists (the app is left exactly as-is).
 */
export async function reconcileDeployApproval(app: App): Promise<boolean> {
  try {
    if (app.deploy.state !== 'review' || !app.deploy.reviewCardId) return false;
    // App Builder (C2): a v2 go-live is decided only through decideDeploy (it rolls a release out); never healed here.
    if (isAppBuilderApp(app)) return false;
    const cardId = app.deploy.reviewCardId;
    // Rebuild durable review cards first (mirror), so a surviving card supplies
    // the exact approved envelope instead of falling back to the requested one.
    await ensureCardsHydrated();
    // Ensure durable approvals are hydrated (memoized) so a fresh pod sees the
    // already-decided app_deploy record persisted in the os-approvals index.
    await ensureApprovalsHydrated();
    // Match the decided governance approval by card id, else by app id (the
    // payload carries both). Only decided items heal; pending leaves it in review.
    const decided = listApprovals({})
      .filter((a) => a.kind === 'app_deploy' && a.status !== 'pending')
      .find((a) => {
        const p = a.payload as { cardId?: string; appId?: string };
        return p?.cardId === cardId || p?.appId === app.id;
      });
    if (!decided) return false;

    if (decided.status === 'approved') {
      const card = cards().get(cardId);
      // The same TOCTOU rule: an approval of a commit that is no longer the app's tree applies nothing.
      if (!(await stillAtReviewedCommit(app, card?.sha))) return false;
      await applyDeployDecisionToApp(app, 'approve', card?.requested ?? null, card?.sha ?? null);
    } else {
      await applyDeployDecisionToApp(app, 'deny', null);
    }
    await persistApp(app);
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'reconcile_deploy', cardId, approvalId: decided.id, approvalStatus: decided.status },
      output: { state: app.deploy.state },
      decision: decided.status === 'approved' ? 'allow' : 'deny',
    });
    return true;
  } catch {
    // Fail-soft: a reconcile problem must never break loading the app.
    return false;
  }
}

// ------------------------------------------------------- Runner status poll ----

/**
 * Poll the app's REAL in-cluster runner status and reconcile the deploy fields
 * off ACTUAL pod state (the `deploying → running → failed` transition is driven
 * by the Deployment's readyReplicas/conditions, never a timer). The served URL
 * only appears once the pod is `running`. Offline (no cluster) mutates nothing —
 * it cannot confirm state.
 */
export async function reconcileDeployStatus(
  appId: string,
  user: CurrentUser,
  opts: RunnerOpts = {},
): Promise<{ app: App; status: RunnerStatus }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder = app.owner === user.id || (isBuilder(user) && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator or a Builder can read this app runner status'), 403);
  // App Builder (C2): a v2 app runs in apps-prod under its own name; read that, never heal into agentic-apps.
  if (isAppBuilderApp(app)) {
    const prod = currentRelease(app, 'prod');
    const st: RunnerStatus = prod
      ? await deploymentStatus(envNamespaceOf('prod'), appResourceName(app.domain, app.slug), opts.k8s)
      : { phase: 'absent', live: true, replicas: 0, ready: 0, detail: 'No Prod release yet.' };
    return { app, status: st };
  }

  let status = await runnerStatus({ slug: app.slug }, opts);

  // SELF-HEAL a missing runner. An app that is preview/live is SUPPOSED to have a
  // Deployment; when the runner is `absent` (deployment 404) but the cluster IS
  // reachable, the runner was never provisioned — the classic case is a deploy
  // approved (or preview started) while the k8s API was transiently unreachable,
  // so `deployApp` returned offline and no Deployment was ever created (the image
  // built + pushed regardless). Re-provision idempotently now that the API answers,
  // then re-read. Only fires for absent-but-reachable + a deploy state that should
  // be running; `offline` (status 0) is left untouched (we honestly cannot heal
  // what we cannot reach), and a running/deploying/failed runner is never re-applied.
  // Only an IMAGE app has a runner to heal or a pod URL to reconcile. A declarative (`spec`) or
  // runtime app is served by the OS itself: a poll must never create a Deployment for it, and
  // must never overwrite its same-origin URL with a pod's (absent) state.
  if (serveModeOf(app) !== 'image') return { app, status };

  if (status.phase === 'absent' && (app.deploy.state === 'live' || app.deploy.state === 'preview')) {
    const healed = await deployApproved(app, opts);
    // NIGHT-2 S2: the heal can REFUSE — an `image` app with no published image provisions
    // nothing and says why, instead of serving a placeholder container on the app's own host.
    // Carry that reason onto the status the caller shows; never a silent "still absent".
    if (!healed.live && healed.phase === 'failed' && healed.detail) {
      status = { ...status, detail: healed.detail };
    }
    if (healed.live) {
      void trace({
        principal: app.mcpPrincipal,
        tool: 'generate',
        input: { action: 'reconcile_runner', by: user.id, was: 'absent' },
        output: { phase: healed.phase, detail: healed.detail },
        decision: 'allow',
      });
      status = await runnerStatus({ slug: app.slug }, opts);
    }
  }

  if (status.live) {
    app.deploy.previewUrl = status.phase === 'running' ? `https://${appHost(app)}` : null;
    await persistApp(app);
  }
  return { app, status };
}

// ------------------------------------------------------------- Readers ---------

export async function getReviewCard(cardId: string): Promise<ReviewCard | null> {
  await ensureCardsHydrated();
  return cards().get(cardId) ?? null;
}

export async function listReviewCards(opts: { domain?: string; pendingOnly?: boolean } = {}): Promise<ReviewCard[]> {
  await ensureCardsHydrated();
  return [...cards().values()]
    .filter((c) => (opts.domain ? c.domain === opts.domain : true))
    .filter((c) => (opts.pendingOnly ? c.decision === 'pending' : true))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}


// ------------------------------------------------------------------ delete domain (admin) --
/** Delete-domain: every software review of a domain, in every state (`core/kernel/domain-delete.ts`). */
export async function listReviewCardsForDomain(domain: string): Promise<ReviewCard[]> {
  await ensureCardsHydrated();
  return [...cards().values()].filter((x) => x.domain === domain);
}

/** Delete-domain: remove one software review for good. Awaits the durable mirror's confirmation first, so
 *  the record is never reported gone while the shared store still holds it. */
export async function purgeReviewCardForDomainDelete(id: string): Promise<'deleted' | 'absent'> {
  const out = await cardsMirror.deleteConfirmed(id);
  if (!out.ok) throw Object.assign(new Error(`software review ${id}: the store did not confirm the delete (${out.reason})`), { status: 503 });
  cards().delete(id);
  return out.result;
}

// ============================================ App Builder (C2): go-live of a Dev release to Prod ===
// Spec 6.3, 9. A `nextjs-web@2` app (switch on) never deploys through the legacy runner path above. Going live = taking
// an existing, running DEV release (same sha, same digest: never a rebuild) to Prod. Who must review is the Platform
// go-live rule table (`goLiveDecision` / `canReview`, read on every call): reviewer `none` (My scope by default) ⇒ the
// requester (who must be able to edit the app) goes live at once; otherwise a review card + Governance approval wait for
// an eligible reviewer, and NOBODY approves their own go-live (not configurable). Rules decide WHO; they skip no gate:
// the release's checks must be green, both scans passed (tree + image), its digest must be the run's, and for
// Domain/Company scope no pushed change may be unreviewed (`App.unreviewed`, workstream B's post-hoc proposals).
// The rollout itself is rollout.ts (pre-deploy hooks incl. migrations first); a failure keeps the card pending.

/** True for an App Builder app while the switch is on (the only apps the release flow serves). */
export function isAppBuilderApp(app: Pick<App, 'templateVersion' | 'domain'>): boolean {
  return appBuilderEnabled() && templateVersionOf(app) === 2 && !!app.domain;
}

/** Pure: the unreviewed-changes block (spec 5, 9; workstream B's `unreviewedBlocksGoLive`), or null. Never for My. */
export function unreviewedGoLiveBlock(app: Pick<App, 'name' | 'unreviewed'>, scope: GoLiveScope): string | null {
  return unreviewedBlocksGoLive(app, scope);
}

/** Pure: why `release` may not go to Prod, or null. Only a running Dev release whose own run was green and scanned. */
export function prodGateRefusal(app: Pick<App, 'checks'>, release: AppRelease | null): string | null {
  if (!release) return 'there is no running Dev release to take live; push a change and let its checks go green first';
  if (release.env !== 'dev' || release.slot) return `release ${release.id} is not a Dev release; Prod takes only a Dev release`;
  if (release.state !== 'running') return `Dev release ${release.id} is ${release.state}, not running`;
  const rec = recordFor(app.checks, release.sha);
  const v = recordVerdict(rec, release.sha);
  if (!v.green) return `the checks of ${release.sha.slice(0, 12)} are not green: ${v.reason}`;
  if (rec?.checks.find((c) => c.id === IMAGE_SCAN_CHECK)?.status !== 'pass') return `the image of ${release.sha.slice(0, 12)} has no passing image scan`;
  if (rec?.digest !== release.digest) return `the digest of Dev release ${release.id} is not the one its run built; Prod refuses it`;
  return null;
}

/** The scan facts of a release's run, shaped as the review card's ScanResult (both Trivy scans ran in the pipeline). */
function scanOfRelease(app: App, release: AppRelease): ScanResult {
  const rec = recordFor(app.checks, release.sha);
  const tree = rec?.checks.find((c) => c.id === 'scan');
  const image = rec?.checks.find((c) => c.id === IMAGE_SCAN_CHECK);
  const passed = tree?.status === 'pass' && image?.status === 'pass';
  return { mode: 'live', passed, findings: [], summary: { sast: 0, deps: 0, secrets: 0 }, scannedAt: rec?.finishedAt ?? new Date().toISOString(), engine: 'trivy', notRun: ['sast'] };
}

const memberOf = (u: CurrentUser) => ({ id: u.id, role: u.role, domains: u.allDomains?.length ? u.allDomains : u.domains });

async function goLiveToProd(app: App, release: AppRelease, by: CurrentUser, deps: RolloutDeps): Promise<AppRelease> {
  const out = await rolloutRelease(app, { env: 'prod', sha: release.sha, digest: release.digest, by: { id: by.id, name: by.name }, reason: 'go-live' }, deps);
  if (!out.ok) throw withStatus(new Error(`Prod was not changed: ${out.reason}`), out.code === 'no_builder' || out.code === 'offline' ? 503 : 409);
  const firstProd = (app.releases ?? []).filter((r) => r.env === 'prod' && !r.slot && r.state === 'running').length === 1;
  if (firstProd) await deleteLegacyAfterProd(app, by);
  app.deploy.state = 'live';
  app.deploy.releases += 1;
  app.deploy.approvedSha = release.sha;
  app.deploy.reviewCardId = null;
  app.deploy.previewUrl = releaseUrl(app, 'prod');
  await persistApp(app);
  return out.release;
}

/** request_deploy for a v2 app: go-live of a Dev release (the current one unless named) to Prod. */
export async function requestProdGoLive(app: App, user: CurrentUser, opts: { releaseId?: string; runner?: RunnerOpts; deps?: RolloutDeps } = {}): Promise<DeployRequestResult> {
  if (user.via) throw withStatus(new Error('an app cannot take itself live'), 403);
  const { getEditableAppForUser } = await import('@tabs/software/lib/apps');
  await getEditableAppForUser(app.id, user);
  const release = opts.releaseId ? (app.releases ?? []).find((r) => r.id === opts.releaseId) ?? null : currentRelease(app, 'dev');
  const gate = prodGateRefusal(app, release);
  if (gate) throw withStatus(new Error(gate), 422);
  const scope = scopeOfVisibility(app.visibility);
  const block = unreviewedGoLiveBlock(app, scope);
  if (block) throw withStatus(new Error(block), 409);
  await ensureCardsHydrated();
  if (app.deploy.state === 'review' && app.deploy.reviewCardId) {
    const open = cards().get(app.deploy.reviewCardId);
    if (open && open.decision === 'pending') throw withStatus(new Error(`a go-live of this app is already waiting for review (card ${open.id})`), 409);
  }
  const rules = await currentGoLiveRules();
  const d = goLiveDecision(rules, 'app', scope, app.domain);
  const rel = release as AppRelease;
  const deps: RolloutDeps = { ...(opts.deps ?? {}), ...(opts.runner?.k8s ? { k8s: opts.runner.k8s } : {}) };
  if (d.autoApprove) {
    const prod = await goLiveToProd(app, rel, user, deps);
    void trace({ principal: app.mcpPrincipal, tool: 'generate', input: { action: 'request_deploy', by: user.id, goLive: 'prod', scope, reviewer: d.reviewer }, output: { autoDeployed: true, release: prod.id, sha: prod.sha }, decision: 'allow' });
    return { kind: 'auto-deployed', app };
  }
  const card: ReviewCard = {
    id: newId('rev'),
    appId: app.id,
    appName: app.name,
    domain: app.domain,
    requestedBy: user.id,
    requestedAt: new Date().toISOString(),
    reason: currentRelease(app, 'prod') ? 'scope-broadened' : 'first-deploy',
    scan: scanOfRelease(app, rel),
    sha: rel.sha,
    requested: requestedEnvelope(app),
    diff: { files: [], added: 0, removed: 0 },
    warnings: [`Go-live of Dev release ${rel.id} (commit ${rel.sha.slice(0, 12)}, image ${rel.digest.slice(0, 19)}…) to Prod. Reviewer: ${d.reviewer} (${d.reason}).`],
    decision: 'pending',
  };
  saveCard(card);
  app.deploy.state = 'review';
  app.deploy.reviewCardId = card.id;
  await persistApp(app);
  const approval = enqueue({
    kind: 'app_deploy',
    title: `Go-live to Prod: ${app.name}`,
    detail: `Dev release ${rel.id} (commit ${rel.sha.slice(0, 12)}) of ${app.name} to Prod in ${scope} scope; checks green, tree and image scans passed. Reviewer: ${d.reviewer}; the requester cannot approve it.`,
    agent: app.mcpPrincipal,
    domain: app.domain,
    requestedBy: user.id,
    tool: 'request_deploy',
    payload: { appId: app.id, cardId: card.id, releaseId: rel.id, goLive: 'prod' },
    approverRole: d.reviewer === 'none' ? 'builder' : d.reviewer,
  });
  void trace({ principal: app.mcpPrincipal, tool: 'generate', input: { action: 'request_deploy', by: user.id, goLive: 'prod', scope, reviewer: d.reviewer }, output: { cardId: card.id, release: rel.id }, decision: 'requires_approval' });
  // H: the card is filed either way (an admin can change the rule or a reviewer can be appointed later); the requester
  // is TOLD when nobody else may approve it today. Advisory: "could not check" adds nothing.
  const who = await goLiveReviewerNotice(rules, { kind: 'app', scope, domain: app.domain, requestedBy: user.id });
  return { kind: 'review', app, card, approval: { id: approval.id, domain: approval.domain, approverRole: approval.approverRole, scope: approval.scope }, ...(who.notice ? { noReviewer: who.notice } : {}) };
}

/** The release a go-live card is for (Governance payload), else the running Dev release at the card's sha. */
function releaseOfCard(app: App, card: ReviewCard): AppRelease | null {
  const a = listApprovals({}).find((x) => x.kind === 'app_deploy' && (x.payload as { cardId?: string })?.cardId === card.id);
  const id = (a?.payload as { releaseId?: string } | undefined)?.releaseId;
  const byId = id ? (app.releases ?? []).find((r) => r.id === id) ?? null : null;
  return byId ?? ((app.releases ?? []).find((r) => r.env === 'dev' && !r.slot && r.sha === card.sha && r.state === 'running') ?? null);
}

/**
 * Cards being decided right now (security review of #400: two approvals of one card must not roll out twice). The
 * check-and-set below runs before the first `await`, so in this single-threaded process it is atomic; os-ui runs one
 * replica while the App Builder is on (the chart's guard).
 */
const deciding = new Set<string>();

async function decideProdGoLive(card: ReviewCard, app: App, user: CurrentUser, decision: 'approve' | 'deny', note: string | undefined, opts: DecideDeployOpts): Promise<{ app: App; card: ReviewCard }> {
  if (deciding.has(card.id) || card.decision !== 'pending') throw withStatus(new Error('This go-live is already being decided'), 409);
  deciding.add(card.id);
  try {
    return await decideProdGoLiveOnce(card, app, user, decision, note, opts);
  } finally {
    deciding.delete(card.id);
  }
}

async function decideProdGoLiveOnce(card: ReviewCard, app: App, user: CurrentUser, decision: 'approve' | 'deny', note: string | undefined, opts: DecideDeployOpts): Promise<{ app: App; card: ReviewCard }> {
  if (user.via) throw withStatus(new Error('an app cannot decide a go-live'), 403);
  const rules = await currentGoLiveRules();
  const scope = scopeOfVisibility(app.visibility);
  const req = { kind: 'app' as const, scope, domain: app.domain, requestedBy: card.requestedBy };
  // The requester may WITHDRAW (deny) their own request; approving needs an eligible reviewer who is not the requester.
  if (!(decision === 'deny' && user.id === card.requestedBy)) {
    const v = canReview(rules, req, memberOf(user));
    if (!v.ok) throw withStatus(new Error(`You cannot decide this go-live: ${v.reason}`), 403);
  }
  if (decision === 'approve') {
    const release = releaseOfCard(app, card);
    const gate = prodGateRefusal(app, release);
    if (gate) throw withStatus(new Error(`Cannot approve: ${gate}. Nothing was deployed.`), 409);
    const block = unreviewedGoLiveBlock(app, scope);
    if (block) throw withStatus(new Error(`Cannot approve: ${block}. Nothing was deployed.`), 409);
    // A rollout failure (a migration, admission) throws here and leaves the card pending: the reviewer can retry.
    const prod = await goLiveToProd(app, release as AppRelease, user, opts.runner?.k8s ? { k8s: opts.runner.k8s } : {});
    card.decision = 'approved';
    card.note = note ?? `released ${prod.id} to Prod`;
  } else {
    card.decision = 'denied';
    card.note = note;
    app.deploy.state = currentRelease(app, 'prod') ? 'live' : 'preview';
    app.deploy.reviewCardId = null;
    await persistApp(app);
  }
  card.decidedBy = user.id;
  card.decidedAt = new Date().toISOString();
  saveCard(card);
  for (const a of listGovernanceForCard(card.id)) decideApproval(a, decision === 'approve' ? 'approve' : 'reject', user.id);
  recordAudit({ actor: user.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `go-live to Prod ${decision === 'approve' ? 'approved' : 'denied'} (card ${card.id}, requested by ${card.requestedBy})`, detail: { kind: 'app.golive', decision, cardId: card.id, scope, role: user.role, sha: card.sha ?? null } });
  void trace({ principal: app.mcpPrincipal, tool: 'generate', input: { action: 'decide_deploy', by: user.id, role: user.role, decision, goLive: 'prod' }, output: { cardId: card.id, state: app.deploy.state }, decision: decision === 'approve' ? 'allow' : 'deny' });
  return { app, card };
}

/** start_preview for a v2 app: the Dev URL and both slots (woken when idle); nothing is built or applied. */
async function startPreviewV2(app: App): Promise<PreviewResult> {
  const dev = currentRelease(app, 'dev');
  await wakePreviews(app);
  app.deploy.previewUrl = dev ? releaseUrl(app, 'dev') : null;
  await persistApp(app);
  return {
    app,
    runnerNote: dev
      ? null
      : config.appRegistry
        ? 'There is no Dev release yet: push a change (or run its checks); every green build is released to Dev automatically.'
        : 'There is no Dev release: no app builder is configured on this installation (softwareRunner.environments.build), so no image can be built.',
  };
}
