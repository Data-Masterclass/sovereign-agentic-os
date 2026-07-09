/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import type { CurrentUser } from '@/lib/core/auth';
import { canPromote, roleAtLeast } from '@/lib/core/session';
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
} from '@/lib/software/model';
import { generateAndCompile } from '@/lib/software/auto-mcp';
import { parseAppManifest, renderAppYaml, defaultOpenApi, detectSurface } from '@/lib/software/metadata';
import { osMirror } from '@/lib/infra/os-mirror';
import { type ArtifactVersion, versionLog } from '@/lib/core/versioning';
import { listGitVersions, restoreGitVersion, shaForVersion, type GitVersion } from '@/lib/core/git-versioning';
import type { ForgejoClient, ForgejoCommit, ForgejoCommitFiles } from '@/lib/agents/build/live';

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
export type StageStatus = 'ok' | 'pending' | 'offline' | 'disabled';

export type AppFile = {
  name: string;
  description: string;
  visibility: Visibility;
};

export type AppChatMessage = { role: 'user' | 'assistant'; content: string; at: string };

export type App = {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: AppTemplateKey;
  owner: string;
  domain: string;
  visibility: Visibility;
  /** 'live' when Forgejo was reachable at create time; 'offline' otherwise. */
  mode: 'live' | 'offline';
  repo: { fullName: string; htmlUrl: string; seeded: string[] };
  subdomain: string;
  /**
   * Explicit prebuilt container image the in-cluster runner should serve (Phase 2
   * runner). Optional: when unset the runner uses the CI-published registry
   * convention `<registry>/<slug>:latest` (or the SOFTWARE_RUNNER_IMAGE default).
   * We NEVER build images in-cluster — this is a reference to an already-built one.
   */
  runImage?: string;
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
  /** Detected UI/API surface (inferred from what was built; drives the monitor). */
  surface: AppSurface;
  /** Governed resources the app actually consumes at run time (no raw creds). */
  consumes: ConsumedResource[];
  /** Whether "Use as Data" has snapshotted app data into a Bronze dataset. */
  usedAsData: boolean;
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------------------- Templates --

export type AppTemplateKey = 'nextjs-supabase' | 'service' | 'script' | 'dashboard';

/** Runtime kind per template (drives the per-template/per-runtime adapter). */
export const TEMPLATE_RUNTIME: Record<AppTemplateKey, 'web' | 'service' | 'script' | 'dashboard'> = {
  'nextjs-supabase': 'web',
  service: 'service',
  script: 'script',
  dashboard: 'dashboard',
};

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
    '          docker push "${IMAGE}:latest"\n'
  );
}

function nextjsSupabaseTemplate(): Template {
  return {
    key: 'nextjs-supabase',
    label: 'Next.js + Supabase app',
    tools: () => [
      { name: 'list_renewals', description: 'List contract renewals (read).', write: false },
      { name: 'get_renewal', description: 'Get one renewal by id (read).', write: false },
      { name: 'add_renewal', description: 'Add a contract renewal (write).', write: true },
      { name: 'export_renewals', description: 'Export renewals to a file (write).', write: true },
    ],
    designDecisions: (name) =>
      [
        `# ${name} — design decisions`,
        '',
        '- **Stack:** Next.js (App Router) frontend + Supabase (Postgres, Auth, Storage) backend.',
        '- **Data model:** a single `renewals` table (id, account, product, amount, renews_on, status).',
        '- **Access:** Supabase Row-Level Security scopes every row to the signed-in owner.',
        '- **Operational vs analytical:** live app rows stay in Supabase; analytical copies follow',
        '  the Data golden path as a Personal data product.',
        '- **MCP:** capabilities are auto-exposed as governed tools (read: list/get; write: add/export).',
      ].join('\n'),
    dataDescriptions: (name) =>
      [
        `# ${name} — data descriptions`,
        '',
        '## Table: `renewals`',
        '| field | type | meaning |',
        '|---|---|---|',
        '| `id` | uuid | primary key |',
        '| `account` | text | customer / counterparty name |',
        '| `product` | text | the contracted product or plan |',
        '| `amount` | numeric | annual contract value |',
        '| `renews_on` | date | next renewal date |',
        '| `status` | text | `upcoming` \\| `renewed` \\| `churned` |',
      ].join('\n'),
    docs: (name, sub) =>
      [
        `# ${name}`,
        '',
        `Live at **https://${sub}** (once CI → Harbor → Argo CD have synced).`,
        '',
        '## Use',
        '1. Sign in (Supabase Auth).',
        '2. Add upcoming renewals; the list view sorts by `renews_on`.',
        '3. Your agents can call the app MCP tools (`list_renewals`, `add_renewal`, …).',
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
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'supabase/migrations/0001_init.sql',
        content:
          'create table if not exists renewals (\n' +
          '  id uuid primary key default gen_random_uuid(),\n' +
          '  owner uuid not null default auth.uid(),\n' +
          '  account text not null,\n' +
          '  product text,\n' +
          '  amount numeric,\n' +
          '  renews_on date,\n' +
          "  status text not null default 'upcoming'\n" +
          ');\n' +
          'alter table renewals enable row level security;\n' +
          'create policy "owner_rw" on renewals\n' +
          '  using (owner = auth.uid()) with check (owner = auth.uid());\n',
      },
      {
        path: 'Dockerfile',
        content:
          '# Next.js app — built by Sovereign Agentic OS CI -> Harbor -> Argo CD.\n' +
          'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci || true\nEXPOSE 8080\nCMD ["npm","run","start"]\n',
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

const TEMPLATES: Record<AppTemplateKey, Template> = {
  'nextjs-supabase': nextjsSupabaseTemplate(),
  service: genericTemplate('service', 'Service / API'),
  script: genericTemplate('script', 'Script / scheduled job'),
  dashboard: dashboardTemplate(),
};

export const APP_TEMPLATES: { key: AppTemplateKey; label: string }[] = [
  { key: 'nextjs-supabase', label: 'Web app (Next.js + Supabase)' },
  { key: 'service', label: 'Service / API' },
  { key: 'script', label: 'Script / scheduled job' },
  { key: 'dashboard', label: 'Dashboard-as-app' },
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
  return a.owner === user.id || (user.role === 'admin' && user.domains.includes(a.domain));
}

async function getCache(): Promise<Map<string, App>> {
  const s = appCacheState();
  if (s.cache) return s.cache;
  const map = new Map<string, App>();
  const docs = (await mirror.hydrate(500)) ?? []; // null → mirror down → in-memory only
  for (const app of docs as App[]) {
    // Back-compat: apps persisted before surface-detection get one inferred
    // from their scaffold so the monitor drives off surface, never `template`.
    if (!app.surface) app.surface = detectSurface(templateFiles(app.template, app.name, app.slug));
    map.set(app.id, app);
    // Re-hydrate the in-process MCP grant so agents can call it after a restart.
    if (app.connectionId) rehydrateConnection(app);
  }
  s.cache = map;
  return map;
}

/** Ensure the app registry and its version history are both hydrated. Used by the versions route. */
export async function ensureHydrated(): Promise<void> {
  await Promise.all([getCache(), versions.ensureHydrated()]);
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
 * Best-effort: create the per-app Forgejo repo + seed the template files. Returns
 * a live result when Forgejo is reachable, or an offline shell otherwise — the
 * golden path still works for teaching, honestly labelled.
 */
async function scaffoldRepo(
  slug: string,
  description: string,
  tpl: Template,
  name: string,
): Promise<{ mode: 'live' | 'offline'; fullName: string; htmlUrl: string; seeded: string[] }> {
  const owner = config.forgejoRepoOwner;
  const create = await forgejoWrite('/user/repos', {
    name: slug,
    description: description || `Scaffolded by the Sovereign Agentic OS (${tpl.label})`,
    private: true,
    auto_init: true,
    default_branch: 'main',
  });
  const fullName = String(create.data?.full_name ?? `${owner}/${slug}`);
  const htmlUrl = String(create.data?.html_url ?? `${config.forgejoConsoleUrl}/${fullName}`);
  if (!create.ok && create.status === 0) {
    // Forgejo unreachable -> offline shell.
    return { mode: 'offline', fullName, htmlUrl, seeded: [] };
  }
  // The CI workflow logs in to the registry with the REGISTRY_PASS Actions
  // secret; set it before seeding the workflow so the first push can build.
  // (Admin creds — the same local-dev convenience the demo-app seed uses.)
  await forgejoApi('PUT', `/repos/${owner}/${slug}/actions/secrets/REGISTRY_PASS`, {
    data: config.forgejoPassword,
  });
  const seeded: string[] = [];
  for (const f of tpl.files(name, slug)) {
    const r = await forgejoWrite(`/repos/${owner}/${slug}/contents/${f.path}`, {
      content: b64(f.content),
      message: `seed ${f.path}`,
      branch: 'main',
    });
    if (r.ok) seeded.push(f.path);
  }
  return { mode: 'live', fullName, htmlUrl, seeded };
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
 * PHYSICALLY delete the app's per-app Forgejo repo (the counterpart of
 * `scaffoldRepo`). Called on app DELETE only — archive keeps the repo so unarchive
 * can re-provision. Best-effort + HONEST: a 404 (already gone / never created) is a
 * benign success; an unreachable Forgejo (`status:0`) or a rejected delete is
 * reported so the delete never silently claims the repo is gone. Idempotent.
 */
export async function deleteAppRepo(
  app: App,
): Promise<{ ok: boolean; live: boolean; action: 'deleted' | 'noop'; detail: string }> {
  const { owner, repo } = repoCoords(app);
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

// ----------------------------------------------------------------- MCP wiring --

function rehydrateConnection(app: App): void {
  // Re-arm the auto-MCP capability profile in OPA (reads-on/writes-off) so the
  // governed gate works after a restart, not just the static app-registry grant.
  generateAndCompile(app.mcpPrincipal, { tools: app.mcpTools });
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
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

export async function getAppForUser(appId: string, user: CurrentUser): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a || !visibleToUser(a, user)) throw withStatus(new Error('App not found'), 404);
  return a;
}

// -------------------------------------------------------------------- Create ---

export async function createApp(
  user: CurrentUser,
  input: { name: string; description?: string; template?: AppTemplateKey; domain?: string },
): Promise<App> {
  const map = await getCache();
  const tpl = TEMPLATES[input.template ?? 'nextjs-supabase'] ?? TEMPLATES['nextjs-supabase'];
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
    actions: live ? 'ok' : 'pending',
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
      spec: { app: slug, table: 'renewals', backend: 'supabase' },
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
    template: tpl.key,
    owner: user.id,
    domain,
    visibility: 'Personal',
    mode: repo.mode,
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
    // The scaffold's surface, detected from the seed files. Re-detected on every
    // commit + at deploy as the agent builds, so it stays honest to the code.
    surface: detectSurface(tpl.files(name, slug)),
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
  const isOwner = a.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(a.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to edit this app'), 403);
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
      throw withStatus(new Error('Promoting to Shared requires a Builder or Administrator'), 403);
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
  const map = await getCache();
  return map.get(appId) ?? null;
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
