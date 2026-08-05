/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { emptyContextGrants, normalizeContextGrants, type ContextGrants } from '@/lib/core/context-grants';
import type { CurrentUser } from '@/lib/core/auth';
import { canPromote, roleAtLeast } from '@/lib/core/session';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/artifact-model';
import {
  createArtifact,
  promoteArtifact,
  getArtifact,
  type Artifact,
} from '@/lib/core/artifacts';
import {
  registerConnection,
  setConnectionVisibility,
  getConnectionByApp,
  type AppConnection,
  type AppTool,
} from '@/lib/infra/app-registry';
import { trace } from '@/lib/infra/agent-governed';
import type {
  AppStatus,
  DeployState,
  DeployEnvelope,
  AppManifest,
  AppSurface,
  ConsumedResource,
  ScaffoldFile,
  SurfaceDeclaration,
} from '@/lib/software/model';
import { normalizeSpec, type StorySpec } from '@/lib/software/story-spec';
import { detectPreviewShape } from '@/lib/software/preview-shape';
import { viteOsFiles } from '@/lib/software/scaffolds/vite-os';
import { sovereignAppFiles, sovereignAppGuide } from '@/lib/software/scaffolds/sovereign-app';
import { websiteFiles, websiteGuide } from '@/lib/software/scaffolds/website';
import { apiServiceFiles, apiServiceGuide } from '@/lib/software/scaffolds/api-service';
import { emptyAppFiles, emptyAppGuide } from '@/lib/software/scaffolds/empty-app';
import { vendorSdkForRepo, applySdkFileDep } from '@/lib/software/app-sdk-vendor';
import { vendorUiForRepo, applyUiFileDep } from '@/lib/software/app-ui-vendor';
import { snapshotFiles, getSnapshot, hydrateSnapshot, deleteSnapshot } from '@/lib/software/snapshot';
import { generateAndCompile } from '@/lib/software/auto-mcp';
import { dataPlaneToolsFromGrants } from '@/lib/software/grant-tools';
import { parseAppManifest, renderAppYaml, defaultOpenApi, resolveSurface } from '@/lib/software/metadata';
import { osMirror } from '@/lib/infra/os-mirror';
import { getPublicUser, type PublicUser } from '@/lib/platform-admin/users';
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '@/lib/folders';
import { normaliseFolderPath } from '@/lib/core/folders';
import { type ArtifactVersion, versionLog } from '@/lib/core/versioning';
import { listGitVersions, restoreGitVersion, shaForVersion, type GitVersion } from '@/lib/core/git-versioning';
import type { ForgejoClient, ForgejoCommit, ForgejoCommitFiles } from '@/lib/infra/forgejo';

/**
 * App registry — the home of record for every application built in the Software
 * tab (Software golden path). Each app is a self-contained governed unit: its
 * design decisions, data descriptions, docs and build-chat history all live
 * here, "under the app"; its repo/pipeline/MCP/connection/data references hang
 * off it; and it carries its own Personal→Shared→Marketplace lifecycle.
 *
 * Persistence mirrors `lib/artifacts.ts`: an authoritative in-process cache (so
 * the teaching flow works with NO cluster) plus a best-effort OpenSearch
 * write-through ("os-apps" index) for durability in a real deploy. The scoping +
 * promotion rules below are the security boundary regardless of backing store.
 *
 * What is LIVE vs STUBBED locally:
 *   • Forgejo repo creation + file seeding — a REAL API call when Forgejo is
 *     reachable; best-effort + honestly reported `mode:'offline'` when not.
 *   • CI → Harbor → Argo CD → subdomain — the chart wires this end-to-end on a
 *     cluster; locally the pipeline status reflects reachability, not a sham.
 *   • Auto-MCP → Connection + agent tool — registered in-process (app-registry)
 *     so the creator's agents can call it through the governed authorize→trace
 *     spine immediately; a real deploy would also push the grant to OPA.
 *   • Data/files → Personal artifacts — REAL artifacts via `createArtifact`,
 *     owned by the creator, visible in the Data tab, promoted by the same ladder.
 */

export type PipelineStage = 'forgejo' | 'actions' | 'harbor' | 'argocd' | 'live';

/**
 * Phase C — per-app bounded CI-repair bookkeeping (see ci-repair.ts). Persisted on the
 * App so the "at most one auto-repair per failed run" + "no loop" bounds survive across
 * requests/instances. The TYPE lives here (with the App type) to avoid a runtime import
 * cycle between apps.ts and ci-repair.ts; the loop logic lives in ci-repair.ts.
 */
export type CiRepairState = {
  /** The failed-run id we already opened an auto-repair for — the at-most-once guard. */
  repairedRunId: string | null;
  /** The head sha the repair commit produced — a re-fail of THIS sha must not re-repair. */
  repairCommitSha: string | null;
  /** ISO of the last repair attempt (visibility). */
  lastAttemptAt: string | null;
  /** The outcome of the last attempt, honestly labelled. */
  outcome: 'repaired' | 'attempted-still-failing' | 'skipped' | null;
  /** Owner opt-out (default ON). false ⇒ never auto-repair this app. */
  autoRepairEnabled: boolean;
};

export function defaultCiRepairState(): CiRepairState {
  return { repairedRunId: null, repairCommitSha: null, lastAttemptAt: null, outcome: null, autoRepairEnabled: true };
}

/**
 * Phase B — OS BUILD SERVICE bookkeeping (see build-service.ts). Persisted on the App
 * so the in-flight build (which system, which commit, which Job) survives across
 * requests/instances and the status card can narrate it HONESTLY. The build itself
 * runs as an in-cluster Kaniko batch/v1 Job os-ui submits + polls; this records only
 * WHICH commit is building and its last-observed outcome. Absent ⇒ no OS build has run
 * for this app (the Forgejo Actions path is serving), which the status note says plainly.
 */
export type OsBuildState = {
  /** The commit SHA the last OS build was submitted for. */
  sha: string | null;
  /** The build Job name (poll handle). */
  jobName: string | null;
  /** Last-observed phase, honestly labelled (never claims success it did not see). */
  phase: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | null;
  /** ISO of the last submit/poll. */
  updatedAt: string | null;
  /** The captured digest ref of the last SUCCESSFUL OS build (mirrors app.runImageDigest). */
  digest: string | null;
};

export function defaultOsBuildState(): OsBuildState {
  return { sha: null, jobName: null, phase: null, updatedAt: null, digest: null };
}
export type StageStatus = 'ok' | 'pending' | 'offline' | 'disabled' | 'stalled' | 'failing';

export type AppFile = {
  name: string;
  description: string;
  visibility: Visibility;
};

export type AppChatMessage = { role: 'user' | 'assistant'; content: string; at: string };

/**
 * One EXPLICIT app membership — an OS user the app owner has added to this app.
 * The OWNER is always an admin and is NEVER stored here (they are implicit), so an
 * app with an empty/absent list is OWNER-ONLY. `role` is the minimal two-value
 * ladder: `admin` (reaches the in-app Admin area + may manage membership) or
 * `member` (a named collaborator). Managing membership stays edit-scoped in the OS.
 */
export type AppMemberRole = 'admin' | 'member';
export type AppMember = { id: string; role: AppMemberRole };

/**
 * A DESIGN user story under an EPIC (Software golden path — Design stage). Plain
 * agile shape: the classic "As a … I want … so that …" plus acceptance criteria.
 */
export type AppStory = {
  id: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  acceptance: string;
  /**
   * Lightweight per-story BUILD status (Software Build stage — story-targeted
   * build). Optional + defaults to undefined (treated as 'todo') so pre-status
   * apps load unchanged; set to 'done' when a Build run for this story completes.
   */
  status?: 'todo' | 'building' | 'done';
  /**
   * The Design-stage SPECIFICATION for this story — three editable lists
   * (features / non-functional requirements / rules) the Design conversation
   * shapes and the Build stage ticks against. Optional + defaults to undefined
   * (no spec authored) so pre-spec apps load byte-identically; normalised on save
   * so a malformed payload can never widen the shape. See lib/software/story-spec.ts.
   */
  spec?: StorySpec;
};

/**
 * A DESIGN epic (Software golden path — Design stage). Groups user stories and
 * carries the technical / UX / governance requirements that shape them. Git/Jira
 * push is a labelled follow-up — the design lives on the app record for now.
 */
export type AppEpic = {
  id: string;
  title: string;
  description: string;
  requirements: { technical: string; ux: string; governance: string };
  stories: AppStory[];
};

/**
 * How an app is served (Phase D). The DEFAULT + every legacy record is 'image' (the
 * per-app container path); 'runtime' opts into the OS no-image runtime serving.
 */
export type ServeMode = 'image' | 'runtime';

/**
 * The ONE coercion for a persisted/incoming `serveMode`: only the explicit string
 * 'runtime' opts in; anything else (undefined on a legacy record, garbage, or the
 * explicit 'image') resolves to 'image'. Keeps the field byte-stable + nil-safe.
 */
export function normalizeServeMode(raw: unknown): ServeMode {
  return raw === 'runtime' ? 'runtime' : 'image';
}

/** The app's effective serve mode (nil-safe read for a possibly-legacy record). */
export function serveModeOf(app: Pick<App, 'serveMode'>): ServeMode {
  return normalizeServeMode(app.serveMode);
}

export type App = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /**
   * The app's stated PURPOSE — what it's for, in the builder's own words (Define
   * stage). Optional + defaults to '' so pre-Define apps still load; the Define
   * gate reads it (completed when non-empty).
   */
  purpose: string;
  /**
   * The DESIGN epics + user stories (Design stage). Optional + defaults to `[]` so
   * pre-Design apps still load; the Design gate completes at ≥1 epic with ≥1 story.
   */
  epics: AppEpic[];
  /**
   * Governed CONTEXT GRANTS the app may use — Connections · Data · Knowledge ·
   * Files · Metrics at Read / Read+propose / Read+write (the core ContextGrants
   * model). Replaces the bespoke single-connection consume UI on the Define stage.
   * Optional + defaults to an empty grants object so pre-grants apps still load.
   */
  grants: ContextGrants;
  template: AppTemplateKey;
  owner: string;
  domain: string;
  visibility: Visibility;
  /**
   * EXPLICIT app membership (least-privilege). The owner is the sole admin by
   * default and is implicit (never listed here), so an absent/empty list means
   * OWNER-ONLY — no other account has app-admin standing. Adding a user here grants
   * them `admin` (in-app Admin area) or `member` standing. This does NOT gate ENTRY
   * to the deployed app (identity is delegated to the OS session, domain-wide); it
   * is the app's own membership/admin model, replacing the old "whole domain
   * directory" display. Optional-on-load: pre-membership apps default to `[]`.
   */
  members: AppMember[];
  /**
   * The folder path this app lives under in the Software rail (default '/' = root).
   * A DISPLAY-only organiser — it NEVER affects the app's frozen `slug` (repo/image/
   * container/CI identity). Personal apps fold into the owner's personal tree; a
   * Shared/Certified app folds into the owning domain's tree (see folderScopeOfApp).
   * Optional-on-load: apps persisted before folders default to '/' in hydrateAppDoc.
   */
  folder: string;
  /** 'live' when Forgejo was reachable at create time; 'offline' otherwise. */
  mode: 'live' | 'offline';
  /**
   * HOW this app is served (Phase D — no-image runtime, behind the flag):
   *   • 'image'   (DEFAULT, and the value every legacy record loads as) — the app is
   *     served by a per-app container image the CI pipeline builds/pushes and the
   *     in-cluster runner pulls. The historic, unchanged path.
   *   • 'runtime' — the OS serves the app's committed tree DIRECTLY: it bundles the
   *     durable file mirror with esbuild (the Instant-Preview machinery) and serves
   *     the SPA from one platform surface in a sandboxed iframe. No per-app CI /
   *     image / registry / pod is needed; the repo/image become export products.
   * Optional-on-load so pre-flag records stay byte-stable — hydrateAppDoc defaults it
   * to 'image', and normalizeServeMode is the ONE coercion (only 'runtime' opts in).
   */
  serveMode?: ServeMode;
  repo: { fullName: string; htmlUrl: string; seeded: string[] };
  subdomain: string;
  /**
   * Explicit prebuilt container image the in-cluster runner should serve (Phase 2
   * runner). Optional: when unset the runner uses the CI-published registry
   * convention `<registry>/<slug>:latest` (or the SOFTWARE_RUNNER_IMAGE default).
   * We NEVER build images in-cluster — this is a reference to an already-built one.
   */
  runImage?: string;
  /**
   * The DIGEST-pinned image ref (`<registry>/<slug>@sha256:…`) the OS build service
   * (Phase B, build-service.ts) captured from its last SUCCESSFUL in-cluster build.
   * When set it is the AUTHORITATIVE serving ref: the runner pins to this exact
   * digest (no floating `:latest`, no roll hack), and a NEW digest is a real template
   * change that rolls the pods honestly. Unset ⇒ the runner falls back to the CI
   * `:latest` convention (the Forgejo Actions path), so this is purely additive.
   */
  runImageDigest?: string;
  pipeline: Record<PipelineStage, StageStatus>;
  /** Markdown captured from the build chat + the template. */
  designDecisions: string;
  dataDescriptions: string;
  docs: string;
  chat: AppChatMessage[];
  /** Personal artifact ids this app auto-registered for its data/files. */
  dataArtifactId: string | null;
  files: AppFile[];
  /** The auto-generated MCP connection id (app-registry). */
  connectionId: string | null;
  mcpPrincipal: string;
  mcpTools: AppTool[];
  /** Whether the auto-MCP capability profile (reads-on/writes-off) is compiled to OPA. */
  mcpProfileCompiled: boolean;
  /** active | archived (archive disables + retains; delete is lineage-aware). */
  status: AppStatus;
  /** The deploy state machine + the Builder-approved envelope. */
  deploy: {
    state: DeployState;
    previewUrl: string | null;
    /** The exact scope a Builder signed off on; null until first approval. */
    approved: DeployEnvelope | null;
    /** The open review card id when state === 'review'. */
    reviewCardId: string | null;
    /** Count of successful go-lives — the published release/version number (v{n}). */
    releases: number;
  };
  /** Parsed app.yaml / OpenAPI convention (metadata fidelity). */
  manifest: AppManifest;
  /** Resolved UI/API surface — a declaration wins, else inferred from what was built. */
  surface: AppSurface;
  /**
   * The creator's EXPLICIT surface declaration (`create_software` arg or `app.yaml`
   * `surface:`), when given. Intent: it wins over the heuristic on every re-detect,
   * so a UI app declared up front never regresses to "API" as the code changes.
   */
  declaredSurface?: SurfaceDeclaration;
  /** Governed resources the app actually consumes at run time (no raw creds). */
  consumes: ConsumedResource[];
  /** Whether "Use as Data" has snapshotted app data into a Bronze dataset. */
  usedAsData: boolean;
  /**
   * Phase C bounded CI-repair bookkeeping (ci-repair.ts). Optional-on-load: apps
   * persisted before auto-repair default to an enabled, never-attempted state in
   * hydrateAppDoc. Enforces "at most one auto-repair per failed run" + "no loop".
   */
  ciRepair?: CiRepairState;
  /**
   * Phase B OS-build-service bookkeeping (build-service.ts). Optional-on-load: apps
   * built before the build service default to a never-run state. Records which commit
   * the last in-cluster Kaniko build was submitted for + its outcome, so the status
   * card is truthful about WHICH system built (OS build service vs Forgejo Actions).
   */
  osBuild?: OsBuildState;
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------------------- Templates --

export type AppTemplateKey =
  | 'nextjs-supabase'
  | 'service'
  | 'script'
  | 'dashboard'
  | 'vite-os'
  | 'sovereign-app'
  | 'website'
  | 'api-service'
  | 'empty';

/** Runtime kind per template (drives the per-template/per-runtime adapter). */
export const TEMPLATE_RUNTIME: Record<AppTemplateKey, 'web' | 'service' | 'script' | 'dashboard'> = {
  'nextjs-supabase': 'web',
  'vite-os': 'web',
  'sovereign-app': 'web',
  website: 'web',
  'api-service': 'service',
  empty: 'web',
  service: 'service',
  script: 'script',
  dashboard: 'dashboard',
};

/** Templates that are governed OS frontends (Vite SPA + vendored @sovereign-os/ui + app-sdk). */
export const GOVERNED_FRONTEND_TEMPLATES: ReadonlySet<AppTemplateKey> = new Set(['vite-os', 'sovereign-app', 'website', 'empty']);

type Template = {
  key: AppTemplateKey;
  label: string;
  /** OpenCode-generated MCP tools for this template (read + write). */
  tools: (slug: string) => AppTool[];
  designDecisions: (name: string) => string;
  dataDescriptions: (name: string) => string;
  docs: (name: string, sub: string) => string;
  /** Files seeded into the per-app Forgejo repo (beyond auto_init's README). */
  files: (name: string, slug: string) => { path: string; content: string }[];
};

/**
 * The REAL build->push CI workflow seeded into every app repo. Runs on the
 * in-cluster Forgejo Actions runner inside the ci-builder job container, builds
 * the image via the in-pod DinD daemon (which trusts forgejo-http:3000 as an
 * insecure registry) and pushes `:latest` — the exact tag the OS app runner
 * pulls (lib/software/runner.ts imageRef). Modelled on the proven demo-app seed
 * workflow (charts/.../software/forgejo-seed.yaml). Login uses the REGISTRY_PASS
 * Actions secret set by scaffoldRepo(). No external actions (fully sovereign).
 */
function ciWorkflow(slug: string): string {
  // harborRegistry is "<host>/<owner>" (e.g. forgejo-http:3000/gitea_admin);
  // docker login needs the bare host, so split it out.
  const registry = config.harborRegistry.split('/')[0];
  const owner = config.forgejoRepoOwner;
  return (
    'on:\n' +
    '  push:\n' +
    '    branches: [main]\n' +
    'jobs:\n' +
    '  build-and-push:\n' +
    '    runs-on: docker\n' +
    '    env:\n' +
    '      DOCKER_HOST: tcp://localhost:2375\n' +
    '      REGISTRY: ' + registry + '\n' +
    '      OWNER: ' + owner + '\n' +
    '      REPO: ' + slug + '\n' +
    '    steps:\n' +
    '      - name: Checkout (manual — sovereign, no github.com)\n' +
    '        env: { REG_PASS: "${{ secrets.REGISTRY_PASS }}" }\n' +
    '        run: |\n' +
    '          set -eu\n' +
    '          git clone --depth 1 "http://${OWNER}:${REG_PASS}@${REGISTRY}/${OWNER}/${REPO}.git" src\n' +
    '      - name: Build & push image\n' +
    '        env: { REG_PASS: "${{ secrets.REGISTRY_PASS }}" }\n' +
    '        run: |\n' +
    '          set -eu\n' +
    '          TAG="$(echo "${GITHUB_SHA}" | cut -c1-12)"\n' +
    '          IMAGE="${REGISTRY}/${OWNER}/${REPO}"\n' +
    '          echo "${REG_PASS}" | docker login "${REGISTRY}" -u "${OWNER}" --password-stdin\n' +
    '          docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" ./src\n' +
    '          docker push "${IMAGE}:${TAG}"\n' +
    '          docker push "${IMAGE}:latest"\n' +
    prunePackagesStep()
  );
}

/**
 * How many container image versions to RETAIN per app (the newest N by push
 * time). The floating `:latest` tag is ALWAYS kept on top of these — it is what
 * the runner pulls (lib/software/runner.ts appImageRef). Everything older than
 * the newest N immutable SHA tags is pruned so Forgejo's in-cluster registry
 * volume (/data/packages) stops growing without bound and filling the disk.
 */
export const REGISTRY_KEEP_VERSIONS = 2;

/** One container package version as returned by Forgejo's packages REST API. */
export type ForgejoPackageVersion = {
  /** The image tag (a 12-char commit SHA for builds; `latest` for the float). */
  version: string;
  /** RFC3339 push time — the newest N are retained. */
  created_at?: string;
};

/** Tags that must NEVER be pruned regardless of age (the runner pulls these). */
const PROTECTED_TAGS = new Set(['latest']);

/**
 * PURE prune policy (unit-tested): given every container version of ONE app and
 * how many to keep, return the tags to DELETE — the versions OLDER than the
 * newest `keep` immutable tags, sorted by push time (newest first; ties broken
 * by tag so the result is deterministic). Protected floating tags (`latest`)
 * are never returned. When `keep` or fewer prunable versions exist, returns [].
 * The CI prune step (prunePackagesStep) implements this exact policy in shell;
 * this function is the executable spec the test pins.
 */
export function containerVersionsToPrune(
  versions: ForgejoPackageVersion[],
  keep: number = REGISTRY_KEEP_VERSIONS,
): string[] {
  const prunable = versions.filter((v) => v.version && !PROTECTED_TAGS.has(v.version));
  const sorted = [...prunable].sort((a, b) => {
    const ta = Date.parse(a.created_at ?? '') || 0;
    const tb = Date.parse(b.created_at ?? '') || 0;
    if (tb !== ta) return tb - ta; // newest first
    return a.version < b.version ? 1 : a.version > b.version ? -1 : 0;
  });
  return sorted.slice(Math.max(0, keep)).map((v) => v.version);
}

/**
 * The final, FAIL-OPEN CI step that prunes old container versions after a
 * successful push. Runs the SAME policy as containerVersionsToPrune: list this
 * app's container versions via Forgejo's packages REST API (same host + same
 * REGISTRY_PASS basic-auth as the push), keep the newest N SHA tags plus the
 * protected `latest`, and DELETE the rest. JSON is parsed with `node` — the
 * ci-builder job image is node:20-based (jq is NOT installed there), so node is
 * the one parser guaranteed present. Wrapped so ANY failure (API hiccup,
 * permission) prints a warning and exits 0 — a prune failure must NEVER fail a
 * green build.
 */
function prunePackagesStep(keep: number = REGISTRY_KEEP_VERSIONS): string {
  // Newest-first sort matches containerVersionsToPrune exactly (created_at desc,
  // tie-broken by tag desc). The node one-liner avoids single quotes so it can
  // ride inside the shell's single-quoted -e argument.
  const nodeSort =
    'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{try{' +
    'const n=process.env.REPO;const vs=JSON.parse(d)' +
    '.filter((p)=>p.name===n&&p.version!=="latest")' +
    '.sort((a,b)=>((Date.parse(b.created_at||"")||0)-(Date.parse(a.created_at||"")||0))||' +
    '(a.version<b.version?1:a.version>b.version?-1:0));' +
    'console.log(vs.map((v)=>v.version).join("\\n"))}catch(e){}})';
  return (
    '      - name: Prune old registry versions (keep newest ' + keep + ' + latest)\n' +
    '        env: { REG_PASS: "${{ secrets.REGISTRY_PASS }}" }\n' +
    '        run: |\n' +
    '          set +e\n' +
    '          KEEP=' + keep + '\n' +
    '          API="http://${OWNER}:${REG_PASS}@${REGISTRY}/api/v1"\n' +
    '          # List this app\'s container versions (newest first), drop the\n' +
    '          # protected `latest` float, then delete everything past the newest KEEP.\n' +
    '          # JSON parsed with node (the job image is node:20 — jq is not installed).\n' +
    '          PRUNABLE="$(curl -fsS "${API}/packages/${OWNER}?type=container&q=${REPO}&limit=1000" \\\n' +
    "            | REPO=\"${REPO}\" node -e '" + nodeSort + "' 2>/dev/null)\"\n" +
    '          if [ -z "${PRUNABLE}" ]; then echo "prune: nothing to prune"; exit 0; fi\n' +
    '          # Everything after the newest KEEP immutable tags is deleted.\n' +
    '          OLD="$(echo "${PRUNABLE}" | tail -n +$((KEEP+1)))"\n' +
    '          [ -z "${OLD}" ] && { echo "prune: <= ${KEEP} versions — nothing to prune"; exit 0; }\n' +
    '          echo "${OLD}" | while IFS= read -r V; do\n' +
    '            [ -z "${V}" ] && continue\n' +
    '            echo "prune: deleting ${REPO}:${V}"\n' +
    '            curl -fsS -X DELETE "${API}/packages/${OWNER}/container/${REPO}/${V}" \\\n' +
    '              || echo "prune: delete of ${V} failed (ignored)"\n' +
    '          done\n' +
    '          echo "prune: done (fail-open)"\n' +
    '          exit 0\n'
  );
}

function nextjsSupabaseTemplate(): Template {
  return {
    key: 'nextjs-supabase',
    label: 'Next.js + Supabase app',
    // GENERIC on purpose: a fresh app knows nothing about its domain yet, so it
    // seeds a neutral `records` starter (matching openapi.yaml/defaultOpenApi);
    // the build chat / first commits replace it with the app's real capabilities.
    tools: () => [
      { name: 'list_records', description: 'List records (read).', write: false },
      { name: 'get_record', description: 'Get one record by id (read).', write: false },
      { name: 'add_record', description: 'Add a record (write).', write: true },
      { name: 'export_records', description: 'Export records to a file (write).', write: true },
    ],
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Stack:** Next.js (App Router) frontend + Supabase (Postgres, Auth, Storage) backend.',
        '- **Data model:** a single `records` starter table (id, name, category, amount, due_on, status) — replace with the app\'s real model.',
        '- **Access:** Supabase Row-Level Security scopes every row to the signed-in owner.',
        '- **Operational vs analytical:** live app rows stay in Supabase; analytical copies follow',
        '  the Data golden path as a Personal data product.',
        '- **MCP:** capabilities are auto-exposed as governed tools (read: list/get; write: add/export).',
      ].join('\n'),
    dataDescriptions: (name) =>
      [
        `# ${name} — data descriptions`,
        '',
        '## Table: `records` (generic starter — replace with the real model)',
        '| field | type | meaning |',
        '|---|---|---|',
        '| `id` | uuid | primary key |',
        '| `name` | text | the record\'s display name |',
        '| `category` | text | free-form grouping |',
        '| `amount` | numeric | a numeric value, if relevant |',
        '| `due_on` | date | a relevant date, if any |',
        '| `status` | text | `active` \\| `done` \\| `archived` |',
      ].join('\n'),
    docs: (name, sub) =>
      [
        `# ${name}`,
        '',
        `Live at **https://${sub}** (once CI → Harbor → Argo CD have synced).`,
        '',
        '## Use',
        '1. Sign in (Supabase Auth).',
        '2. Add records; the list view sorts by `due_on`.',
        '3. Your agents can call the app MCP tools (`list_records`, `add_record`, …).',
      ].join('\n'),
    files: (name, slug) => [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: slug,
            private: true,
            scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
            dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', '@supabase/supabase-js': '^2.45.0' },
            // Seeded so `next build` type-checks the .tsx source without Next's
            // first-run auto-install (which needs network the DinD runner lacks).
            devDependencies: {
              typescript: '^5.6.0',
              '@types/node': '^22.0.0',
              '@types/react': '^19.0.0',
              '@types/react-dom': '^19.0.0',
            },
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'supabase/migrations/0001_init.sql',
        content:
          '-- Generic starter table; replace with the app\'s real data model.\n' +
          'create table if not exists records (\n' +
          '  id uuid primary key default gen_random_uuid(),\n' +
          '  owner uuid not null default auth.uid(),\n' +
          '  name text not null,\n' +
          '  category text,\n' +
          '  amount numeric,\n' +
          '  due_on date,\n' +
          "  status text not null default 'active'\n" +
          ');\n' +
          'alter table records enable row level security;\n' +
          'create policy "owner_rw" on records\n' +
          '  using (owner = auth.uid()) with check (owner = auth.uid());\n',
      },
      {
        path: 'app/layout.tsx',
        content:
          "export const metadata = { title: '" + name + "', description: 'Built by Sovereign Agentic OS.' };\n" +
          '\n' +
          'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
          '  return (\n' +
          '    <html lang="en">\n' +
          '      <body>{children}</body>\n' +
          '    </html>\n' +
          '  );\n' +
          '}\n',
      },
      {
        path: 'app/page.tsx',
        content:
          'export default function Page() {\n' +
          '  return (\n' +
          '    <main style={{ fontFamily: \'system-ui, sans-serif\', maxWidth: 640, margin: \'4rem auto\', padding: \'0 1.5rem\' }}>\n' +
          '      <h1>' + name + '</h1>\n' +
          '      <p>Built by Sovereign Agentic OS.</p>\n' +
          '    </main>\n' +
          '  );\n' +
          '}\n',
      },
      {
        path: 'Dockerfile',
        content:
          '# Next.js app — built by Sovereign Agentic OS CI -> Harbor -> Argo CD.\n' +
          '# Single stage: install, build, then serve Next\'s standalone output on 8080.\n' +
          'FROM node:22-alpine\n' +
          'WORKDIR /app\n' +
          '# No lockfile is seeded, so use npm install; do NOT swallow errors.\n' +
          'COPY package.json ./\n' +
          'RUN npm install\n' +
          'COPY . .\n' +
          'RUN npm run build\n' +
          '# next start reads PORT/HOSTNAME; the runner probes 8080 on 0.0.0.0.\n' +
          'ENV PORT=8080\n' +
          'ENV HOSTNAME=0.0.0.0\n' +
          'EXPOSE 8080\n' +
          'CMD ["npm","run","start"]\n',
      },
      {
        path: '.forgejo/workflows/ci.yml',
        content: ciWorkflow(slug),
      },
      {
        path: 'manifests/app.yaml',
        content:
          'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: ' + slug + ', labels: { app: ' + slug + ' } }\n' +
          'spec:\n  replicas: 1\n  selector: { matchLabels: { app: ' + slug + ' } }\n' +
          '  template:\n    metadata: { labels: { app: ' + slug + ' } }\n    spec:\n      containers:\n' +
          '        - name: ' + slug + '\n          image: ' + config.harborRegistry + '/' + slug + ':latest\n' +
          '          ports: [ { containerPort: 8080 } ]\n',
      },
      // The metadata convention (parsed on every commit → app page + auto-MCP).
      {
        path: 'app.yaml',
        content: renderAppYaml({
          name,
          owner: config.forgejoRepoOwner,
          description: `${name} — built in the Software tab.`,
          connections: [],
          data: [],
          knowledge: [],
        }),
      },
      { path: 'openapi.yaml', content: defaultOpenApi(slug) },
      {
        path: '.app/decisions.md',
        content: `# ${name} — design decisions\n\nCaptured under the app and versioned in git.\n`,
      },
    ],
  };
}

function genericTemplate(key: AppTemplateKey, label: string): Template {
  const base = nextjsSupabaseTemplate();
  return {
    ...base,
    key,
    label,
    tools: (slug) => [
      { name: `${slug.replace(/-/g, '_')}_status`, description: 'Health/status of the app (read).', write: false },
      { name: `${slug.replace(/-/g, '_')}_run`, description: 'Trigger the app (write).', write: true },
    ],
  };
}

function dashboardTemplate(): Template {
  const base = genericTemplate('dashboard', 'Dashboard-as-app');
  return {
    ...base,
    tools: (slug) => [
      { name: `${slug.replace(/-/g, '_')}_metrics`, description: 'Read the dashboard metrics (read).', write: false },
      { name: `${slug.replace(/-/g, '_')}_refresh`, description: 'Refresh the dashboard data (write).', write: true },
    ],
  };
}

/**
 * Vite + React + TypeScript + Tailwind + shadcn/ui SPA wired to the OS client SDK.
 * The generated app calls os.whoami() + os.context() on boot and renders the
 * app's granted context (datasets / metrics / knowledge) plus one live metric
 * sample — so a brand-new app already shows real governed data.
 *
 * Served as static files from nginx on port 8080 (multi-stage Dockerfile).
 * Uses permissive-licensed dependencies only (MIT / Apache-2.0 / BSD).
 */
function viteOsTemplate(): Template {
  return {
    key: 'vite-os',
    label: 'Vite + React OS app (SPA, nginx)',
    tools: (slug) => [
      { name: 'list_records', description: 'List records (read).', write: false },
      { name: 'get_record', description: 'Get one record by id (read).', write: false },
      { name: `${slug.replace(/-/g, '_')}_refresh`, description: 'Refresh the app data (write).', write: true },
    ],
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Stack:** Vite + React + TypeScript + Tailwind CSS + shadcn/ui primitives.',
        '- **OS integration:** `@sovereign-os/app-sdk` — `os.whoami()`, `os.context()`, `os.queryMetric()`.',
        '- **Data access:** governed grants (datasets / metrics / knowledge) — no raw credentials.',
        '- **Served by:** nginx on port 8080 via a multi-stage Docker build.',
        '- **MCP:** capabilities auto-exposed as governed tools (read: list/get; write: refresh).',
      ].join('\n'),
    dataDescriptions: (name) =>
      [
        `# ${name} — data descriptions`,
        '',
        '## Governed context',
        'The app consumes governed context from the OS SDK — datasets, metrics, and knowledge',
        'that a domain admin has explicitly granted. No raw data is embedded in the app.',
        '',
        '## Starter data model',
        '| field | type | meaning |',
        '|---|---|---|',
        '| `id` | string | record identifier |',
        '| `value` | number \\| string | primary value |',
        '| `unit` | string | unit of measure (optional) |',
      ].join('\n'),
    docs: (name, sub) =>
      [
        `# ${name}`,
        '',
        `Live at **https://${sub}** (once CI → Harbor → Argo CD have synced).`,
        '',
        '## Use',
        '1. Open the app — it calls `os.whoami()` and `os.context()` on boot.',
        '2. The starter page renders your granted datasets, metrics, and knowledge.',
        '3. Replace `src/App.tsx` with your real UI.',
        '4. Your agents can call the app MCP tools (`list_records`, `refresh`, …).',
      ].join('\n'),
    files: (name, slug) => [
      // The vite-os scaffold files (package.json, Dockerfile, src/*, nginx.conf, …)
      // come from the standalone template data module so they stay pure-data and
      // never get compiled by os-ui's own Next.js / tsc build.
      ...viteOsFiles(name, slug),
      // Append the CI workflow last — same ordering convention as nextjsSupabaseTemplate:
      // source files first, CI workflow last so the first push triggers the build
      // with the Dockerfile already committed.
      //
      // NOTE: viteOsFiles already includes .forgejo/workflows/ci.yml because it
      // follows the same "workflow is just another template file" shape.  The
      // scaffoldRepo() seeder re-orders: source first, workflows last.
    ],
  };
}

/**
 * The SOVEREIGN STANDARD APP — the default template for every NEW app. A rich
 * base app that already looks and behaves like a Sovereign OS app (AppShell nav,
 * OS-delegated identity, domain-scoped data helpers, an admin section, the MCP
 * top-bar link), so the Build stage only fills in business features epic-by-epic.
 * File set: lib/software/scaffolds/sovereign-app.ts. The scaffold guide (README)
 * doubles as the app's `docs`, so the Build assistant reads the same contract.
 */
function sovereignAppTemplate(): Template {
  const base = viteOsTemplate();
  return {
    ...base,
    key: 'sovereign-app',
    label: 'Sovereign standard app (OS identity, governed)',
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Stack:** Vite + React + TypeScript + Tailwind CSS + `@sovereign-os/ui` (AppShell + primitives).',
        '- **Identity:** DELEGATED to the OS — `os.whoami()` is the only user source; no local accounts.',
        '- **Tenancy:** owning domain derived from the app host; records scoped owner + domain (My / Domain).',
        '- **Admin:** in-app admin area for OS domain admins — settings placeholder + read-only OS user list.',
        '- **MCP:** capabilities exposed as governed tools; setup linked from the app top bar.',
        '- **Served by:** nginx on port 8080 via a multi-stage Docker build.',
      ].join('\n'),
    // The skeleton guide IS the docs: injected into the Build assistant's context.
    docs: (name, sub) =>
      [
        sovereignAppGuide(name, slugFromSubdomain(sub)),
        '',
        `Live at **https://${sub}** (once CI → registry → runner have synced).`,
      ].join('\n'),
    files: (name, slug) => sovereignAppFiles(name, slug),
  };
}

/** The slug is the first label of the app's per-app host. */
function slugFromSubdomain(sub: string): string {
  return sub.split('.')[0] || sub;
}

/**
 * The WEBSITE template — a public-facing site (landing/marketing style): the OS
 * theme tokens for coherence, but NO sign-in/admin/identity chrome. Same Vite
 * infra base as sovereign-app, so preview/CI/deploy are identical.
 */
function websiteTemplate(): Template {
  const base = viteOsTemplate();
  return {
    ...base,
    key: 'website',
    label: 'Website (public site, no sign-in)',
    tools: () => [
      { name: 'list_pages', description: 'List the site sections/pages (read).', write: false },
    ],
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Kind:** public website — NO sign-in, NO admin, NO identity chrome.',
        '- **Stack:** Vite + React + TypeScript; OS theme tokens (`@sovereign-os/ui/theme.css`) for coherence.',
        '- **Structure:** one SECTIONS registry (src/sections.tsx) drives nav + page; epics add sections.',
        '- **Served by:** nginx on port 8080 via the same sovereign CI as every app.',
      ].join('\n'),
    dataDescriptions: (name) =>
      [`# ${name} — data descriptions`, '', 'A public site: content lives in the code; no operational data model yet.'].join('\n'),
    docs: (name, sub) => [websiteGuide(name), '', `Live at **https://${sub}** (once CI → registry → runner have synced).`].join('\n'),
    files: (name, slug) => websiteFiles(name, slug),
  };
}

/**
 * The APIs-ONLY template — a headless governed service: a zero-dependency Node
 * HTTP server on the runner's port 8080, `surface: api` DECLARED so it is never
 * mislabeled as a UI app. Epics add endpoints (ROUTES table + openapi.yaml).
 */
function apiServiceTemplate(): Template {
  const base = viteOsTemplate();
  return {
    ...base,
    key: 'api-service',
    label: 'APIs only (headless service)',
    tools: () => [
      { name: 'healthz', description: 'Liveness/readiness of the service (read).', write: false },
      { name: 'hello', description: 'Hello endpoint — the starter capability (read).', write: false },
    ],
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Kind:** APIs only — headless, `surface: api`; no UI is ever served.',
        '- **Stack:** zero-dependency Node (node:http) on port 8080; ROUTES table in server.mjs.',
        '- **Contract:** every endpoint is declared in openapi.yaml (feeds the governed MCP tools).',
      ].join('\n'),
    dataDescriptions: (name) =>
      [`# ${name} — data descriptions`, '', 'A headless service: define its data model as endpoints take shape.'].join('\n'),
    docs: (name, sub) => [apiServiceGuide(name), '', `Live at **https://${sub}** (once CI → registry → runner have synced).`].join('\n'),
    files: (name, slug) => apiServiceFiles(name, slug),
  };
}

/** The EMPTY APP template — the bare minimum that builds/previews/deploys. */
function emptyAppTemplate(): Template {
  const base = viteOsTemplate();
  return {
    ...base,
    key: 'empty',
    label: 'Empty app (blank canvas)',
    tools: (slug) => [
      { name: `${slug.replace(/-/g, '_')}_status`, description: 'Health/status of the app (read).', write: false },
    ],
    designDecisions: (name) =>
      [`# ${name} — design decisions`, '', '- **Kind:** empty app — a blank canvas; decisions are made as epics land.'].join('\n'),
    dataDescriptions: (name) => [`# ${name} — data descriptions`, '', 'Nothing yet — a blank canvas.'].join('\n'),
    docs: (name, sub) => [emptyAppGuide(name), '', `Live at **https://${sub}** (once CI → registry → runner have synced).`].join('\n'),
    files: (name, slug) => emptyAppFiles(name, slug),
  };
}

const TEMPLATES: Record<AppTemplateKey, Template> = {
  'nextjs-supabase': nextjsSupabaseTemplate(),
  'vite-os': viteOsTemplate(),
  'sovereign-app': sovereignAppTemplate(),
  website: websiteTemplate(),
  'api-service': apiServiceTemplate(),
  empty: emptyAppTemplate(),
  service: genericTemplate('service', 'Service / API'),
  script: genericTemplate('script', 'Script / scheduled job'),
  dashboard: dashboardTemplate(),
};

// The CREATE PICKER — exactly four choices; `sovereign-app` ("Application") is
// the default. Legacy templates (vite-os, nextjs-supabase, service, script,
// dashboard) keep working for existing apps but are NOT offered here.
export const APP_TEMPLATES: { key: AppTemplateKey; label: string; blurb: string }[] = [
  {
    key: 'sovereign-app',
    label: 'Application',
    blurb: 'Full OS experience — sign in via your OS session, an Admin section with the user directory and settings, multi-tenant. Enables the whole flow: a UI to design, build and test.',
  },
  {
    key: 'website',
    label: 'Website',
    blurb: 'A public-facing site — clean pages, no sign-in or admin chrome. Full design→build→test→publish flow, without the OS session/Admin skeleton.',
  },
  {
    key: 'api-service',
    label: 'APIs only',
    blurb: 'A headless service — governed MCP endpoints, no user interface. Test checks the tool surface; there is no live-app iframe to preview.',
  },
  {
    key: 'empty',
    label: 'Empty App',
    blurb: 'A blank canvas that still builds and deploys. Bring your own structure; every stage stays available.',
  },
];

// ----------------------------------------------------------------- Registry ---

type AppCacheState = { cache: Map<string, App> | null };
const APP_STATE_KEY = Symbol.for('soa.apps.cache');
function appCacheState(): AppCacheState {
  const g = globalThis as unknown as Record<symbol, AppCacheState | undefined>;
  if (!g[APP_STATE_KEY]) g[APP_STATE_KEY] = { cache: null };
  return g[APP_STATE_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-_ ]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'app'
  );
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: config.appsIndex });

// Durable, per-artifact version history. Snapshots the user-editable doc content
// (designDecisions, dataDescriptions, docs) before each meaningful mutation.
const versions = versionLog('app');

function writeThrough(a: App): void {
  mirror.writeThrough(a.id, a);
}

/** The versioned slice of an app — the user-editable documentation fields. */
function snapshotState(a: App): { designDecisions: string; dataDescriptions: string; docs: string } {
  return { designDecisions: a.designDecisions, dataDescriptions: a.dataDescriptions, docs: a.docs };
}

function isOwnerOrAdminApp(a: App, user: CurrentUser): boolean {
  // Fail-closed edit-scope: owner always; a Personal app is owner-only (no admin/
  // domain_admin reaches another user's private app). A Shared / Certified app
  // admits an in-domain domain_admin or a platform admin.
  const scope: ArtifactScope = a.visibility === 'Personal' ? 'personal' : a.visibility === 'Certified' ? 'certified' : 'shared';
  return canManageArtifact(user, { owner: a.owner, domain: a.domain, scope });
}

/**
 * Normalise an app's explicit membership to a DETERMINISTIC, byte-stable shape:
 *   • drop malformed / non-object rows and rows with an unknown role,
 *   • drop the OWNER (they are always an implicit admin — never doubly listed),
 *   • de-duplicate by id (first role wins),
 *   • sort by id so serialisation is stable regardless of insertion order.
 * A missing/invalid list collapses to `[]` (owner-only). Pure — unit-testable.
 */
export function normalizeAppMembers(raw: unknown, owner: string): AppMember[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>([owner]);
  const out: AppMember[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const id = (r as { id?: unknown }).id;
    const role = (r as { role?: unknown }).role;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (role !== 'admin' && role !== 'member') continue;
    seen.add(id);
    out.push({ id, role });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Apply the back-compat normalisation + in-process connection re-hydration a
 *  persisted app doc needs on load. Shared by the bulk hydrate AND the by-id mirror
 *  fallback so both paths yield an identical, ready-to-use App. */
function hydrateAppDoc(app: App): App {
  // Back-compat: apps persisted before surface-detection get one inferred from
  // their scaffold (a persisted declaration still wins over the heuristic).
  if (!app.surface) {
    app.surface = resolveSurface(
      templateFiles(app.template, app.name, app.slug),
      app.declaredSurface,
    );
  }
  // Back-compat: apps persisted before Define/Design/grants must still load.
  if (typeof app.purpose !== 'string') app.purpose = '';
  if (!Array.isArray(app.epics)) app.epics = [];
  // Back-compat: apps persisted before explicit membership default to OWNER-ONLY.
  app.members = normalizeAppMembers(app.members, app.owner);
  // Back-compat: apps persisted before folders default to the root.
  if (typeof app.folder !== 'string') app.folder = '/';
  // Back-compat: apps persisted before the Phase D serve-mode flag default to 'image'
  // (the historic per-app-image path). Only an explicit 'runtime' opts into the OS
  // no-image runtime; normalizeServeMode collapses anything else to 'image'.
  app.serveMode = normalizeServeMode(app.serveMode);
  // Back-compat: apps persisted before Phase C CI-repair default to enabled + unattempted.
  if (!app.ciRepair || typeof app.ciRepair !== 'object') app.ciRepair = defaultCiRepairState();
  else if (typeof app.ciRepair.autoRepairEnabled !== 'boolean') app.ciRepair.autoRepairEnabled = true;
  // Back-compat: apps built before Phase B OS-build-service default to never-run.
  if (!app.osBuild || typeof app.osBuild !== 'object') app.osBuild = defaultOsBuildState();
  // Heal the repo link: apps scaffolded before repoHtmlUrl persisted Forgejo's
  // in-cluster `html_url` (http://forgejo-http:3000/…), which 404s in a browser.
  // Re-derive it from the full name against the EXTERNAL console URL on every load.
  if (app.repo?.fullName) app.repo.htmlUrl = repoHtmlUrl(app.repo.fullName);
  app.grants = normalizeContextGrants(app.grants);
  // Re-hydrate the in-process MCP grant so agents can call it after a restart.
  // rehydrateConnection is status-aware — it never resurrects an archived app.
  if (app.connectionId) rehydrateConnection(app);
  return app;
}

/** Authoritative by-id read: on a cache MISS, consult the durable mirror — a
 *  DIFFERENT server instance may have created the app after THIS instance
 *  hydrated its cache (the "commit → App not found" bug), so a bare map.get is
 *  not authoritative. Populates the cache on a mirror hit. Null ⇒ exists nowhere. */
async function getAppByIdWithMirror(appId: string): Promise<App | null> {
  const map = await getCache();
  const hit = map.get(appId);
  if (hit) return hit;
  const doc = (await mirror.getDoc(appId)) as App | null;
  if (!doc) return null;
  const app = hydrateAppDoc(doc);
  map.set(app.id, app);
  return app;
}

async function getCache(): Promise<Map<string, App>> {
  const s = appCacheState();
  if (s.cache) return s.cache;
  const map = new Map<string, App>();
  const docs = (await mirror.hydrate(500)) ?? []; // null → mirror down → in-memory only
  for (const app of docs as App[]) {
    hydrateAppDoc(app);
    map.set(app.id, app);
  }
  s.cache = map;
  return map;
}

/** Ensure the app registry and its version history are both hydrated. Used by the versions route. */
export async function ensureHydrated(): Promise<void> {
  await Promise.all([getCache(), versions.ensureHydrated()]);
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Reassigns the app's `domain` (the visibility-scoping field) and writes through.
 * NOTE: this reassigns visibility scope only; it does NOT move the app's Forgejo
 * repository. `sel.id` moves one; `sel.onlyUnassigned` sweeps only empty-domain
 * records. Returns the ids moved.
 */
export async function moveAppsDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): Promise<string[]> {
  const map = await getCache();
  const moved: string[] = [];
  for (const app of map.values()) {
    if (sel.id !== undefined && app.id !== sel.id) continue;
    if (sel.onlyUnassigned && app.domain) continue;
    if (app.domain === target) continue;
    app.domain = target;
    writeThrough(app);
    moved.push(app.id);
  }
  return moved;
}

// ------------------------------------------------------------------- Forgejo --

function authHeader(): string {
  const token = Buffer.from(`${config.forgejoUser}:${config.forgejoPassword}`).toString('base64');
  return `Basic ${token}`;
}

async function forgejoWrite(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${config.forgejoUrl}/api/v1${path}`, {
      method: 'POST',
      headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      /* non-JSON */
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * For a `vite-os` app, append the vendored OS-client SDK source and rewrite its
 * package.json to a local `file:` dependency. For every other template the file
 * set is returned unchanged. Keeps the deployed image buildable offline.
 */
function withVendoredSdk(tpl: Template, files: ScaffoldFile[]): ScaffoldFile[] {
  if (!GOVERNED_FRONTEND_TEMPLATES.has(tpl.key)) return files;
  const withDep = files.map((f) =>
    f.path === 'package.json' ? { ...f, content: applySdkFileDep(f.content) } : f,
  );
  return [...withDep, ...vendorSdkForRepo()];
}

/**
 * For a `vite-os` app, append the vendored OS design-system source
 * (`@sovereign-os/ui` — theme + AppShell + primitives) and rewrite its package.json
 * to a local `file:` dependency, exactly mirroring `withVendoredSdk`. So the built
 * Docker image resolves `import { AppShell } from '@sovereign-os/ui'` and
 * `@import '@sovereign-os/ui/theme.css'` offline/sovereignly. Other templates pass
 * through unchanged.
 */
function withVendoredUi(tpl: Template, files: ScaffoldFile[]): ScaffoldFile[] {
  if (!GOVERNED_FRONTEND_TEMPLATES.has(tpl.key)) return files;
  const withDep = files.map((f) =>
    f.path === 'package.json' ? { ...f, content: applyUiFileDep(f.content) } : f,
  );
  return [...withDep, ...vendorUiForRepo()];
}

/**
 * Bake the OS's public URL into a seeded CI workflow so the built app image
 * carries the correct OS base URL (the Dockerfile declares `ARG OS_API_URL`,
 * Vite reads it as `VITE_OS_API`). WITHOUT this the `docker build ... ./src`
 * step passes no build arg, `VITE_OS_API=""`, and the deployed app's
 * `os.whoami()` hits its OWN origin (nginx serves index.html → the app crashed
 * with a JSON parse error on `'<'`).
 *
 * We rewrite the `docker build` line to add `--build-arg OS_API_URL=<osPublicUrl>`.
 * Idempotent: skips if a build-arg is already present. When the OS public URL is
 * unknown (`''`, e.g. local dev) the workflow is returned UNCHANGED — the app then
 * derives the OS origin from its host at runtime (scaffold app-meta.ts) or runs
 * same-origin, so nothing breaks locally.
 *
 * Exported for unit tests. Value is single-quoted for the shell; the OS public URL
 * is an operator-set env var (not user input), and we defensively reject a value
 * containing a single quote.
 */
export function bakeOsApiUrlIntoWorkflow(content: string, osPublicUrl: string): string {
  const url = (osPublicUrl ?? '').trim().replace(/\/+$/, '');
  if (!url || url.includes("'") || url.includes('\n')) return content;
  // Match a `docker build` invocation and inject the build arg right after it,
  // unless one is already there (idempotent on re-scaffold / self-heal).
  return content.replace(/docker build\b(?![^\n]*--build-arg OS_API_URL=)/g, (m) =>
    `${m} --build-arg OS_API_URL='${url}'`,
  );
}

/** Apply {@link bakeOsApiUrlIntoWorkflow} to every seeded workflow file. */
function withBakedOsApiUrl(files: ScaffoldFile[]): ScaffoldFile[] {
  const url = config.osPublicUrl;
  if (!url) return files;
  return files.map((f) =>
    f.path.startsWith('.forgejo/workflows/')
      ? { ...f, content: bakeOsApiUrlIntoWorkflow(f.content, url) }
      : f,
  );
}

/**
 * Idempotently (re)assert the repo-level Actions secrets the seeded CI workflow
 * depends on — today exactly one: REGISTRY_PASS (checkout clone + registry login).
 * Forgejo's PUT creates or overwrites, so calling this is always safe. Used at
 * seed time AND as a self-heal when a run fails (refreshActionsStage), so a
 * missing/rotated secret can never permanently brick an app's CI.
 */
async function ensureRepoActionsSecrets(owner: string, repo: string): Promise<boolean> {
  const r = await forgejoApi('PUT', `/repos/${owner}/${repo}/actions/secrets/REGISTRY_PASS`, {
    data: config.forgejoPassword,
  });
  return r.ok;
}

/**
 * The BROWSABLE repo URL for a `owner/slug` full name — ALWAYS built from the
 * EXTERNAL Forgejo console URL (`FORGEJO_CONSOLE_URL`), never from Forgejo's own
 * API `html_url`. Forgejo derives its `html_url` from its in-cluster `ROOT_URL`
 * (`http://forgejo-http:3000/…`), a host a BROWSER cannot resolve — storing that
 * gave every "open repo" link a 404. This is the ONE source of truth for the repo
 * link the UI + agents surface, so the external host is used consistently.
 */
export function repoHtmlUrl(fullName: string): string {
  const base = config.forgejoConsoleUrl.replace(/\/+$/, '');
  const path = String(fullName ?? '').replace(/^\/+/, '');
  return path ? `${base}/${path}` : base;
}

/**
 * Best-effort: create the per-app Forgejo repo + seed the template files. Returns
 * a live result when Forgejo is reachable, or an offline shell otherwise — the
 * golden path still works for teaching, honestly labelled.
 */
async function scaffoldRepo(
  slug: string,
  description: string,
  tpl: Template,
  name: string,
): Promise<{ mode: 'live' | 'offline'; fullName: string; htmlUrl: string; seeded: string[]; createStatus: number; filesOnDisk: boolean }> {
  const owner = config.forgejoRepoOwner;
  const create = await forgejoWrite('/user/repos', {
    name: slug,
    description: description || `Scaffolded by the Sovereign Agentic OS (${tpl.label})`,
    private: true,
    auto_init: true,
    default_branch: 'main',
  });
  const fullName = String(create.data?.full_name ?? `${owner}/${slug}`);
  // ALWAYS the external browsable URL — Forgejo's own `html_url` points at the
  // in-cluster ROOT_URL the browser can't reach (the "repo link 404" the user hit).
  const htmlUrl = repoHtmlUrl(fullName);
  // Forgejo refuses to create a repo when its files ALREADY EXIST on disk (an
  // orphaned/unadopted repo). It answers 500 with a message naming the disk-path
  // collision. Surface that distinctly so heal can report "files on disk, not
  // adoptable" instead of a generic failure.
  const createMsg = String((create.data as { message?: unknown })?.message ?? '').toLowerCase();
  const filesOnDisk = !create.ok && /already exist|repository files|is not empty|directory already/.test(createMsg);
  if (!create.ok && create.status === 0) {
    // Forgejo unreachable -> offline shell.
    return { mode: 'offline', fullName, htmlUrl, seeded: [], createStatus: 0, filesOnDisk: false };
  }
  // The CI workflow logs in to the registry with the REGISTRY_PASS Actions
  // secret; set it before seeding the workflow so the first push can build.
  // (Admin creds — the same local-dev convenience the demo-app seed uses.)
  await ensureRepoActionsSecrets(owner, slug);
  const seeded: string[] = [];
  // Seed the SOURCE first (Dockerfile + manifests + app.yaml …) and the Actions
  // workflow LAST, exactly like the proven demo-app seed: each contents-API PUT is
  // its own commit, and the commit that ADDS `.forgejo/workflows/ci.yml` is the
  // push that first triggers CI. If the workflow lands before the Dockerfile, that
  // trigger fires against a tree with no build context and the run cannot build an
  // image — so the workflow must be the final file committed.
  const isWorkflow = (p: string) => p.startsWith('.forgejo/workflows/');
  // Governed-frontend apps (vite-os) import `@sovereign-os/app-sdk` AND wear the OS
  // design system `@sovereign-os/ui`. VENDOR both sources into the repo + rewrite
  // package.json to local `file:` deps so the built Docker image resolves them with
  // no external registry — fully sovereign / offline. (Order: SDK first, then UI —
  // each rewrites the package.json dep it owns and appends its own vendor/ files.)
  // Bake the OS public URL into the CI workflow's `docker build` so the deployed
  // image knows how to reach the OS across subdomains (the SSO/whoami base URL).
  const baseFiles = withBakedOsApiUrl(withVendoredUi(tpl, withVendoredSdk(tpl, tpl.files(name, slug))));
  const ordered = [
    ...baseFiles.filter((f) => !isWorkflow(f.path)),
    ...baseFiles.filter((f) => isWorkflow(f.path)),
  ];
  for (const f of ordered) {
    const r = await forgejoWrite(`/repos/${owner}/${slug}/contents/${f.path}`, {
      content: b64(f.content),
      message: `seed ${f.path}`,
      branch: 'main',
    });
    if (r.ok) seeded.push(f.path);
  }
  return { mode: 'live', fullName, htmlUrl, seeded, createStatus: create.status, filesOnDisk };
}

// ------------------------------------------------------------- Code editor ----
//
// Read/edit/commit an app's source straight from its per-app Forgejo repo
// (Software golden path §2 — the in-browser code editor beside the OpenCode
// build assistant). Reuses the SAME Basic-auth credentials the scaffolder above
// already uses (config.forgejoUser/forgejoPassword, wired into os-ui via the
// chart's FORGEJO_* env + forgejo secret) — no new secret, nothing hardcoded.
// Gated to Builders + Administrators here AND in the API route, and audited
// through the same Langfuse spine as every other governed action.

export type RepoFileMeta = { mode: 'live' | 'offline'; branch: string; files: string[] };
export type RepoFile = { path: string; content: string; sha: string };
export type RepoCommit = { path: string; sha: string; commitUrl: string | null };

/** Builder+ only — the code editor mutates the app's repo. */
function ensureBuilder(user: CurrentUser): void {
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('The code editor is available to Builders and Administrators.'), 403);
  }
}

function unreachable(): Error {
  return withStatus(
    new Error('Forgejo is unreachable — the code editor needs the Forgejo service running.'),
    502,
  );
}

/** Reject absolute / parent-traversal paths before they reach Forgejo. */
function sanitizeRepoPath(p: string): string {
  const clean = (p ?? '').replace(/^\/+/, '').trim();
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw withStatus(new Error('Invalid file path'), 400);
  }
  return clean;
}

function encodeRepoPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function repoCoords(app: App): { owner: string; repo: string } {
  const [owner, repo] = app.repo.fullName.split('/');
  return { owner: owner || config.forgejoRepoOwner, repo: repo || app.slug };
}

/** Generic Forgejo API request (any verb). status 0 means "unreachable". */
async function forgejoApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${config.forgejoUrl}/api/v1${path}`, {
      method,
      headers: { authorization: authHeader(), accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `{owner}/{repo}` an UNADOPTED repository — files present on disk with NO DB
 * record? This is the DB/disk-desync state (the northpeak-products loss): the repo
 * API-404s yet its bare git dir still holds every commit. Forgejo's admin API lists
 * exactly these so an admin can re-register them.
 *
 * Uses the SAME admin credential (`config.forgejoUser`/`forgejoPassword`) that the
 * server already uses for `POST /api/v1/admin/users` + token minting — a Forgejo
 * SITE ADMIN, so the `/admin/unadopted` endpoints are in reach. `pattern` narrows the
 * scan server-side; we still confirm the exact `owner/repo` in the returned list.
 *
 * `reachable:false` means Forgejo answered non-2xx (or was unreachable) — the caller
 * must NOT treat that as "not unadopted"; a 401/403 there means the token can't call
 * the admin API and heal should say so rather than blindly re-scaffold.
 */
async function isUnadopted(owner: string, repo: string): Promise<{ reachable: boolean; listed: boolean; status: number }> {
  const res = await forgejoApi(
    'GET',
    `/admin/unadopted?pattern=${encodeURIComponent(repo)}&page=1&limit=50`,
  );
  if (!res.ok) return { reachable: false, listed: false, status: res.status };
  // The endpoint returns a JSON array of "owner/repo" strings.
  const list = Array.isArray(res.data) ? (res.data as unknown[]) : [];
  const target = `${owner}/${repo}`.toLowerCase();
  const listed = list.some((e) => typeof e === 'string' && e.toLowerCase() === target);
  return { reachable: true, listed, status: res.status };
}

/** Flat, recursive list of the app repo's files (blobs) on the default branch. */
export async function listAppFiles(appId: string, user: CurrentUser): Promise<RepoFileMeta> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  return repoTree(app);
}

/**
 * READ-ONLY tree for anyone who can SEE the app (the MCP read-back counterpart of
 * the Builder-gated code editor above). The gate is the same visibility rule as
 * `getAppForUser` — reading the tree mutates nothing, so it does not need the
 * Builder floor the editor's write path carries.
 */
export async function listAppFilesForViewer(appId: string, user: CurrentUser): Promise<RepoFileMeta> {
  const app = await getAppForUser(appId, user);
  return repoTree(app);
}

export type DirEntry = { name: string; path: string; type: 'file' | 'dir' };

/**
 * The IMMEDIATE children of a directory, derived from the app's flat file tree.
 * Given every file path in the repo and a directory prefix, returns each direct
 * child once — a file (`type:'file'`) or a subdirectory (`type:'dir'`), never the
 * whole recursive subtree. `dir` may carry a trailing slash or be '' (the root).
 * Pure + source-agnostic: works over the live Forgejo tree AND the offline snapshot,
 * so `read_app_files` can answer a directory path with a listing instead of a dead
 * end (the build agent passed `src/epics` and hit "not an editable file" live).
 */
export function dirListing(files: string[], dir: string): DirEntry[] {
  const prefix = dir.replace(/^\/+|\/+$/g, '');
  const base = prefix ? `${prefix}/` : '';
  const seen = new Map<string, DirEntry>();
  for (const path of files) {
    if (base && !path.startsWith(base)) continue;
    const rest = path.slice(base.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { name: rest, path: base + rest, type: 'file' });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { name, path: base + name, type: 'dir' });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

async function repoTree(app: App): Promise<RepoFileMeta> {
  const { owner, repo } = repoCoords(app);
  const branch = 'main';
  const res = await forgejoApi('GET', `/repos/${owner}/${repo}/git/trees/${branch}?recursive=true&per_page=1000`);
  if (res.status === 0) throw unreachable();
  // Empty repo / no main branch yet — surface an empty tree, not an error.
  if (res.status === 404 || res.status === 409) return { mode: app.mode, branch, files: [] };
  if (!res.ok) throw withStatus(new Error(`Forgejo error listing files (${res.status}).`), 502);
  const data = res.data as { tree?: { path: string; type: string }[] };
  const files = (data?.tree ?? [])
    .filter((t) => t.type === 'blob' && typeof t.path === 'string')
    .map((t) => t.path)
    .sort((a, b) => a.localeCompare(b));
  return { mode: app.mode, branch, files };
}

/**
 * The app's LIVE repo tree (path + content) straight from Forgejo — the code that
 * will actually ship. The deploy security scan reads THIS when Forgejo is
 * reachable, so editor saves and direct `git push`es are scanned too (the
 * in-process snapshot only sees what flowed through `commitToApp`). Returns null
 * when Forgejo is unreachable or the repo is empty/unreadable — the caller falls
 * back to the snapshot, honestly labelled offline. Bounded (`maxFiles`), and an
 * unreadable blob (binary/oversized) is skipped so the rest still gets scanned.
 */
export async function liveRepoFiles(app: App, maxFiles = 300): Promise<ScaffoldFile[] | null> {
  try {
    const tree = await repoTree(app);
    if (tree.files.length === 0) return null; // empty/uninitialised repo → snapshot
    const out: ScaffoldFile[] = [];
    for (const path of tree.files.slice(0, maxFiles)) {
      try {
        const f = await repoRead(app, path);
        out.push({ path: f.path, content: f.content });
      } catch {
        /* non-file / binary blob — skip it, scan the rest */
      }
    }
    return out.length > 0 ? out : null;
  } catch {
    return null; // Forgejo unreachable / API error → snapshot fallback
  }
}

/**
 * The app's CURRENT frontend files for the in-browser instant preview, resolved on
 * the same honest ladder the rest of the tab uses: LIVE Forgejo tree → in-process
 * snapshot → fresh template. VIEW-gated only (getAppForUser), so any user who can
 * see the app can preview it; the preview itself calls the OS as the signed-in user
 * so governance still decides what data renders. `mode` tells the UI which source
 * it got (live vs the committed snapshot/template) so it can label honestly.
 */
export async function previewFilesForApp(
  appId: string,
  user: CurrentUser,
): Promise<{ files: ScaffoldFile[]; template: AppTemplateKey; mode: 'live' | 'snapshot' }> {
  const app = await getAppForUser(appId, user);
  const live = await liveRepoFiles(app);
  if (live && live.length > 0) {
    // BACKFILL/heal-forward: a successful live tree read durably seeds the mirror
    // (idempotent), so a legacy app with no mirror doc gets one from real code.
    snapshotFiles(app.id, live);
    return { files: live, template: app.template, mode: 'live' };
  }
  // Cold-process fallback survives a restart: hydrate the durable mirror first.
  await hydrateSnapshot(app.id);
  const snap = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
  return { files: snap, template: app.template, mode: 'snapshot' };
}

/** Read one file's decoded UTF-8 content + its current blob SHA (for commit). */
export async function readAppFile(appId: string, user: CurrentUser, path: string): Promise<RepoFile> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  return repoRead(app, path);
}

/** READ-ONLY single-file read for anyone who can SEE the app (view gate only). */
export async function readAppFileForViewer(appId: string, user: CurrentUser, path: string): Promise<RepoFile> {
  const app = await getAppForUser(appId, user);
  return repoRead(app, path);
}

async function repoRead(app: App, path: string): Promise<RepoFile> {
  const clean = sanitizeRepoPath(path);
  const { owner, repo } = repoCoords(app);
  const res = await forgejoApi('GET', `/repos/${owner}/${repo}/contents/${encodeRepoPath(clean)}?ref=main`);
  if (res.status === 0) throw unreachable();
  if (res.status === 404) throw withStatus(new Error('File not found.'), 404);
  if (!res.ok) throw withStatus(new Error(`Forgejo error reading file (${res.status}).`), 502);
  const d = res.data as { content?: string; encoding?: string; sha?: string; type?: string };
  if (d?.type !== 'file' || typeof d.content !== 'string') {
    throw withStatus(new Error('That path is not an editable file.'), 400);
  }
  const content = d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content;
  return { path: clean, content, sha: String(d.sha ?? '') };
}

/**
 * Save = commit. Writes the file back to the app's Forgejo repo on `main` via
 * the contents API, using the blob SHA the editor loaded for optimistic
 * concurrency (a stale SHA -> 409 "reload and retry"). Audited like every other
 * governed mutation.
 */
export async function saveAppFile(
  appId: string,
  user: CurrentUser,
  input: { path: string; content: string; sha: string; message?: string },
): Promise<RepoCommit> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  const clean = sanitizeRepoPath(input.path);
  const { owner, repo } = repoCoords(app);
  const message =
    (input.message ?? '').trim() || `Edit ${clean} via Sovereign Agentic OS code editor`;
  const res = await forgejoApi('PUT', `/repos/${owner}/${repo}/contents/${encodeRepoPath(clean)}`, {
    content: Buffer.from(input.content, 'utf8').toString('base64'),
    message,
    sha: input.sha || undefined,
    branch: 'main',
    author: { name: user.name, email: `${user.id}@${app.domain}` },
  });
  if (res.status === 0) throw unreachable();
  if (res.status === 404) throw withStatus(new Error('File not found in repo.'), 404);
  if (res.status === 409 || res.status === 422) {
    throw withStatus(new Error('File changed since you loaded it — reload and retry.'), 409);
  }
  if (!res.ok) throw withStatus(new Error(`Forgejo error saving file (${res.status}).`), 502);
  const d = res.data as { content?: { sha?: string }; commit?: { html_url?: string } };
  // Keep the scan/diff snapshot in step with the editor save — without this, a
  // secret pasted here was INVISIBLE to the deploy security scan when offline.
  // Hydrate the durable mirror first so a save after a pod restart merges over the
  // app's REAL tree, not the bare template seed.
  await hydrateSnapshot(app.id);
  const prior = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
  snapshotFiles(app.id, [...prior.filter((f) => f.path !== clean), { path: clean, content: input.content }]);
  app.updatedAt = now();
  writeThrough(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'edit_file', path: clean, by: user.id, role: user.role },
    output: { repo: app.repo.fullName, commit: d?.commit?.html_url ?? null },
    decision: 'allow',
  });
  return { path: clean, sha: String(d?.content?.sha ?? ''), commitUrl: d?.commit?.html_url ?? null };
}

/**
 * PURE guard (unit-tested): is this app's Forgejo repo (owner/slug) still the
 * home-of-record for a DIFFERENT, LIVE app? App repos key on the frozen `slug`
 * (repo/image identity), so a delete-then-recreate of "the same app" across
 * failed sessions can leave TWO app records sharing one `slug`. Deleting the repo
 * for the record being torn down would then silently wipe the OTHER (still-active)
 * app's code — exactly the "active app repo vanished, record survived" failure
 * this investigation traced. Returns the id of the conflicting live app when one
 * exists (so the caller SKIPS the physical delete), else null. `self` is excluded
 * (an app never blocks its own delete); archived apps do not count as live
 * consumers (their repo is meant to persist for unarchive but not to veto a peer).
 */
export function repoSharedByLiveApp(
  self: App,
  all: Iterable<App>,
): string | null {
  const mySlug = repoCoords(self).repo;
  for (const other of all) {
    if (other.id === self.id) continue;
    if (other.status !== 'active') continue;
    if (repoCoords(other).repo === mySlug) return other.id;
  }
  return null;
}

/**
 * PHYSICALLY delete the app's per-app Forgejo repo (the counterpart of
 * `scaffoldRepo`). Called on app DELETE only — archive keeps the repo so unarchive
 * can re-provision. Best-effort + HONEST: a 404 (already gone / never created) is a
 * benign success; an unreachable Forgejo (`status:0`) or a rejected delete is
 * reported so the delete never silently claims the repo is gone. Idempotent.
 *
 * GUARD: never delete a repo whose `slug` is still referenced by another ACTIVE
 * app record. A delete-then-recreate churn (the multi-session case) can leave a
 * second app record sharing this slug; physically deleting the repo here would
 * wipe that live peer's code (the class of failure that left an active app's repo
 * gone while its record survived). When a live peer shares the slug we SKIP the
 * delete and report it honestly rather than destroy a repo still in use.
 */
export async function deleteAppRepo(
  app: App,
): Promise<{ ok: boolean; live: boolean; action: 'deleted' | 'noop'; detail: string }> {
  const { owner, repo } = repoCoords(app);
  // Guard: another live app still owns this slug's repo — do NOT delete it.
  const map = await getCache();
  const sharedWith = repoSharedByLiveApp(app, map.values());
  if (sharedWith) {
    return {
      ok: true,
      live: true,
      action: 'noop',
      detail: `Kept Forgejo repo ${owner}/${repo} — still the home of active app ${sharedWith} (shared slug).`,
    };
  }
  const res = await forgejoApi('DELETE', `/repos/${owner}/${repo}`);
  if (res.status === 0) {
    return { ok: false, live: false, action: 'noop', detail: 'Forgejo unreachable — repo not deleted (orphan flagged).' };
  }
  if (res.status === 404) return { ok: true, live: true, action: 'noop', detail: 'No repo to delete.' };
  if (res.status === 204 || res.status === 200) {
    return { ok: true, live: true, action: 'deleted', detail: `Deleted Forgejo repo ${owner}/${repo}.` };
  }
  return { ok: false, live: true, action: 'noop', detail: `Forgejo rejected the repo delete (HTTP ${res.status}).` };
}

/**
 * SELF-HEAL a MISSING repo for an ACTIVE app. An app record whose Forgejo repo
 * has vanished (404) — however it went missing (out-of-band delete, a churned
 * session) — is dead in the water: the code editor 404s, deploy scans read an
 * empty tree, and CI can never rebuild an image with the app's real pages. This
 * re-provisions the repo from the SAME scaffold path `createApp` uses (repo +
 * REGISTRY_PASS secret + seeded template files + CI workflow last), then RE-SEEDS
 * any files still held in the in-process snapshot on top (a Build that ran this
 * process but never reached a durable git commit), so the recovered repo carries
 * as much of the real build as survived. HONEST + idempotent:
 *   • repo already present (any status but 404 on the existence probe) → no-op;
 *   • Forgejo unreachable → reported, nothing changed;
 *   • only fires for an ACTIVE app (archived repos are meant to stay torn down).
 * Returns what it did; the caller decides whether to bump the pipeline / roll CI.
 */
export async function healAppRepo(
  app: App,
): Promise<{ ok: boolean; action: 'adopted' | 'recreated' | 'noop'; detail: string; seeded: string[] }> {
  if (app.status !== 'active') {
    return { ok: true, action: 'noop', detail: 'App is not active — repo heal skipped.', seeded: [] };
  }
  const { owner, repo } = repoCoords(app);
  // Existence probe: only heal a genuine 404. Unreachable (0) is reported, not guessed.
  const probe = await forgejoApi('GET', `/repos/${owner}/${repo}`);
  if (probe.status === 0) {
    return { ok: false, action: 'noop', detail: 'Forgejo unreachable — repo not healed.', seeded: [] };
  }
  if (probe.status !== 404) {
    return { ok: true, action: 'noop', detail: `Repo ${owner}/${repo} already exists — nothing to heal.`, seeded: [] };
  }
  // ADOPT BEFORE CREATE — the DB/disk-desync recovery (the northpeak-products loss).
  // The repo API-404s because its DATABASE record vanished, but the bare repo may
  // still exist ON DISK (a DB restore/rollback while the repo PVC kept newer state).
  // Forgejo calls this an "unadopted" repository and can RE-REGISTER it in the DB with
  // every commit intact. Creating over it would be REJECTED (files already on disk) and
  // even if it weren't we'd overwrite the real build with a bare scaffold. So: if the
  // disk repo is listed unadopted, ADOPT it (preserving all history) and STOP — never
  // re-seed the scaffold on top of the recovered tree.
  const unadopted = await isUnadopted(owner, repo);
  if (unadopted.reachable && unadopted.listed) {
    const adopt = await forgejoApi('POST', `/admin/unadopted/${owner}/${repo}`);
    if (adopt.ok) {
      // VERIFY the adopt actually re-registered the repo — only claim success on a
      // fresh API-200 (never trust the POST's status alone).
      const recheck = await forgejoApi('GET', `/repos/${owner}/${repo}`);
      if (recheck.ok) {
        app.mode = 'live';
        app.pipeline.forgejo = 'ok';
        app.updatedAt = now();
        writeThrough(app);
        void trace({
          principal: app.mcpPrincipal,
          tool: 'generate',
          input: { action: 'repo-adopted', repo: `${owner}/${repo}` },
          output: { adopted: true },
          decision: 'allow',
        });
        return {
          ok: true,
          action: 'adopted',
          detail: `Adopted the orphaned repo ${owner}/${repo} from disk — its full history was recovered (no re-seed).`,
          seeded: [],
        };
      }
      return {
        ok: false,
        action: 'noop',
        detail: `Adopted ${owner}/${repo} but it still does not answer (HTTP ${recheck.status}) — admin attention needed.`,
        seeded: [],
      };
    }
    // Adopt call itself was rejected (403 = token lacks admin; otherwise a real error).
    const why = adopt.status === 403 || adopt.status === 401
      ? `the server's Forgejo credential cannot call the admin adopt API (HTTP ${adopt.status}) — admin attention needed.`
      : `Forgejo rejected the adopt (HTTP ${adopt.status}) — admin attention needed.`;
    return { ok: false, action: 'noop', detail: `The orphaned repo ${owner}/${repo} exists on disk but ${why}`, seeded: [] };
  }
  // The unadopted PROBE itself was denied (401/403) — the token can't call the admin
  // API, so we CANNOT know if the repo is orphaned on disk. Re-scaffolding blindly
  // risks a rejected create OR (worse) creating a bare shell — report honestly instead.
  if (!unadopted.reachable && (unadopted.status === 401 || unadopted.status === 403)) {
    return {
      ok: false,
      action: 'noop',
      detail: `Cannot heal ${owner}/${repo}: the server's Forgejo credential cannot query unadopted repositories (HTTP ${unadopted.status}) — an orphaned-on-disk repo can only be recovered by an admin.`,
      seeded: [],
    };
  }
  // Re-scaffold from the template (same path createApp uses).
  const tpl = TEMPLATES[app.template] ?? TEMPLATES['sovereign-app'];
  const scaffold = await scaffoldRepo(app.slug, app.description, tpl, app.name);
  if (scaffold.mode !== 'live') {
    return { ok: false, action: 'noop', detail: 'Forgejo unreachable during re-scaffold — repo not healed.', seeded: [] };
  }
  // HONESTY: `scaffoldRepo` reports `mode:'live'` whenever Forgejo ANSWERED, even if
  // the repo-create itself was REJECTED (403 quota/perms) and every seed then 404'd.
  // The existence probe just confirmed a genuine 404, so a re-provision that seeded
  // NOTHING truly failed — say so, don't claim a phantom `recreated`. (A create that
  // hit 409 "already exists" would still seed, so seeded.length>0 there.)
  if (scaffold.seeded.length === 0) {
    // The specific dead-end: the repo files EXIST on disk (create rejected for that
    // reason) but the unadopted list didn't offer them for adoption — Forgejo won't
    // adopt AND won't create over them. Name that exact state; don't hide it behind a
    // generic "missing repo" message the user can't act on.
    if (scaffold.filesOnDisk) {
      return {
        ok: false,
        action: 'noop',
        detail: `The repository files for ${owner}/${repo} exist on disk but Forgejo won't adopt them (not listed unadopted) and won't create over them — admin attention needed.`,
        seeded: [],
      };
    }
    return { ok: false, action: 'noop', detail: `Re-provisioning ${owner}/${repo} failed — the repo could not be re-created (no files seeded).`, seeded: [] };
  }
  // Re-seed the app's FULL last committed tree beyond the bare template so a lost
  // repo becomes FULLY recoverable. The tree comes from the DURABLE mirror (which
  // survives pod restarts) — hydrated first so heal works even after the process
  // that built the app is long gone (the northpeak-products loss). A legacy app
  // with no mirror doc falls back to whatever the in-process snapshot still holds;
  // an app with neither honestly restores just the template (no fabrication).
  await hydrateSnapshot(app.id);
  const seeded = [...scaffold.seeded];
  const snap = getSnapshot(app.id);
  if (snap && snap.length > 0) {
    const seededSet = new Set(seeded);
    for (const f of snap) {
      if (seededSet.has(f.path)) continue;
      const r = await forgejoWrite(`/repos/${owner}/${app.slug}/contents/${encodeRepoPath(f.path)}`, {
        content: b64(f.content),
        message: `heal: restore ${f.path} from mirror`,
        branch: 'main',
      });
      if (r.ok) seeded.push(f.path);
    }
  }
  // Record the recovered repo link on the app (fullName is stable; refresh seeded).
  app.repo = { fullName: scaffold.fullName, htmlUrl: scaffold.htmlUrl, seeded };
  app.mode = 'live';
  app.updatedAt = now();
  writeThrough(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'heal_app_repo', repo: `${owner}/${repo}` },
    output: { recreated: true, seeded: seeded.length },
    decision: 'allow',
  });
  return { ok: true, action: 'recreated', detail: `Re-provisioned ${owner}/${repo} (${seeded.length} files seeded).`, seeded };
}

// ------------------------------------------------------------ Actions health --

/** Throttle live Actions checks per app (the app page GET calls this on load). */
const actionsCheckedAt = new Map<string, number>();
const ACTIONS_CHECK_TTL_MS = 30_000;

export type ActionsHealth = { status: StageStatus; note: string | null };

/**
 * SELF-HEAL story built-ness — the honesty floor for the "phantom-built" bug.
 *
 * A story's `status:'done'` is a claim that its code was BUILT AND COMMITTED. But the
 * only writer of that status is a caller passing epics through `patchAppDesign`, and a
 * build agent used to self-report `done` (via `design_software`) even when its `commit`
 * failed or was never called — so an app could show "4 stories built" while its repo was
 * empty/404 and the Test stage (honestly gated on a real commit) stayed disabled.
 *
 * This reconciles the CLAIM against REALITY: if the app has NO committed code at all,
 * NO story can be `done`, so any persisted `done` is demoted to `todo`. "Has committed
 * code" is read from the honest signals the pipeline already maintains — a green Forgejo
 * scaffold stage (a real repo with a commit) OR a non-empty committed snapshot (the
 * offline-mock teaching tree). It never PROMOTES (that stays earned via a real commit),
 * so it can only make the record MORE honest. Idempotent + write-through; safe to call
 * on every load. Call AFTER `refreshActionsStage` so `pipeline.forgejo` reflects a 404'd
 * repo (demoted to 'failing') rather than a stale 'ok'.
 */
export function reconcileBuiltStatus(app: App): { demoted: number } {
  const hasEpicPages = (getSnapshot(app.id) ?? []).some((f) =>
    /^src\/epics\/[^/]+\/(?!general\/)[^/]+\/[A-Z][A-Za-z0-9]*\.tsx$/.test(f.path),
  );
  const hasRealCommit = app.pipeline.forgejo === 'ok' || app.repo.seeded.length > 0 || hasEpicPages;
  // A real, committed app: trust its per-story status (the earned post-commit flip). Only
  // an app with demonstrably nothing committed has its phantom `done` claims cleared.
  if (hasRealCommit) return { demoted: 0 };
  let demoted = 0;
  for (const epic of app.epics ?? []) {
    for (const story of epic.stories ?? []) {
      if (story.status === 'done' || story.status === 'building') {
        story.status = 'todo';
        demoted += 1;
      }
    }
  }
  if (demoted > 0) writeThrough(app);
  return { demoted };
}

/**
 * Recompute the pipeline `actions` stage HONESTLY from live Forgejo — and
 * SELF-HEAL the one repairable cause. 'ok' is earned, never assumed:
 *
 *   • Repo Actions unit disabled  → auto-enable it (`PATCH has_actions:true`,
 *     admin token, server-side, traced) — the next push builds. No support
 *     ticket, no Forgejo UI work.
 *   • Latest main commit's run SUCCEEDED   → 'ok' (a push really built).
 *   • Latest main commit's run FAILED      → 'failing' + re-assert the repo's
 *     REGISTRY_PASS Actions secret (the workflow's one dependency, idempotent).
 *   • Latest main commit's run in progress → 'pending', said as such.
 *   • Latest main commit has NO task       → 'stalled' + a repair hint —
 *     never the old unconditional "actions: ok".
 *
 * Mutates `app.pipeline.actions` (write-through) so the app card and
 * `get_software_status` show the same truth. Fail-soft: an unreachable Forgejo
 * leaves the stored stage untouched and SAYS so.
 */
export async function refreshActionsStage(app: App, opts?: { force?: boolean }): Promise<ActionsHealth> {
  if (app.mode !== 'live') return { status: app.pipeline.actions, note: null };
  const last = actionsCheckedAt.get(app.id) ?? 0;
  if (!opts?.force && Date.now() - last < ACTIONS_CHECK_TTL_MS) {
    return { status: app.pipeline.actions, note: null };
  }
  const { owner, repo } = repoCoords(app);
  const repoRes = await forgejoApi('GET', `/repos/${owner}/${repo}`);
  if (repoRes.status === 0) {
    return { status: app.pipeline.actions, note: 'Forgejo unreachable — Actions status not refreshed.' };
  }
  actionsCheckedAt.set(app.id, Date.now());
  const apply = (status: StageStatus, note: string | null): ActionsHealth => {
    if (app.pipeline.actions !== status) {
      app.pipeline.actions = status;
      writeThrough(app);
    }
    return { status, note };
  };
  // SYMMETRIC honesty: the 404 branch below downgrades `forgejo` to failing — so a
  // repo that answers again must upgrade it back, or the card stays stuck claiming
  // "repository missing" forever after a recovery (seen live on northpeak-products).
  if (repoRes.ok && app.pipeline.forgejo === 'failing') {
    app.pipeline.forgejo = 'ok';
    writeThrough(app);
  }
  if (!repoRes.ok) {
    // HONEST: a repo that 404s no longer exists — the whole pipeline is broken, not
    // "ok". Downgrade BOTH the `forgejo` (scaffold) stage AND `actions` to a failing
    // state so the status card stops claiming a green scaffold for a vanished repo
    // (the "forgejo: ok while repo 404" dishonesty). `healAppRepo` can re-provision it.
    if (repoRes.status === 404) {
      let changed = false;
      if (app.pipeline.forgejo !== 'failing') { app.pipeline.forgejo = 'failing'; changed = true; }
      if (app.pipeline.actions !== 'failing') { app.pipeline.actions = 'failing'; changed = true; }
      if (changed) writeThrough(app);
      return {
        status: 'failing',
        note: `The app's Forgejo repo ${owner}/${repo} no longer exists (HTTP 404) — CI cannot build. Re-provision the repo (heal) and push to rebuild.`,
      };
    }
    return { status: app.pipeline.actions, note: `Forgejo error reading the repo (HTTP ${repoRes.status}).` };
  }

  const hasActions = (repoRes.data as { has_actions?: boolean } | null)?.has_actions;
  if (hasActions === false) {
    // ONE-SHOT HEAL: a repo without the Actions unit can never build on push.
    const heal = await forgejoApi('PATCH', `/repos/${owner}/${repo}`, { has_actions: true });
    void trace({
      principal: app.mcpPrincipal,
      tool: 'generate',
      input: { action: 'heal_actions_unit', repo: `${owner}/${repo}` },
      output: { healed: heal.ok, status: heal.status },
      decision: 'allow',
    });
    if (!heal.ok) {
      return apply(
        'disabled',
        `The Actions unit is DISABLED on ${owner}/${repo} and auto-enable failed (HTTP ${heal.status}) — enable it under the repo's Settings → Units in Forgejo.`,
      );
    }
    return apply('pending', 'The Actions unit was disabled on the repo — auto-enabled it; the next push to main will build.');
  }

  const commits = await forgejoApi('GET', `/repos/${owner}/${repo}/commits?sha=main&limit=1`);
  const head =
    commits.ok && Array.isArray(commits.data) && commits.data[0]
      ? String((commits.data[0] as { sha?: string }).sha ?? '')
      : '';
  if (!head) return apply('pending', 'No commits on main yet — nothing for CI to build.');

  const tasks = await forgejoApi('GET', `/repos/${owner}/${repo}/actions/tasks`);
  if (!tasks.ok) {
    return apply('pending', `Could not read Actions tasks (HTTP ${tasks.status}) — not claiming a build that is unverified.`);
  }
  const runs = ((tasks.data as { workflow_runs?: { id?: number | string; head_sha?: string; status?: string }[] } | null)?.workflow_runs ?? []).filter(
    (r) => r && typeof r === 'object',
  );
  // Newest-first: the FIRST run for the head sha is the one that counts (re-runs).
  const headRun = runs.find((r) => String(r.head_sha ?? '') === head);
  if (headRun) {
    // HONEST job-status read: 'ok' means the run SUCCEEDED, not merely existed.
    const st = String(headRun.status ?? '');
    if (st === 'failure' || st === 'cancelled') {
      // ONE-SHOT HEAL for the workflow's single external dependency: re-assert
      // the REGISTRY_PASS Actions secret (idempotent, admin creds, traced) so a
      // missing/rotated secret is repaired before the next push.
      const healed = await ensureRepoActionsSecrets(owner, repo);
      void trace({
        principal: app.mcpPrincipal,
        tool: 'generate',
        input: { action: 'heal_actions_secrets', repo: `${owner}/${repo}`, runStatus: st },
        output: { healed },
        decision: 'allow',
      });
      // PHASE C — bounded CI-repair: this is the single place a failed run is RECORDED.
      // Fire the at-most-once auto-repair (fire-and-forget: it must never block or break
      // the status refresh it rides on). Re-asserting the secret above covers the ONE
      // self-healable dependency; the repair turn handles the build-env/asset/import
      // failures the compile gate cannot catch pre-commit. Skipped for non-live apps.
      const runId = String(headRun.id ?? '');
      if (runId) void triggerAutoRepair(app, { id: runId, headSha: head });
      // Always-honest, always-labelled visibility of the auto-repair on the SAME status
      // note the card/`get_software_status` read — so "CI failed → auto-repair (reasoning
      // model)" and its outcome are visible without a separate feed. Never claims a repair
      // that did not happen (driven by the persisted ciRepair state, not a hopeful guess).
      const repairNote = autoRepairNote(app, runId, head);
      return apply(
        'failing',
        `The latest CI run for ${head.slice(0, 10)} FAILED (status: ${st}). Re-asserted the repo's REGISTRY_PASS Actions secret${healed ? '' : ' (re-assert also failed)'}.${repairNote} Check the run log in Forgejo (${owner}/${repo} → Actions), fix the cause, then push again to rebuild.`,
      );
    }
    if (st && st !== 'success') {
      return apply('pending', `CI run for ${head.slice(0, 10)} is not finished yet (status: ${st}).`);
    }
    return apply('ok', null);
  }
  return apply(
    'stalled',
    `The latest push on main (${head.slice(0, 10)}) produced NO Actions run — CI is stalled. Check that .forgejo/workflows/ci.yml exists on main and that the last commit actually reached Forgejo, then re-commit to trigger a build.`,
  );
}

// -------------------------------------------------------- Phase C CI-repair I/O --

/**
 * The always-honestly-labelled auto-repair clause appended to the failing-CI status note
 * (consent + visibility). Reads ONLY the persisted `ciRepair` state — never claims a
 * repair that did not happen. Cases:
 *   • opted out          → says auto-repair is off.
 *   • repaired THIS run  → "auto-repair turn (reasoning model) committed a fix".
 *   • repaired commit re-failing → the honest terminal "still failing — needs a human".
 *   • attempted, no fix  → said as such.
 *   • not yet attempted  → "auto-repair (reasoning model) starting" (the fire-and-forget
 *                          turn was just kicked off on this same refresh).
 */
function autoRepairNote(app: App, runId: string, head: string): string {
  const s = app.ciRepair;
  if (!s || s.autoRepairEnabled === false) return ' Auto-repair is turned off for this app.';
  if (s.repairCommitSha && s.repairCommitSha === head) {
    return ' Auto-repair was attempted (reasoning model) but the repaired commit still fails CI — this needs a human or a fresh build turn.';
  }
  if (s.repairedRunId === runId) {
    if (s.outcome === 'repaired') return ' Auto-repair turn (reasoning model) committed a fix — CI will re-run on the new commit.';
    return ' Auto-repair turn (reasoning model) ran but found no safe fix to commit.';
  }
  return ' Auto-repair turn (reasoning model) is starting — it will fix only what the log names, then commit.';
}

/**
 * Public write-through so ci-repair.ts can persist its bounds state through the SAME
 * durable path every mutator here uses (no second store, no divergence).
 */
export function writeThroughApp(app: App): void {
  writeThrough(app);
}

/**
 * Owner/admin toggle for the app-level auto-repair opt-out (default ON). Edit-scoped
 * (owner or in-domain admin — same gate as docs edits). Turning it OFF stops any future
 * bounded CI auto-repair for THIS app; the per-run/no-loop bounds are untouched.
 */
export async function setAutoRepairEnabled(appId: string, user: CurrentUser, enabled: boolean): Promise<App> {
  const app = await getEditableAppForUser(appId, user);
  const state = app.ciRepair ?? defaultCiRepairState();
  app.ciRepair = { ...state, autoRepairEnabled: enabled };
  writeThrough(app);
  return app;
}

/**
 * Phase D: flip an app between the historic per-app-image serving and OS runtime
 * serving. Edit-scoped (owner / in-domain domain_admin / admin — `getEditableAppForUser`).
 *
 * SCOPE LIMIT, stated honestly: the OS runtime can only serve a Vite-shaped
 * sovereign-app/vite-os SPA (the one the Instant-Preview bundler + compile gate
 * understand). Opting a non-Vite shape into 'runtime' is REFUSED (400) rather than
 * silently accepted — the runtime surface could never bundle it. Switching BACK to
 * 'image' is always allowed (it just restores the historic path). Byte-stable no-op
 * when the mode is unchanged.
 */
export async function setAppServeMode(appId: string, user: CurrentUser, mode: ServeMode): Promise<App> {
  const app = await getEditableAppForUser(appId, user);
  const next = normalizeServeMode(mode);
  if (next === serveModeOf(app)) return app; // no-op — nothing to write
  if (next === 'runtime') {
    // Only a Vite-shaped SPA can be runtime-served. Detect off the CURRENT tree so
    // this reflects what would actually be bundled, not just the template label.
    const { files } = await previewFilesForApp(appId, user);
    const shape = detectPreviewShape(files.map((f) => f.path));
    if (shape.kind !== 'vite') {
      throw withStatus(
        new Error(
          'Runtime serving supports only Vite-shaped sovereign-app / vite-os apps ' +
            '(an src/main.tsx SPA). This app is a different shape, so it must keep image serving.',
        ),
        400,
      );
    }
  }
  app.serveMode = next;
  app.updatedAt = now();
  writeThrough(app);
  return app;
}

/**
 * Synthesize the CurrentUser an auto-repair build turn runs AS — the app's OWNER,
 * scoped to the app's domain, at the `builder` role (needs the commit/build tool
 * surface). This is a SERVER-INITIATED turn (no request session), so there is no
 * ambient user; the governed tool calls still run through authorize→trace as the
 * app's mcpPrincipal via boundArgs. Kept minimal + honest — it is not a login.
 */
export function systemUserForApp(app: App): CurrentUser {
  return {
    id: app.owner,
    name: app.owner,
    domains: [app.domain],
    allDomains: [app.domain],
    activeDomain: app.domain,
    role: 'builder',
  };
}

/**
 * Fetch + concatenate the failing run's job logs from Forgejo, returning the RAW text
 * (the caller cleans + caps it). Uses the admin credential already in `forgejoApi`.
 * Best-effort: any unreachable/absent log yields '' so the repair turn still runs off
 * the changed-file list. Forgejo exposes per-job logs under the Actions runs API; we
 * read the run's jobs, then each job's log, newest job last (errors sit at the end).
 */
export async function fetchRunLogTail(app: App, runId: string): Promise<string> {
  const { owner, repo } = repoCoords(app);
  // The run's jobs. Forgejo mirrors GitHub's Actions API shape here.
  const jobsRes = await forgejoApi('GET', `/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}/jobs`);
  const jobs = (jobsRes.data as { jobs?: { id?: number | string }[] } | null)?.jobs;
  const jobIds = Array.isArray(jobs)
    ? jobs.map((j) => String(j?.id ?? '')).filter(Boolean)
    : [];
  const parts: string[] = [];
  for (const jobId of jobIds) {
    // The logs endpoint returns plain text (not JSON) — forgejoApi falls back to the
    // raw string in `data` when the body is not JSON, so we read it as such.
    const logRes = await forgejoApi('GET', `/repos/${owner}/${repo}/actions/jobs/${encodeURIComponent(jobId)}/logs`);
    if (logRes.ok && typeof logRes.data === 'string' && logRes.data.trim()) parts.push(logRes.data);
  }
  return parts.join('\n');
}

/** The current head sha of the app repo's `main` branch, or '' when unavailable. */
export async function latestMainSha(app: App): Promise<string> {
  const { owner, repo } = repoCoords(app);
  const res = await forgejoApi('GET', `/repos/${owner}/${repo}/commits?sha=main&limit=1`);
  if (res.ok && Array.isArray(res.data) && res.data[0]) {
    return String((res.data[0] as { sha?: string }).sha ?? '');
  }
  return '';
}

/**
 * The list of file PATHS a commit changed (the failing commit's changeset), from the
 * Forgejo commit API. Best-effort: [] when the commit or endpoint is unavailable.
 */
export async function fetchCommitFiles(app: App, sha: string): Promise<string[]> {
  if (!sha) return [];
  const { owner, repo } = repoCoords(app);
  const res = await forgejoApi('GET', `/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`);
  if (!res.ok) return [];
  const files = (res.data as { files?: { filename?: string }[] } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files.map((f) => String(f?.filename ?? '')).filter(Boolean);
}

/**
 * Fire the bounded auto-repair for a freshly-recorded failed run — fire-and-forget so
 * it never blocks or breaks the status refresh it rides on. Dynamically imports the
 * loop (ci-repair.ts) to keep the apps.ts ↔ ci-repair.ts import graph acyclic at load.
 */
function triggerAutoRepair(app: App, failedRun: { id: string; headSha: string }): void {
  if (app.mode !== 'live') return;
  void import('@/lib/software/ci-repair')
    .then((m) => m.maybeAutoRepair(app, failedRun))
    .catch(() => {
      /* best-effort — the next refresh re-detects the same failure */
    });
}

// ----------------------------------------------------- Phase B OS build service --

/**
 * Assemble the injected `BuildRuntime` from `config` — the ONLY place the build
 * service's live wiring (registry host/owner, git host, admin credential, OS API URL)
 * is read. Kept here (server-side, has secrets) so build-service.ts stays pure/testable.
 * `harborRegistry` is `<host>/<owner>` (e.g. `forgejo-http:3000/gitea_admin`).
 */
function buildRuntimeFromConfig(): import('@/lib/software/build-service').BuildRuntime {
  const [registryHost, registryOwner] = config.harborRegistry.split('/');
  const gitHost = config.forgejoUrl.replace(/^https?:\/\//, '');
  return {
    namespace: config.softwareBuildNamespace,
    kanikoImage: config.kanikoImage,
    registryHost: registryHost || 'forgejo-http:3000',
    registryOwner: registryOwner || config.forgejoRepoOwner,
    gitHost,
    authUser: config.forgejoUser,
    authPassword: config.forgejoPassword,
    osApiUrl: config.osPublicUrl,
  };
}

/**
 * After a successful gated build-mode commit (Phase A), submit the in-cluster Kaniko
 * build for the app's new head commit and record the `harbor` (image build) stage
 * HONESTLY as "OS build service". Fire-and-forget: it must never block or break the
 * commit path it rides on. When the build service is OFF (flag/RBAC), it does NOTHING
 * — the Forgejo Actions path still serves — and the harbor stage note says so. Skipped
 * for a non-live app (no cluster/registry to build against).
 */
export function triggerOsBuild(app: App, sha: string): void {
  if (app.mode !== 'live') return;
  void submitOsBuild(app, sha).catch(() => {
    /* best-effort — the next refresh re-submits/re-polls */
  });
}

/**
 * The awaitable core of `triggerOsBuild` (tests + any caller that wants the outcome).
 * Submits the Kaniko build Job for `sha`, records the app's `osBuild` state, and flips
 * the `harbor` (image-build) pipeline stage HONESTLY: `pending` while the Job runs,
 * `failing` when the submit was rejected (RBAC/namespace absent — named specifically),
 * `offline` when the cluster was unreachable. A disabled build service is a NO-OP
 * (`submitted: false`) — the Forgejo Actions path still builds the serving image.
 */
export async function submitOsBuild(
  app: App,
  sha: string,
  client?: import('@/lib/software/build-service').K8sClient,
): Promise<{ submitted: boolean; ok: boolean; detail: string }> {
  const m = await import('@/lib/software/build-service');
  if (!m.buildServiceEnabled(config)) {
    return { submitted: false, ok: false, detail: m.BUILD_SERVICE_OFF_NOTE };
  }
  const rt = buildRuntimeFromConfig();
  const res = await m.submitBuildJob(app.slug, sha, rt, client);
  const state = app.osBuild ?? defaultOsBuildState();
  app.osBuild = {
    ...state,
    sha,
    jobName: res.run.jobName,
    phase: res.ok ? 'pending' : 'failed',
    updatedAt: new Date().toISOString(),
  };
  // The harbor (image-build) stage reflects the OS build service submission
  // honestly: pending while the Job runs, failing when we could not even submit
  // (RBAC/namespace/unreachable) — the Forgejo Actions path remains the fallback.
  const next: StageStatus = res.ok ? 'pending' : (res.reachable ? 'failing' : 'offline');
  if (app.pipeline.harbor !== next) app.pipeline.harbor = next;
  writeThrough(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'os_build_submit', slug: app.slug, sha: sha.slice(0, 12), jobName: res.run.jobName },
    output: { ok: res.ok, reachable: res.reachable, detail: res.detail },
    decision: 'allow',
  });
  return { submitted: true, ok: res.ok, detail: res.detail };
}

/**
 * Poll the app's in-flight OS build (Phase B) and reconcile it onto the pipeline +
 * runner HONESTLY. When the build SUCCEEDS and its pushed digest is captured, pin the
 * app's serving image to that digest (`app.runImageDigest`) and re-deploy the runner
 * digest-pinned — a new digest is a real template change, so the roll is honest (no
 * `:latest` hack). Returns a short note for the status card, or null when there is no
 * OS build to report. Never throws — a down cluster leaves the state untouched.
 */
export async function refreshBuildStage(
  app: App,
  /** Injected k8s client (tests); defaults to the live in-cluster client. */
  client?: import('@/lib/software/build-service').K8sClient,
): Promise<{ status: StageStatus; note: string | null } | null> {
  const m = await import('@/lib/software/build-service');
  if (!m.buildServiceEnabled(config)) {
    return { status: app.pipeline.harbor, note: m.BUILD_SERVICE_OFF_NOTE };
  }
  const state = app.osBuild;
  if (!state?.jobName || !state.sha) {
    return { status: app.pipeline.harbor, note: 'OS build service is ON — no in-cluster build has been submitted for this app yet.' };
  }
  const rt = buildRuntimeFromConfig();
  const st = await m.readBuildJob(app.slug, state.jobName, rt, client);
  const now = new Date().toISOString();
  let changed = false;
  const setStage = (next: StageStatus) => {
    if (app.pipeline.harbor !== next) { app.pipeline.harbor = next; changed = true; }
  };
  if (st.phase === 'unknown') {
    // Cluster unreachable / job reaped — do not overwrite a real prior state; report honestly.
    return { status: app.pipeline.harbor, note: `OS build service: ${st.reason}.` };
  }
  if (st.phase === 'succeeded' && st.imageDigest) {
    // PIN the runner to the pushed digest and roll it honestly.
    app.runImageDigest = st.imageDigest;
    app.osBuild = { ...state, phase: 'succeeded', digest: st.imageDigest, updatedAt: now };
    setStage('ok');
    changed = true;
    let rollNote = '';
    try {
      // Re-provision through review.ts's shared runner entry (single-sourced footprint +
      // runner shape) so the pod re-pins to the just-built digest. `app.runImageDigest`
      // was set above, so `runnerAppFor` picks it up.
      const review = await import('@/lib/software/review');
      const out = await review.redeployRunnerForApp(app);
      rollNote = out.live ? ' Runner re-pinned to the new digest.' : ' Runner not reachable to re-pin (will pin on next deploy).';
    } catch {
      rollNote = '';
    }
    if (changed) writeThrough(app);
    return { status: 'ok', note: `OS build service built + pushed ${state.sha.slice(0, 10)} (digest pinned).${rollNote}` };
  }
  if (st.phase === 'failed') {
    app.osBuild = { ...state, phase: 'failed', updatedAt: now };
    setStage('failing');
    if (changed) writeThrough(app);
    return { status: 'failing', note: `OS build service build for ${state.sha.slice(0, 10)} FAILED (${st.reason}). Forgejo Actions remains available as the fallback build path.` };
  }
  // pending / running
  app.osBuild = { ...state, phase: st.phase, updatedAt: now };
  setStage('pending');
  if (changed) writeThrough(app);
  return { status: 'pending', note: `OS build service is building ${state.sha.slice(0, 10)} (${st.phase}${st.reason && st.reason !== st.phase ? `: ${st.reason}` : ''}).` };
}

// ----------------------------------------------------------------- MCP wiring --

/**
 * Compile the app's OPA capability profile from its TEMPLATE tools UNIONED with the
 * data-plane tools its `grants` imply (grant-tools.ts) — the single place grants become
 * runtime tool access. Template tools are the baseline surface; grants ADD data-plane
 * access (granted data ⇒ query/dataset tools, knowledge ⇒ knowledge tools, etc.). Every
 * granted-context tool is compiled read-only under the reads-on/writes-off preset, so a
 * grant widens WHICH tools are exposed, never the identity a call runs as (still run-as-user,
 * still DLS/RLS-scoped at call time). Fail-closed: no grants ⇒ [] extras ⇒ template default only.
 */
export function compileAppProfile(app: App): void {
  const grantTools = dataPlaneToolsFromGrants(app.grants);
  generateAndCompile(app.mcpPrincipal, { tools: [...app.mcpTools, ...grantTools] });
}

export function rehydrateConnection(app: App): void {
  // NEVER resurrect an archived app: archiveApp() intentionally drops its grant +
  // connection, so re-arming here (on a restart's hydrate, or any caller) would
  // silently make a disabled app callable again + reappear in Connections. This is
  // the single authoritative guard — unarchiveApp flips status to 'active' first.
  if (app.status === 'archived') return;
  // Re-arm the auto-MCP capability profile in OPA (reads-on/writes-off) so the
  // governed gate works after a restart, not just the static app-registry grant.
  // Grants are folded in so a restart re-derives the granted data-plane tools too.
  compileAppProfile(app);
  if (getConnectionByApp(app.id)) return;
  registerConnection({
    id: app.connectionId ?? id('conn'),
    appId: app.id,
    name: `${app.name} MCP`,
    principal: app.mcpPrincipal,
    tools: app.mcpTools,
    owner: app.owner,
    domain: app.domain,
    visibility: app.visibility,
    createdAt: app.createdAt,
  });
}

// ------------------------------------------------------------------- Scoping ---

function visibleToUser(a: App, user: CurrentUser): boolean {
  if (a.visibility === 'Personal') return a.owner === user.id;
  if (a.visibility === 'Shared') return user.domains.includes(a.domain);
  // Certified (Marketplace): visible across domains.
  return true;
}

export async function listAppsForUser(user: CurrentUser): Promise<App[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((a) => visibleToUser(a, user))
    // STRICT DOMAIN ISOLATION: narrow EVERY tier — My (Personal), Domain (Shared) AND
    // Company (Certified) — to the domain being acted in (auth.ts narrows user.domains to
    // [active]; "All Domains" keeps every membership; a domainless app always shows). A
    // certified app homed in domain A must NOT show while acting in domain B — cross-domain
    // discovery is the dedicated Marketplace catalog's job, not this list's. Shared already
    // filters on user.domains via visibleToUser; this adds the same gate for Personal +
    // Certified. The single-app open (getAppForUser) intentionally stays un-narrowed.
    .filter((a) => !a.domain || user.domains.includes(a.domain))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

export async function getAppForUser(appId: string, user: CurrentUser): Promise<App> {
  // Cache miss falls back to the durable mirror — a cross-instance create must
  // still be visible here (the same stale-cache split that 404'd `commit`).
  const a = await getAppByIdWithMirror(appId);
  if (!a || !visibleToUser(a, user)) throw withStatus(new Error('App not found'), 404);
  return a;
}

/**
 * Fetch an app AND assert the caller may EDIT it (owner or in-domain domain_admin+ —
 * the same edit-scope `patchAppDesign` uses). Used by the Design-stage seed route so
 * a mere viewer cannot write files into the app repo. Throws 404 (unseeable) / 403.
 */
export async function getEditableAppForUser(appId: string, user: CurrentUser): Promise<App> {
  const a = await getAppForUser(appId, user);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  return a;
}

// -------------------------------------------------------------------- Create ---

export async function createApp(
  user: CurrentUser,
  input: { name: string; description?: string; template?: AppTemplateKey; domain?: string; surface?: SurfaceDeclaration; purpose?: string },
): Promise<App> {
  const map = await getCache();
  // Default a fresh app to the SOVEREIGN STANDARD APP (`sovereign-app`): the rich
  // base app with OS-delegated identity, domain scoping, an admin section and the
  // MCP link already in place. The other templates remain selectable via
  // `input.template`; existing apps keep the template they were created with.
  const tpl = TEMPLATES[input.template ?? 'sovereign-app'] ?? TEMPLATES['sovereign-app'];
  // An explicit surface declaration (intent) wins over the scaffold's heuristic.
  const declaredSurface: SurfaceDeclaration | undefined =
    input.surface === 'ui' || input.surface === 'api' || input.surface === 'both' ? input.surface : undefined;
  const name = (input.name ?? '').trim() || 'Untitled app';
  const slug = slugify(name);
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0];
  const description = (input.description ?? '').trim().slice(0, 280);
  const t = now();
  const subdomain = `${slug}.${domain}.${config.appsBaseDomain}`;

  // 1. Scaffold the per-app Forgejo repo (real when reachable).
  const repo = await scaffoldRepo(slug, description, tpl, name);

  // 2. Pipeline status — honest reflection of reachability + default-off Harbor.
  const live = repo.mode === 'live';
  const pipeline: Record<PipelineStage, StageStatus> = {
    forgejo: live ? 'ok' : 'offline',
    // HONEST: 'ok' is EARNED, never assumed — `refreshActionsStage` flips it to
    // 'ok' only once the latest push on main actually produced an Actions run.
    actions: 'pending',
    // Harbor is a default-off heavy workload; CI uses Forgejo's registry locally.
    harbor: config.harborEnabled ? (live ? 'ok' : 'pending') : 'disabled',
    argocd: live ? 'ok' : 'pending',
    live: live ? 'ok' : 'pending',
  };

  // 3. Auto-register the data as a Personal artifact owned by the creator.
  let dataArtifactId: string | null = null;
  try {
    const dataArt = await createArtifact(user, {
      type: 'dataset',
      name: `${name} data`,
      description: `Operational data product auto-created by the ${name} app (Personal to ${user.id}).`,
      tags: ['app-data', 'personal', slug],
      spec: { app: slug, table: 'records', backend: 'supabase' },
      domain,
    });
    dataArtifactId = dataArt.id;
  } catch {
    /* artifact store best-effort */
  }

  // 4. Auto-generate the MCP + register it as a Connection + agent tool, AND
  //    compile its reads-on/writes-off capability profile into OPA (the same
  //    governed gate every Connection uses) so an app MCP tool is governed
  //    identically — reads allow, writes held for approval, nothing else exposed.
  const mcpPrincipal = `app-${slug}`;
  const mcpTools = tpl.tools(slug);
  generateAndCompile(mcpPrincipal, { tools: mcpTools });
  const connectionId = id('conn');
  const conn: AppConnection = {
    id: connectionId,
    appId: '', // set below once the app id is known
    name: `${name} MCP`,
    principal: mcpPrincipal,
    tools: mcpTools,
    owner: user.id,
    domain,
    visibility: 'Personal',
    createdAt: t,
  };

  const app: App = {
    id: id('app'),
    slug,
    name,
    description,
    purpose: (input.purpose ?? '').slice(0, 2000),
    epics: [],
    grants: emptyContextGrants(),
    template: tpl.key,
    owner: user.id,
    domain,
    visibility: 'Personal',
    // Least-privilege: the creator is the sole (implicit) admin; no other account
    // has app-admin standing until explicitly added via addAppMember.
    members: [],
    folder: '/',
    mode: repo.mode,
    // Phase D: a fresh app is served the historic way (per-app image) until the
    // owner explicitly opts into OS runtime serving on the Publish surface.
    serveMode: 'image',
    repo: { fullName: repo.fullName, htmlUrl: repo.htmlUrl, seeded: repo.seeded },
    subdomain,
    pipeline,
    designDecisions: tpl.designDecisions(name),
    dataDescriptions: tpl.dataDescriptions(name),
    docs: tpl.docs(name, subdomain),
    chat: [],
    dataArtifactId,
    files: [
      { name: `${slug}-export.csv`, description: 'Exported report generated by the app.', visibility: 'Personal' },
    ],
    connectionId,
    mcpPrincipal,
    mcpTools,
    mcpProfileCompiled: true,
    status: 'active',
    deploy: { state: 'building', previewUrl: null, approved: null, reviewCardId: null, releases: 0 },
    manifest: parseAppManifest(tpl.files(name, slug), {
      name,
      owner: user.id,
      description,
    }),
    // The scaffold's surface: a declaration (intent) wins, else detected from the
    // seed files. Re-resolved on every commit + at deploy — the declaration stays
    // authoritative, so a declared UI app never regresses to "API" as code changes.
    surface: resolveSurface(tpl.files(name, slug), declaredSurface),
    declaredSurface,
    consumes: [],
    usedAsData: dataArtifactId !== null,
    createdAt: t,
    updatedAt: t,
  };

  conn.appId = app.id;
  registerConnection(conn);

  map.set(app.id, app);
  writeThrough(app);

  // 5. Audit the creation through the same Langfuse spine the agents use.
  void trace({
    principal: mcpPrincipal,
    tool: 'generate',
    input: { action: 'create_app', name, template: tpl.key },
    output: { appId: app.id, repo: repo.fullName, connection: connectionId, mode: repo.mode },
    decision: 'allow',
  });

  return app;
}

/**
 * Governed offboard support: transfer this owner's PERSONAL-lane records to a new
 * owner (used by lib/platform-admin/offboard.ts when a user is offboarded with
 * reassignment). Only personal, owner-only artifacts move; shared/domain/certified
 * are untouched. Returns the count moved.
 */
export async function reassignOwner(fromId: string, toId: string): Promise<number> {
  const map = await getCache();
  let moved = 0;
  for (const a of map.values()) {
    if (a.owner !== fromId) continue;
    if (a.visibility !== 'Personal') continue; // personal lane only
    a.owner = toId;
    a.updatedAt = now();
    writeThrough(a);
    moved++;
  }
  return moved;
}

// --------------------------------------------------------------- Build chat ---

/** Persist the running build-chat conversation under the app (most recent 40). */
export async function saveChat(
  appId: string,
  user: CurrentUser,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a || a.owner !== user.id) throw withStatus(new Error('App not found'), 404);
  const t = now();
  a.chat = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content, at: t }));
  a.updatedAt = t;
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/** Update the app's captured design decisions / data descriptions / docs. */
export async function updateAppDocs(
  appId: string,
  user: CurrentUser,
  patch: { designDecisions?: string; dataDescriptions?: string; docs?: string },
): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  // Snapshot prior state before any mutation; skip version churn on no-op edits.
  const changed =
    (patch.designDecisions !== undefined && patch.designDecisions !== a.designDecisions) ||
    (patch.dataDescriptions !== undefined && patch.dataDescriptions !== a.dataDescriptions) ||
    (patch.docs !== undefined && patch.docs !== a.docs);
  if (changed) versions.record(a.id, user.id, snapshotState(a), 'edit docs');
  if (patch.designDecisions !== undefined) a.designDecisions = patch.designDecisions;
  if (patch.dataDescriptions !== undefined) a.dataDescriptions = patch.dataDescriptions;
  if (patch.docs !== undefined) a.docs = patch.docs;
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

// -------------------------------------------------------------- Membership ---

/**
 * One row of the app's membership as shown to a client — the OWNER first (implicit
 * admin), then each explicitly added user, resolved to their OS name/domains.
 * A member whose OS account no longer exists still lists (id only) so an admin can
 * see + remove a stale grant. `isOwner` marks the implicit-admin creator.
 */
export type AppMemberView = {
  id: string;
  name: string;
  role: AppMemberRole;
  domains: string[];
  isOwner: boolean;
};

/** Resolve one id to a display row (name/domains), or a stale-account fallback. */
function memberViewOf(id: string, role: AppMemberRole, isOwner: boolean, u: PublicUser | null): AppMemberView {
  return { id, name: u?.name || id, role, domains: u?.domains ?? [], isOwner };
}

/**
 * The app's ACTUAL membership — the owner (implicit admin) plus every explicitly
 * added user, resolved to OS display rows. This is what the deployed app's Admin
 * area lists ("who administers / can be a member of THIS app"), NOT the whole
 * domain directory. Readable by anyone who can see the app (viewers included); the
 * add/remove routes are the edit-scoped mutations. No email or account flags leave.
 */
export async function listAppMembers(appId: string, user: CurrentUser): Promise<{ app: App; members: AppMemberView[]; canManage: boolean }> {
  const app = await getAppForUser(appId, user);
  const ownerUser = await getPublicUser(app.owner);
  const rows: AppMemberView[] = [memberViewOf(app.owner, 'admin', true, ownerUser)];
  // Defensive re-normalise: never trust the persisted field is a well-formed array
  // (a pre-membership record read straight from a store may carry undefined).
  for (const m of normalizeAppMembers(app.members, app.owner)) {
    rows.push(memberViewOf(m.id, m.role, false, await getPublicUser(m.id)));
  }
  return { app, members: rows, canManage: isOwnerOrAdminApp(app, user) };
}

/**
 * Add (or re-role) an explicit app member. Edit-scoped: only the app owner, an
 * in-domain domain_admin, or a platform admin may mutate membership (same
 * canManageArtifact gate every ownable artifact uses). The user must be a real OS
 * account. Adding the OWNER is a no-op (they are always an implicit admin). Fails
 * closed: 403 for a non-admin, 404 for an unknown OS user. Byte-stable persist.
 */
export async function addAppMember(
  appId: string,
  user: CurrentUser,
  memberId: string,
  role: AppMemberRole,
): Promise<App> {
  const map = await getCache();
  const a = map.get(appId) ?? (await getAppByIdWithMirror(appId));
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to manage this app'), 403);
  const id = (memberId ?? '').trim();
  if (!id) throw withStatus(new Error('A user id is required'), 400);
  const memberRole: AppMemberRole = role === 'admin' ? 'admin' : 'member';
  // The owner is always an implicit admin — never listed.
  if (id === a.owner) return a;
  const target = await getPublicUser(id);
  if (!target) throw withStatus(new Error('No such OS user'), 404);
  const next = normalizeAppMembers(a.members, a.owner).filter((m) => m.id !== id);
  next.push({ id, role: memberRole });
  a.members = normalizeAppMembers(next, a.owner);
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/**
 * Remove an explicit app member. Edit-scoped (owner / in-domain domain_admin /
 * admin). Removing the OWNER is refused (they are the sole implicit admin — the app
 * can never be admin-less). Removing an id that is not a member is a quiet no-op.
 */
export async function removeAppMember(appId: string, user: CurrentUser, memberId: string): Promise<App> {
  const map = await getCache();
  const a = map.get(appId) ?? (await getAppByIdWithMirror(appId));
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to manage this app'), 403);
  const id = (memberId ?? '').trim();
  if (id === a.owner) throw withStatus(new Error('The owner cannot be removed'), 400);
  a.members = normalizeAppMembers(a.members, a.owner).filter((m) => m.id !== id);
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/**
 * Resolve an app by its frozen SLUG within the caller's visible set — the deployed
 * app knows only its baked-in `APP_SLUG`, not the OS app id. Runs AS the caller so
 * a user who cannot see the app gets nothing. Returns null when no visible app owns
 * the slug (a deployed app whose OS record was deleted degrades honestly).
 */
export async function getAppBySlugForUser(slug: string, user: CurrentUser): Promise<App | null> {
  const s = (slug ?? '').trim();
  if (!s) return null;
  const map = await getCache();
  for (const a of map.values()) {
    if (a.slug === s && visibleToUser(a, user)) return a;
  }
  return null;
}

/**
 * Sanitise every story's Design SPEC before persist — normalises the three lists and
 * DROPS an empty/garbage spec so the field stays absent (byte-stable) for stories the
 * user never specified. Everything else on the epics/stories is passed through
 * untouched; the caller still owns the epic/story CRUD.
 */
function normalizeEpicSpecs(epics: AppEpic[]): AppEpic[] {
  return epics.map((e) => ({
    ...e,
    stories: (e.stories ?? []).map((s) => {
      const spec = normalizeSpec(s.spec);
      if (spec) return { ...s, spec };
      // No usable spec → ensure the field is absent, not an empty object.
      const { spec: _drop, ...rest } = s;
      return rest;
    }),
  }));
}

/**
 * Persist the Define + Design surfaces — the app's PURPOSE, its DESIGN epics/stories,
 * and its governed CONTEXT GRANTS. Same fail-closed edit-scope as `updateAppDocs`
 * (owner, owning-domain admin, or admin). Any field left undefined is untouched, so
 * the caller patches just what changed. Grants are normalised so a malformed/legacy
 * payload can never widen the persisted shape.
 */
export async function patchAppDesign(
  appId: string,
  user: CurrentUser,
  patch: { purpose?: string; epics?: AppEpic[]; grants?: ContextGrants },
): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  if (patch.purpose !== undefined) a.purpose = patch.purpose.slice(0, 2000);
  if (patch.epics !== undefined) {
    // EARNED built-ness: a caller (esp. a build agent via design_software) must not flip a
    // story to `done` on an app with no committed code — that was the phantom-built lie. If
    // there is no real commit, force every incoming `done`/`building` back to `todo` before
    // persist. A genuinely-committed app trusts the incoming status (the post-commit flip).
    const hasRealCommit =
      a.pipeline.forgejo === 'ok' ||
      a.repo.seeded.length > 0 ||
      (getSnapshot(a.id) ?? []).some((f) =>
        /^src\/epics\/[^/]+\/(?!general\/)[^/]+\/[A-Z][A-Za-z0-9]*\.tsx$/.test(f.path),
      );
    const epics = normalizeEpicSpecs(patch.epics);
    a.epics = hasRealCommit
      ? epics
      : epics.map((e) => ({
          ...e,
          stories: (e.stories ?? []).map((s) =>
            s.status === 'done' || s.status === 'building' ? { ...s, status: 'todo' as const } : s,
          ),
        }));
  }
  if (patch.grants !== undefined) {
    a.grants = normalizeContextGrants(patch.grants);
    // GRANTS → RUNTIME TRUTH: a grant change re-derives the app's data-plane tools and
    // re-compiles its OPA capability profile immediately, so the deployed app can actually
    // use what it was just granted (and loses access the moment a grant is revoked).
    compileAppProfile(a);
  }
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

// ------------------------------------------------------------------ Promote ---

/**
 * Promote the app + everything under it one step up the ladder
 * (Personal → Shared → Certified/Marketplace). Role-gated exactly like artifacts:
 * Personal→Shared needs builder+, Shared→Certified needs admin. The actor must
 * belong to the app's domain. Cascades to the app's data artifact, its files and
 * its MCP connection, and audits the action.
 */
export async function promoteApp(appId: string, user: CurrentUser): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!user.domains.includes(a.domain)) {
    throw withStatus(new Error('You can only promote apps in a domain you belong to'), 403);
  }
  let next: Visibility;
  if (a.visibility === 'Personal') {
    if (!canPromote(user.role, 'Personal')) {
      throw withStatus(new Error('Promoting to Shared requires a Domain admin or Administrator'), 403);
    }
    next = 'Shared';
  } else if (a.visibility === 'Shared') {
    if (!canPromote(user.role, 'Shared')) {
      throw withStatus(new Error('Promoting to the Marketplace requires an Administrator'), 403);
    }
    next = 'Certified';
  } else {
    throw withStatus(new Error('Already in the Marketplace'), 400);
  }

  a.visibility = next;
  a.files = a.files.map((f) => ({ ...f, visibility: next }));
  setConnectionVisibility(a.id, next);
  // Cascade the real Personal data artifact through the SAME promotion ladder.
  if (a.dataArtifactId) {
    try {
      const art = await getArtifact(a.dataArtifactId);
      if (art && art.visibility !== 'Certified') await promoteArtifact(a.dataArtifactId, user);
    } catch {
      /* artifact may already be promoted; ignore */
    }
  }
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);

  void trace({
    principal: a.mcpPrincipal,
    tool: 'generate',
    input: { action: 'promote_app', by: user.id, role: user.role },
    output: { appId: a.id, visibility: next },
    decision: 'allow',
  });
  return a;
}

// ----------------------------------------------------------- Rename / folder ---

/**
 * Rename an app — change its DISPLAY `name` ONLY. Edit-scoped exactly like every
 * other mutation (owner always; an in-domain domain_admin / platform admin on a
 * Shared/Certified app — the reused {@link isOwnerOrAdminApp} gate, which itself
 * uses roleAtLeast/canManageArtifact, never an exact role set).
 *
 * CRITICAL — the physical identity NEVER moves. Mirrors renameDataset's freeze
 * discipline: `slug` is the FROZEN physical identity (repo name, container image
 * `<registry>/<slug>:latest`, CI repo). Unlike a dataset — whose physical slug is
 * derived-from-name and must be PINNED before the first rename — an app's `slug` is
 * set ONCE at create (`slugify(name)`) and stored as its own field; nothing ever
 * re-derives it from `name`. So it is already decoupled: renaming leaves `slug`
 * (and thus image/repo/container FQN + subdomain) byte-identical by construction —
 * we simply never touch it here. Trim / reject-empty(400) / no-op (no version churn).
 * A doc-version snapshot is recorded so the rename is auditable + reversible.
 */
export async function renameApp(appId: string, user: CurrentUser, newName: string): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to rename this app'), 403);
  const name = (newName ?? '').trim();
  if (!name) throw withStatus(new Error('An app needs a name'), 400);
  if (name === a.name) return a; // no-op → no version churn, slug untouched
  // Snapshot before mutating so the rename can be undone (same log updateAppDocs uses).
  versions.record(a.id, user.id, snapshotState(a), 'rename');
  a.name = name; // DISPLAY only — a.slug (frozen physical identity) is NEVER touched
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/** The folder scope an app lives in: a Personal app's folders are the owner's
 *  PERSONAL tree; a Shared/Certified app's folders are the owning DOMAIN's tree.
 *  Mirrors how listAppsForUser groups by tier (and Data's folderScopeOf). */
export function folderScopeOfApp(a: App): FolderScope {
  return a.visibility === 'Personal' ? 'personal' : 'domain';
}

/**
 * SYNC scope-lane listing for the folder ADAPTER's `itemsUnderFolder` (which the
 * shared cascade calls synchronously). Reads the ALREADY-hydrated in-process cache
 * directly — every server boundary that runs a folder cascade first hydrates the
 * apps store (the same /api/folders request path lists apps), so the Map is warm;
 * if it is somehow cold this returns [] rather than blocking. Personal → the caller's
 * own Personal-visibility apps; domain → the Shared + Certified apps the caller may
 * see in a domain they belong to. Includes ARCHIVED (the restore/delete cascade must
 * find members the archive step already hid). Mirrors Data's itemsInScope lane split.
 */
export function listAppsInScopeSync(
  user: CurrentUser,
  scope: FolderScope,
): { id: string; folder: string }[] {
  const cache = appCacheState().cache;
  if (!cache) return [];
  const out: { id: string; folder: string }[] = [];
  for (const a of cache.values()) {
    if (!visibleToUser(a, user)) continue;
    if (a.domain && !user.domains.includes(a.domain)) continue; // domain isolation (as listAppsForUser)
    const lane: FolderScope = a.visibility === 'Personal' ? 'personal' : 'domain';
    if (lane !== scope) continue;
    out.push({ id: a.id, folder: normaliseFolderPath(a.folder) });
  }
  return out;
}

/** Best-effort: mirror an app's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row).
 *  createFolder is idempotent + edit-scoped; any gate failure is swallowed so a
 *  successful move is never rolled back (mirrors Data's upsertFolderRow). */
function upsertAppFolderRow(a: App, user: CurrentUser): void {
  const path = normaliseFolderPath(a.folder);
  if (path === '/') return;
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  try {
    createFolder(principal, { tab: 'software', scope: folderScopeOfApp(a), path, domain: a.domain });
  } catch {
    /* folder-registry mirror is best-effort; the app move already succeeded */
  }
}

/**
 * Move an app into a folder (edit-scoped, write-through like every other mutation).
 * The folder is a normalised path on the app record; the folder ROOT (personal vs
 * domain tree) is decided by tier. On move we also upsert an EXPLICIT folder row in
 * the governed registry so the destination folder persists even when it holds no
 * apps. A viewer who cannot edit is rejected 403 and nothing is written. Mirrors
 * lib/data/store.moveDataset exactly (parity rollout).
 */
export async function moveApp(appId: string, user: CurrentUser, folder: string): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to move this app'), 403);
  a.folder = normaliseFolderPath(folder);
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  // The move already passed the app's edit-scope gate above, so this same-owner
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  upsertAppFolderRow(a, user);
  return a;
}

// --------------------------------------------------------- Version history -----

/** Version history for an app, newest first (view-scoped). */
export async function listAppVersions(appId: string, user: CurrentUser): Promise<ArtifactVersion[]> {
  await getAppForUser(appId, user); // view gate — throws 404 if not visible
  return versions.list(appId);
}

/**
 * Restore a prior version of an app's doc content. Restore is auditable +
 * reversible: the current state is snapshotted as a new version first, then
 * the chosen version is applied. Edit-scoped (owner or Admin only).
 */
export async function restoreAppVersion(appId: string, user: CurrentUser, version: number): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a || !visibleToUser(a, user)) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  const snap = versions.get(appId, version);
  if (!snap) throw withStatus(new Error(`Version ${version} not found`), 404);
  const restored = snap.state as { designDecisions?: string; dataDescriptions?: string; docs?: string };
  if (typeof restored.designDecisions !== 'string') {
    throw withStatus(new Error(`Version ${version} has no restorable content`), 422);
  }
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(appId, user.id, snapshotState(a), `restore of v${version}`);
  if (restored.designDecisions !== undefined) a.designDecisions = restored.designDecisions;
  if (restored.dataDescriptions !== undefined) a.dataDescriptions = restored.dataDescriptions;
  if (restored.docs !== undefined) a.docs = restored.docs;
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

// ------------------------------------------------------ Git-backed versions ---
//
// Software apps are GIT-backed: every save/build is a real commit to the app's
// Forgejo repo. So the version history + "restore a prior version" reflect the
// repo's COMMIT log (via the shared `git-versioning` helper) rather than only the
// snapshot log above. When Forgejo is unreachable / the repo has no history yet we
// fall back to the snapshot log honestly (never a faked empty git list). The
// manifest file that must be present for a restore to be meaningful is `app.yaml`.

const APP_MANIFEST = 'app.yaml';

/** A ForgejoClient scoped to one app's repo, backed by the app store's own
 *  `forgejoApi`. Only the read/commit surface the version helper needs is real;
 *  the create/delete methods are unused here and throw if called. `getCommitFiles`
 *  reads the WHOLE repo tree at the ref so a restore re-commits the exact build. */
function appForgejoClient(app: App): ForgejoClient {
  const { owner, repo } = repoCoords(app);
  const path = (p: string) => encodeRepoPath(sanitizeRepoPath(p));
  return {
    async ensureRepo() {/* app repos are provisioned by scaffoldRepo, not here */},
    async readFile(_repo, p) {
      const res = await forgejoApi('GET', `/repos/${owner}/${repo}/contents/${path(p)}?ref=main`);
      if (!res.ok) return null;
      const d = res.data as { content?: string; encoding?: string; sha?: string } | null;
      if (!d || typeof d.content !== 'string') return null;
      const content = d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content;
      return { content, sha: String(d.sha ?? '') };
    },
    async writeFile(_repo, p, content, sha, message) {
      const res = await forgejoApi('PUT', `/repos/${owner}/${repo}/contents/${path(p)}`, {
        content: Buffer.from(content, 'utf8').toString('base64'),
        message: message ?? `Restore ${p}`,
        sha: sha || undefined,
        branch: 'main',
      });
      if (!res.ok) throw withStatus(new Error(`Forgejo write ${p} failed (${res.status || 'unreachable'}).`), 502);
      const d = res.data as { content?: { sha?: string } };
      return { sha: String(d?.content?.sha ?? '') };
    },
    async deleteRepo() { return { deleted: false }; },
    async listCommits(_repo, opts): Promise<ForgejoCommit[] | null> {
      const limit = opts?.limit ?? 30;
      const res = await forgejoApi('GET', `/repos/${owner}/${repo}/commits?sha=main&limit=${limit}`);
      if (!res.ok || !Array.isArray(res.data)) return null;
      const rows = res.data as { sha?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }[];
      return rows
        .map((c) => ({
          sha: String(c.sha ?? ''),
          message: String(c.commit?.message ?? '').trim(),
          author: String(c.commit?.author?.name ?? 'unknown'),
          date: String(c.commit?.author?.date ?? ''),
        }))
        .filter((c) => c.sha);
    },
    async getCommitFiles(_repo, sha): Promise<ForgejoCommitFiles | null> {
      // The whole repo tree AT `sha` (so a restore re-commits the exact build).
      const tree = await forgejoApi('GET', `/repos/${owner}/${repo}/git/trees/${sha}?recursive=true&per_page=1000`);
      if (!tree.ok) return null;
      const blobs = ((tree.data as { tree?: { path: string; type: string }[] })?.tree ?? [])
        .filter((t) => t.type === 'blob' && typeof t.path === 'string')
        .map((t) => t.path);
      const files: ForgejoCommitFiles = {};
      for (const p of blobs) {
        const res = await forgejoApi('GET', `/repos/${owner}/${repo}/contents/${path(p)}?ref=${encodeURIComponent(sha)}`);
        if (!res.ok) continue;
        const d = res.data as { content?: string; encoding?: string } | null;
        if (!d || typeof d.content !== 'string') continue;
        files[p] = d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content;
      }
      return Object.keys(files).length > 0 ? files : null;
    },
  };
}

/**
 * Git commit history for an app's repo, newest first, in the VersionHistory shape.
 * Returns `null` when the repo has no git history yet OR Forgejo is unreachable, so
 * the route falls back to the snapshot log honestly. View-scoped.
 */
export async function listAppGitVersions(appId: string, user: CurrentUser): Promise<GitVersion[] | null> {
  const app = await getAppForUser(appId, user); // view gate — throws 404 if not visible
  const { repo } = repoCoords(app);
  return listGitVersions(appForgejoClient(app), repo);
}

/**
 * Restore a prior build of an app by RE-COMMITTING that commit's files onto HEAD
 * (a new, auditable "restore of <sha>" commit — never a destructive reset), then
 * re-arming its MCP profile from the restored manifest. Edit-scoped (owner/admin);
 * a state change on the same governed spine (trace). Returns the sha restored, or
 * `null` when there is no git history to restore against (→ snapshot fallback).
 */
export async function restoreAppGitVersion(
  appId: string,
  user: CurrentUser,
  version: number,
): Promise<{ app: App; sha: string } | null> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a || !visibleToUser(a, user)) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  const client = appForgejoClient(a);
  const { repo } = repoCoords(a);
  const sha = await shaForVersion(client, repo, version);
  if (!sha) return null; // no git history / out of range → caller uses snapshot restore
  const { sha: newSha } = await restoreGitVersion(client, repo, sha, user.id, { manifestPath: APP_MANIFEST });
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  void trace({
    principal: a.mcpPrincipal,
    tool: 'generate',
    input: { action: 'restore_version', restoredFrom: sha.slice(0, 8), by: user.id, role: user.role },
    output: { repo: a.repo.fullName, commit: newSha },
    decision: 'allow',
  });
  return { app: a, sha: newSha };
}

// ------------------------------------------------------- Server accessors -----
//
// The governed software modules (review / lifecycle / server / platform-mcp)
// orchestrate the deploy gate, lifecycle and front doors. They enforce their OWN
// role + lineage gates, then read/persist the app through these accessors. Kept
// internal (no user-visibility filter) precisely because the CALLER is the
// security boundary for these governed flows — never expose them to a route
// without a role/owner check first.

/** Raw app fetch by id (no visibility filter) — for governed server orchestration. */
export async function getAppByIdInternal(appId: string): Promise<App | null> {
  return getAppByIdWithMirror(appId);
}

/**
 * Internal by-slug lookup with NO visibility filter — for the least-privilege
 * origin cap (app-origin.ts), which reads an app's grants to DENY artifacts, never
 * to widen access (the governed route already enforced the user's own canView). An
 * unknown slug returns null so the caller can fail closed for app origins.
 */
export async function getAppBySlugInternal(slug: string): Promise<App | null> {
  const s = (slug ?? '').trim();
  if (!s) return null;
  const map = await getCache();
  for (const a of map.values()) {
    if (a.slug === s) return a;
  }
  return null;
}

/** Every app in the store (no visibility filter) — for the lineage check. */
export async function listAllAppsInternal(): Promise<App[]> {
  const map = await getCache();
  return [...map.values()];
}

/** Remove an app from the store entirely (lineage-checked delete only). */
export async function removeAppInternal(appId: string): Promise<void> {
  const map = await getCache();
  map.delete(appId);
  mirror.deleteThrough(appId);
  deleteSnapshot(appId); // drop the durable source-file mirror doc too
  versions.purge(appId);
}

/** Persist a mutated app back to the cache + the durable mirror. */
export async function persistApp(app: App): Promise<App> {
  const map = await getCache();
  app.updatedAt = now();
  map.set(app.id, app);
  writeThrough(app);
  return app;
}

/** The template's seeded files (for the security scan + diff over a fresh app). */
export function templateFiles(template: AppTemplateKey, name: string, slug: string): { path: string; content: string }[] {
  const tpl = TEMPLATES[template] ?? TEMPLATES['nextjs-supabase'];
  return tpl.files(name, slug);
}

/** Mint a prefixed id (shared shape with the rest of the registry). */
export function newId(prefix: string): string {
  return id(prefix);
}

export function __resetAppsCache(): void {
  const s = appCacheState();
  s.cache = null;
  mirror.__reset();
  versions.__reset();
}

export { withStatus };
export type { Artifact, ArtifactVersion };
