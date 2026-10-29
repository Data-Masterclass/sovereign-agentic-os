/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { emptyContextGrants, normalizeContextGrants, type ContextGrants } from '@core/kernel/context-grants';
import { emptyAgentGrants, normalizeAgentGrants, type AppAgentGrant } from '@tabs/software/lib/app-agent-grants';
import type { CurrentUser } from '@core/kernel/auth';
import { canPromote, roleAtLeast } from '@core/kernel/session';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
import type { Visibility } from '@core/kernel/artifact-model';
import {
  createArtifact,
  promoteArtifact,
  getArtifact,
  type Artifact,
} from '@core/kernel/artifacts';
import {
  registerConnection,
  setConnectionVisibility,
  getConnectionByApp,
  type AppConnection,
  type AppTool,
} from '@core/infra/app-registry';
import { trace } from '@core/infra/agent-governed';
import type {
  AppStatus,
  DeployState,
  DeployEnvelope,
  AppManifest,
  AppSurface,
  ConsumedResource,
  ScaffoldFile,
  SurfaceDeclaration,
} from '@tabs/software/lib/model';
import { normalizeSpec, type StorySpec } from '@tabs/software/lib/story-spec';
import type { AppSpec, SpecIssue } from '@tabs/software/lib/appspec/schema';
import { parseAppSpec } from '@tabs/software/lib/appspec/schema';
import type { SpecWarning } from '@tabs/software/lib/appspec/validate';
import { detectPreviewShape } from '@tabs/software/lib/preview-shape';
import { viteOsFiles } from '@tabs/software/lib/scaffolds/vite-os';
import { sovereignAppFiles, sovereignAppGuide } from '@tabs/software/lib/scaffolds/sovereign-app';
import { websiteFiles, websiteGuide } from '@tabs/software/lib/scaffolds/website';
import { apiServiceFiles, apiServiceGuide } from '@tabs/software/lib/scaffolds/api-service';
import { emptyAppFiles, emptyAppGuide } from '@tabs/software/lib/scaffolds/empty-app';
import { snapshotFiles, getSnapshot, hydrateSnapshot, deleteSnapshot } from '@tabs/software/lib/snapshot';
import { generateAndCompile } from '@tabs/software/lib/auto-mcp';
import { dataPlaneToolsFromGrants, agentToolsFromGrants } from '@tabs/software/lib/grant-tools';
import { parseAppManifest, renderAppYaml, defaultOpenApi, resolveSurface } from '@tabs/software/lib/metadata';
import { osMirror } from '@core/infra/os-mirror';
import { getPublicUser, type PublicUser } from '@tabs/admin/lib/users';
import { codedAppsEnabled, ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '@core/folders/index';
import { normaliseFolderPath } from '@core/kernel/folders';
import { type ArtifactVersion, versionLog } from '@core/kernel/versioning';
import { createHash } from 'node:crypto';

/**
 * App registry — the home of record for every application built in the Software
 * tab (Software golden path). Each app is a self-contained governed unit: its
 * design decisions, data descriptions, docs and build-chat history all live
 * here, "under the app"; its source tree/MCP/connection/data references hang
 * off it; and it carries its own Personal→Shared→Marketplace lifecycle.
 *
 * Persistence mirrors `lib/artifacts.ts`: an authoritative in-process cache (so
 * the teaching flow works with NO cluster) plus a best-effort OpenSearch
 * write-through ("os-apps" index) for durability in a real deploy. The scoping +
 * promotion rules below are the security boundary regardless of backing store.
 *
 * There is NO git backend: a coded app's source of truth is the durable file
 * mirror (`snapshot.ts` → the `os-app-files` index), seeded from the template at
 * create time and advanced by every governed commit (`server.ts commitToApp`) or
 * editor save. What is LIVE vs STUBBED locally:
 *   • Auto-MCP → Connection + agent tool — registered in-process (app-registry)
 *     so the creator's agents can call it through the governed authorize→trace
 *     spine immediately; a real deploy would also push the grant to OPA.
 *   • Data/files → Personal artifacts — REAL artifacts via `createArtifact`,
 *     owned by the creator, visible in the Data tab, promoted by the same ladder.
 *   • Serving — the in-cluster runner (`runner.ts`) for image/runtime apps and the
 *     same-origin OS renderer for declarative (spec) apps.
 */

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
 * How an app is served (Phase D + AppSpec Phase 3). The DEFAULT + every legacy record
 * is 'image' (the per-app container path); 'runtime' opts into the OS no-image runtime
 * serving; 'spec' opts into declarative AppSpec same-origin serving (the OS renders
 * `app.spec` under the viewer's session — no pod, see appspec/DESIGN.md).
 */
export type ServeMode = 'image' | 'runtime' | 'spec';

/**
 * The ONE coercion for a persisted/incoming `serveMode`: only the explicit strings
 * 'runtime' / 'spec' opt in; anything else (undefined on a legacy record, garbage, or
 * the explicit 'image') resolves to 'image'. Keeps the field byte-stable + nil-safe.
 */
export function normalizeServeMode(raw: unknown): ServeMode {
  return raw === 'runtime' ? 'runtime' : raw === 'spec' ? 'spec' : 'image';
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
  /**
   * The SIXTH Choose-Context type (Phase 4b): governed AGENTS the app may run. Agents are
   * how intelligence enters an app — built + evaluated + role-gated in the Agents tab, granted
   * here, invoked at runtime via a "Run agent" action (the invocation is Phase 4c; this field
   * RECORDS the grant). Kept as a SEPARATE additive list (not a sixth kind of the OS-wide
   * `ContextGrants` primitive, which the Agents builder also uses) so legacy apps load
   * unchanged. Optional-on-load: pre-4b apps default to `[]` in hydrateAppDoc.
   */
  agents: AppAgentGrant[];
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
   * A DISPLAY-only organiser — it NEVER affects the app's frozen `slug` (image/
   * container/host identity). Personal apps fold into the owner's personal tree; a
   * Shared/Certified app folds into the owning domain's tree (see folderScopeOfApp).
   * Optional-on-load: apps persisted before folders default to '/' in hydrateAppDoc.
   */
  folder: string;
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
  /**
   * The declarative AppSpec (AppSpec Phase 3). Present ONLY when `serveMode === 'spec'`:
   * the validated, git-backed contract the trusted OS renderer serves same-origin under
   * the viewer's session — no per-app image/pod. `setAppSpec` is the sole write door
   * (author-time `validateAppSpec` gate). Optional-on-load so every legacy record (and
   * every image/runtime app) round-trips byte-stable with the field simply absent.
   */
  spec?: AppSpec;
  /**
   * The AUTOSAVED candidate spec (os-ui 0.6.135 — the DRAFT/LIVE model). The composer
   * autosaves every change here WITHOUT the serve-validation gate (a partial, not-yet-valid
   * draft saves fine), so an app always persists + always shows in the tiles — even before
   * its first Publish. `spec` stays the LIVE, served + versioned field; `draftSpec` is the
   * work-in-progress. Publish validates `draftSpec` with the full serving gate and promotes it
   * into `spec`. Optional-on-load so every legacy record (only `spec`, or neither) round-trips
   * byte-stable with the field simply absent — serving is UNCHANGED (it always reads `spec`).
   */
  draftSpec?: AppSpec;
  /**
   * The app's SOURCE TREE record. `seeded` lists the template files written into the
   * durable file mirror when the coded app was scaffolded (a spec app seeds nothing).
   * A non-empty list is the persisted "this app has committed code" signal the stage
   * gates + the earned-built-ness guard read; the tree itself lives in `snapshot.ts`.
   */
  repo: { seeded: string[] };
  subdomain: string;
  /**
   * Explicit prebuilt container image the in-cluster runner should serve (Phase 2
   * runner). Optional: when unset the runner uses the SOFTWARE_RUNNER_IMAGE default.
   * We NEVER build images in-cluster — this is a reference to an already-built one.
   */
  runImage?: string;
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
  /**
   * REVOCATION flag for the app's OWN records write access (`os.records.add/export`).
   * Undefined/false = the 0.6.97 default: the app's own record writes are auto-approved
   * out of the box (see `envelopeAllowsRecordTool`). Set true to REVOKE that default —
   * writes then run live only if a Builder listed them in the approved deploy envelope.
   * Optional-on-load (undefined = default-on) so pre-0.6.97 apps stay byte-stable.
   * This ONLY governs the app's own records; it never touches dataset/knowledge/file grants.
   */
  recordWritesRevoked?: boolean;
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
  /** Files seeded into the app's source tree at scaffold time. */
  files: (name: string, slug: string) => { path: string; content: string }[];
};

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
        `Live at **https://${sub}** (once published and the runner serves it).`,
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
          '# Next.js app — scaffolded by the Sovereign Agentic OS Software tab.\n' +
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
      // The metadata convention (parsed on every commit → app page + auto-MCP).
      {
        path: 'app.yaml',
        content: renderAppYaml({
          name,
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
        `Live at **https://${sub}** (once published and the runner serves it).`,
        '',
        '## Use',
        '1. Open the app — it calls `os.whoami()` and `os.context()` on boot.',
        '2. The starter page renders your granted datasets, metrics, and knowledge.',
        '3. Replace `src/App.tsx` with your real UI.',
        '4. Your agents can call the app MCP tools (`list_records`, `refresh`, …).',
      ].join('\n'),
    // The vite-os scaffold files (package.json, Dockerfile, src/*, nginx.conf, …)
    // come from the standalone template data module so they stay pure-data and
    // never get compiled by os-ui's own Next.js / tsc build.
    files: (name, slug) => viteOsFiles(name, slug),
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
        `Live at **https://${sub}** (once published and the runner serves it).`,
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
 * infra base as sovereign-app, so preview/deploy are identical.
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
        '- **Served by:** nginx on port 8080 via the same multi-stage Docker build as every app.',
      ].join('\n'),
    dataDescriptions: (name) =>
      [`# ${name} — data descriptions`, '', 'A public site: content lives in the code; no operational data model yet.'].join('\n'),
    docs: (name, sub) => [websiteGuide(name), '', `Live at **https://${sub}** (once published and the runner serves it).`].join('\n'),
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
    docs: (name, sub) => [apiServiceGuide(name), '', `Live at **https://${sub}** (once published and the runner serves it).`].join('\n'),
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
    docs: (name, sub) => [emptyAppGuide(name), '', `Live at **https://${sub}** (once published and the runner serves it).`].join('\n'),
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

// `hydrated` distinguishes "cache is the mirror's authoritative snapshot" from "cache exists
// but the mirror was UNREACHABLE at load, so it may be missing persisted apps" — the latter must
// re-hydrate on the next read once the mirror is back (so apps never disappear for the pod's life).
type AppCacheState = { cache: Map<string, App> | null; hydrated: boolean };
const APP_STATE_KEY = Symbol.for('soa.apps.cache');
function appCacheState(): AppCacheState {
  const g = globalThis as unknown as Record<symbol, AppCacheState | undefined>;
  if (!g[APP_STATE_KEY]) g[APP_STATE_KEY] = { cache: null, hydrated: false };
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
// Fresh-index safety: a brand-new os-apps index is created with `dynamic:false` and a raised
// field-count limit. An app doc carries arbitrary, wildly-varying spec JSON (cookbook-pattern
// configs), which under OpenSearch's DEFAULT dynamic mapping either explodes the 1000-field
// limit or type-conflicts across apps — the PUT is then rejected and a fully-built PUBLISHED app
// silently fails to persist (it "disappears" on the next pod roll). `dynamic:false` stores every
// field in `_source` (so retrieval is unaffected — we only GET-by-id and match_all) without
// indexing arbitrary sub-fields. NOTE: this only applies when the index is first CREATED; an
// existing index is fixed by the spec/draftSpec string-persist below, which needs no reindex.
const mirror = osMirror({
  index: config.appsIndex,
  createBody: { settings: { 'index.mapping.total_fields.limit': 4000 }, mappings: { dynamic: false } },
});

// Durable, per-artifact version history. Snapshots the user-editable doc content
// (designDecisions, dataDescriptions, docs) before each meaningful mutation.
const versions = versionLog('app');

/**
 * The doc actually persisted to the mirror. The app's two BIG, ARBITRARY-SHAPE fields —
 * `spec` and `draftSpec` (cookbook-pattern configs whose keys/types vary per app) — are
 * serialized to JSON STRINGS (`specJson` / `draftSpecJson`) and the object fields dropped, so
 * OpenSearch maps them as ONE text field each instead of dynamically mapping every nested key.
 * That is what stops the field-limit blowout / type-conflict that made a fully-built PUBLISHED
 * app fail to write and vanish. It also works on the EXISTING index (new field names never
 * clash with the old `spec` OBJECT mapping). `hydrateAppDoc` reverses it (parses the strings
 * back, with legacy-object fallback). Nothing else about the doc changes.
 */
function toPersistedDoc(a: App): Record<string, unknown> {
  const { spec, draftSpec, ...rest } = a as App & { spec?: unknown; draftSpec?: unknown };
  const doc: Record<string, unknown> = { ...rest };
  if (spec !== undefined) doc.specJson = JSON.stringify(spec);
  if (draftSpec !== undefined) doc.draftSpecJson = JSON.stringify(draftSpec);
  return doc;
}

function writeThrough(a: App): void {
  mirror.writeThrough(a.id, toPersistedDoc(a));
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
  // Reverse toPersistedDoc: the spec/draftSpec are stored as JSON STRINGS (specJson /
  // draftSpecJson) so OpenSearch never dynamic-maps their arbitrary sub-fields. Parse them back
  // into the object fields the app model uses. Legacy docs (persisted as the raw `spec`/`draftSpec`
  // OBJECT, pre-0.6.164) have no *Json field and fall through unchanged. A corrupt string is
  // ignored (leave the field undefined) rather than throwing away the whole app.
  const raw = app as App & { specJson?: unknown; draftSpecJson?: unknown };
  if (typeof raw.specJson === 'string') {
    try { app.spec = JSON.parse(raw.specJson); } catch { /* leave spec as-is */ }
    delete raw.specJson;
  }
  if (typeof raw.draftSpecJson === 'string') {
    try { app.draftSpec = JSON.parse(raw.draftSpecJson); } catch { /* leave draftSpec as-is */ }
    delete raw.draftSpecJson;
  }
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
  // The source-tree record keeps ONLY the seeded paths (legacy docs carried the git
  // repo coordinates of a backend that no longer exists — dropped on load).
  app.repo = { seeded: Array.isArray(app.repo?.seeded) ? app.repo.seeded.filter((p) => typeof p === 'string') : [] };
  app.grants = normalizeContextGrants(app.grants);
  // Back-compat: apps persisted before the Phase-4b agents grant default to `[]`.
  app.agents = normalizeAgentGrants(app.agents);
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
  // A fully-hydrated cache is authoritative — serve it. A cache that exists but is NOT yet
  // hydrated (built during a mirror outage) falls through to RE-hydrate below.
  if (s.cache && s.hydrated) return s.cache;
  const docs = await mirror.hydrate(500); // null → mirror UNREACHABLE; [] → reachable-but-empty
  if (docs === null) {
    // Mirror unreachable: keep an in-process cache so THIS pod's creates are retained, but leave
    // hydrated=FALSE so the next read re-hydrates from the mirror the moment it recovers — and
    // apps persisted before this boot / by other pods reappear. Caching an empty map as if it
    // were authoritative (the old `?? []`) poisoned the list empty for the whole pod lifetime:
    // every app "disappeared" from the tiles until the next restart. A by-id read
    // (getAppByIdWithMirror) still hits the mirror directly meanwhile.
    if (!s.cache) s.cache = new Map();
    return s.cache;
  }
  // Mirror reachable: the persisted docs are the truth for the ids they contain. Fold them in,
  // preserving any in-process-only apps created during an outage (still queued for write-through).
  const map = new Map<string, App>();
  for (const app of docs as App[]) {
    hydrateAppDoc(app);
    map.set(app.id, app);
  }
  if (s.cache) for (const [appId, app] of s.cache) if (!map.has(appId)) map.set(appId, app);
  s.cache = map;
  s.hydrated = true;
  return map;
}

/** Ensure the app registry and its version history are both hydrated. Used by the versions route. */
export async function ensureHydrated(): Promise<void> {
  await Promise.all([getCache(), versions.ensureHydrated()]);
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Reassigns the app's `domain` (the visibility-scoping field) and writes through.
 * `sel.id` moves one; `sel.onlyUnassigned` sweeps only empty-domain records.
 * Returns the ids moved.
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

// ------------------------------------------------------------- Code editor ----
//
// Read/edit/commit an app's source straight from its durable source tree — the
// file mirror (`snapshot.ts`), the ONE home of a coded app's files (Software golden
// path §2 — the in-browser code editor beside the build assistant). Gated to
// Builders + Administrators here AND in the API route, and audited through the
// same Langfuse spine as every other governed action.

export type RepoFileMeta = { files: string[] };
export type RepoFile = { path: string; content: string; sha: string };
export type RepoCommit = { path: string; sha: string };

/** Builder+ only — the code editor mutates the app's source tree. */
function ensureBuilder(user: CurrentUser): void {
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('The code editor is available to Builders and Administrators.'), 403);
  }
}

/** Reject absolute / parent-traversal paths before they reach the tree. */
function sanitizeRepoPath(p: string): string {
  const clean = (p ?? '').replace(/^\/+/, '').trim();
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw withStatus(new Error('Invalid file path'), 400);
  }
  return clean;
}

/** Stable content sha for the editor's optimistic concurrency (a stale save → 409). */
function blobSha(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex');
}

/**
 * The app's CURRENT source tree: the durable file mirror (hydrated on a cold process
 * so it survives a pod restart), else the template seed for an app with no tree yet.
 */
async function appTree(app: App): Promise<ScaffoldFile[]> {
  await hydrateSnapshot(app.id);
  return getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
}

/** Flat, recursive list of the app's source files. */
export async function listAppFiles(appId: string, user: CurrentUser): Promise<RepoFileMeta> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  return treeMeta(await appTree(app));
}

/**
 * READ-ONLY tree for anyone who can SEE the app (the MCP read-back counterpart of
 * the Builder-gated code editor above). The gate is the same visibility rule as
 * `getAppForUser` — reading the tree mutates nothing, so it does not need the
 * Builder floor the editor's write path carries.
 */
export async function listAppFilesForViewer(appId: string, user: CurrentUser): Promise<RepoFileMeta> {
  const app = await getAppForUser(appId, user);
  return treeMeta(await appTree(app));
}

function treeMeta(files: ScaffoldFile[]): RepoFileMeta {
  return { files: files.map((f) => f.path).sort((a, b) => a.localeCompare(b)) };
}

export type DirEntry = { name: string; path: string; type: 'file' | 'dir' };

/**
 * The IMMEDIATE children of a directory, derived from the app's flat file tree.
 * Given every file path in the repo and a directory prefix, returns each direct
 * child once — a file (`type:'file'`) or a subdirectory (`type:'dir'`), never the
 * whole recursive subtree. `dir` may carry a trailing slash or be '' (the root).
 * Pure: works over any flat path list, so `read_app_files` can answer a directory
 * path with a listing instead of a dead end (the build agent passed `src/epics` and
 * hit "not an editable file").
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

/**
 * The app's CURRENT frontend files for the in-browser instant preview: the durable
 * source tree, else the fresh template. VIEW-gated only (getAppForUser), so any user
 * who can see the app can preview it; the preview itself calls the OS as the
 * signed-in user so governance still decides what data renders.
 */
export async function previewFilesForApp(
  appId: string,
  user: CurrentUser,
): Promise<{ files: ScaffoldFile[]; template: AppTemplateKey }> {
  const app = await getAppForUser(appId, user);
  return { files: await appTree(app), template: app.template };
}

/** Read one file's content + its current content sha (for the editor's save). */
export async function readAppFile(appId: string, user: CurrentUser, path: string): Promise<RepoFile> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  return treeRead(await appTree(app), path);
}

/** READ-ONLY single-file read for anyone who can SEE the app (view gate only). */
export async function readAppFileForViewer(appId: string, user: CurrentUser, path: string): Promise<RepoFile> {
  const app = await getAppForUser(appId, user);
  return treeRead(await appTree(app), path);
}

function treeRead(tree: ScaffoldFile[], path: string): RepoFile {
  const clean = sanitizeRepoPath(path);
  const f = tree.find((x) => x.path === clean);
  if (!f) {
    // A directory prefix is not a file — the MCP tool answers it with dirListing.
    if (tree.some((x) => x.path.startsWith(`${clean}/`))) {
      throw withStatus(new Error('That path is not an editable file.'), 400);
    }
    throw withStatus(new Error('File not found.'), 404);
  }
  return { path: clean, content: f.content, sha: blobSha(f.content) };
}

/**
 * Save = commit. Writes the file into the app's durable source tree, using the
 * content sha the editor loaded for optimistic concurrency (a stale sha → 409
 * "reload and retry"). Audited like every other governed mutation. The saved tree is
 * exactly what the deploy security scan and the instant preview read next.
 */
export async function saveAppFile(
  appId: string,
  user: CurrentUser,
  input: { path: string; content: string; sha: string; message?: string },
): Promise<RepoCommit> {
  ensureBuilder(user);
  const app = await getAppForUser(appId, user);
  const clean = sanitizeRepoPath(input.path);
  const message =
    (input.message ?? '').trim() || `Edit ${clean} via Sovereign Agentic OS code editor`;
  // Hydrate the durable mirror first so a save after a pod restart merges over the
  // app's REAL tree, not the bare template seed.
  const prior = await appTree(app);
  const existing = prior.find((f) => f.path === clean);
  if (existing && input.sha && blobSha(existing.content) !== input.sha) {
    throw withStatus(new Error('File changed since you loaded it — reload and retry.'), 409);
  }
  snapshotFiles(app.id, [...prior.filter((f) => f.path !== clean), { path: clean, content: input.content }]);
  app.updatedAt = now();
  writeThrough(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'edit_file', path: clean, by: user.id, role: user.role, message },
    output: { slug: app.slug },
    decision: 'allow',
  });
  return { path: clean, sha: blobSha(input.content) };
}

// ------------------------------------------------------------ Built-ness -----

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
 * NO story can be `done`, so any persisted `done` is demoted to `todo`. "Has built code"
 * is {@link hasBuiltCode} — a committed epic/story page, or any file beyond the template
 * seed. It never PROMOTES (that stays earned by a real build), so it can only make the
 * record MORE honest. Idempotent + write-through; safe to call on every load.
 */
/**
 * Has this app any code that was actually BUILT for it, as opposed to the template
 * seed every coded app is scaffolded with? With no git backend there is no commit log
 * to ask, so the honest signals are the app's own file store: a committed EPIC/story
 * page (`src/epics/<epic>/<story>/Page.tsx`, the build agent's story-code convention),
 * or any file in the tree that is NOT part of the scaffold seed. The template seed
 * alone is explicitly NOT "built" — otherwise every freshly-created app would claim it.
 */
export function hasBuiltCode(app: Pick<App, 'id' | 'repo'>): boolean {
  const tree = getSnapshot(app.id) ?? [];
  const seeded = new Set(app.repo.seeded);
  return tree.some(
    (f) =>
      /^src\/epics\/[^/]+\/(?!general\/)[^/]+\/[A-Z][A-Za-z0-9]*\.tsx$/.test(f.path) ||
      !seeded.has(f.path),
  );
}

export function reconcileBuiltStatus(app: App): { demoted: number } {
  // A genuinely built app: trust its per-story status (the earned post-build flip). Only
  // an app with demonstrably nothing built has its phantom `done` claims cleared.
  if (hasBuiltCode(app)) return { demoted: 0 };
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
 * Public write-through so server-side orchestration (and tests) can persist a mutated
 * app through the SAME durable path every mutator here uses (no second store).
 */
export function writeThroughApp(app: App): void {
  writeThrough(app);
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
 * Set an app's declarative AppSpec (AppSpec Phase 3 — the ONE write door for `app.spec`).
 * This is what the Phase-4 authoring MCP tool + the demo-seed call; there is NO MCP wiring
 * in Phase 3.
 *
 * • AUTHORIZE with the SAME owner-or-in-domain-builder check `startPreview` uses (a mere
 *   viewer cannot rewrite an app's served surface).
 * • GATE on `validateAppSpec` (Phase 1): a `spec` that has any BLOCKING issue is returned as
 *   `{ issues }` and NOT persisted — the app is left exactly as it was. Otherwise the spec
 *   is set, `serveMode` flips to 'spec', the app is persisted, and non-blocking `warnings`
 *   are returned so the caller can surface them.
 *
 * `spec` is accepted as `unknown` and re-parsed through `parseAppSpec` here so the structural
 * grammar is enforced at the door too: a structurally-malformed payload returns its parse
 * issues (never persisted), identical in shape to the semantic issues.
 */
export async function setAppSpec(
  appId: string,
  spec: unknown,
  user: CurrentUser,
): Promise<{ app: App; issues: SpecIssue[]; warnings: SpecWarning[]; version: ArtifactVersion | null }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder =
    app.owner === user.id || (roleAtLeast(user.role, 'builder') && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can set this app spec'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot set a spec'), 409);

  // Structural gate first — a malformed payload returns its parse issues, unpersisted.
  const parsed = parseAppSpec(spec);
  if (!parsed.ok) return { app, issues: parsed.issues, warnings: [], version: null };

  // Semantic gate — dataset/column/metric/grant invariants against the real stores.
  // Imported LAZILY: validate.ts pulls in the data/metrics stores, and keeping that off the
  // module-load path of apps.ts preserves the store-mock isolation other suites rely on.
  const { validateAppSpec } = await import('@tabs/software/lib/appspec/validate');
  const { issues, warnings } = await validateAppSpec(app, parsed.spec, user);
  if (issues.length > 0) return { app, issues, warnings, version: null };

  // A GOVERNED AUTHOR = a versioned PUBLISH (0.6.136). set_app_spec writes the LIVE spec, so it
  // must be at parity with the UI Publish (publishApp): snapshot a version with an auto short
  // name + a deterministic, LLM-free change summary (a describeApp diff of the previous live spec
  // vs the newly-set one). Same shared version log the Publish surface uses (this snapshot
  // log IS the app's version history).
  const { summarizeSpecChange, autoVersionName } = await import('@tabs/software/lib/appspec/change-summary');
  const previousLive = app.spec ?? null;
  const summary = summarizeSpecChange(previousLive, parsed.spec);

  app.spec = parsed.spec;
  app.draftSpec = undefined; // the authored spec is now the live spec — clear any stale draft.
  app.serveMode = 'spec';
  app.deploy = { ...app.deploy, releases: app.deploy.releases + 1 };

  const name = autoVersionName(app.deploy.releases);
  const version = versions.record(appId, user.id, { spec: parsed.spec, name }, `${name} — ${summary}`);

  await persistApp(app);
  return { app, issues: [], warnings, version };
}

/**
 * AUTOSAVE the candidate `draftSpec` (os-ui 0.6.135 — the DRAFT/LIVE model). This is the write
 * door for the composer's continuous autosave: it persists the work-in-progress WITHOUT the
 * serve-validation gate, so a partial / not-yet-valid draft saves fine and the app always shows
 * in the tiles (even before its first Publish). It NEVER touches `spec` (the live served field)
 * and NEVER snapshots a version — Publish is the only go-live gate.
 *
 * • AUTHORIZE with the SAME owner-or-in-domain-builder check `setAppSpec` uses.
 * • BEST-EFFORT structural parse: a clean payload is stored as a parsed AppSpec; a structurally
 *   incomplete payload is stored verbatim (never rejected) so no keystrokes are lost. Serving is
 *   unaffected either way (it reads `spec`, not `draftSpec`).
 * • Flip `serveMode` to 'spec' so the app is recognised as a declarative app in the tiles/rail
 *   from its very first draft (it only SERVES once `spec` is set on Publish).
 * Idempotent + debounce-friendly: re-saving the same payload is a plain write-through.
 */
export async function saveAppDraft(appId: string, draft: unknown, user: CurrentUser): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder =
    app.owner === user.id || (roleAtLeast(user.role, 'builder') && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can edit this app draft'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot save a draft'), 409);

  const parsed = parseAppSpec(draft);
  // A clean parse stores the normalised spec; an incomplete one stores the raw payload so the
  // composer can re-hydrate exactly what the author had (no serve-gate here, by design).
  app.draftSpec = (parsed.ok ? parsed.spec : (draft as AppSpec)) ?? undefined;
  app.serveMode = 'spec';
  await persistApp(app);
  return app;
}

/**
 * PUBLISH (os-ui 0.6.135) — the ONE explicit go-live gate. Validates the app's autosaved
 * `draftSpec` with the FULL serving gate (`parseAppSpec` structural + `validateAppSpec` semantic),
 * and on success PROMOTES it to `spec` (live at `/apps/<slug>`) and SNAPSHOTS a version with an
 * auto short name (`v{n}`) + a deterministic, LLM-free change summary (a `describeApp` diff of the
 * previous live spec vs the newly-published one). A draft with any BLOCKING issue is returned as
 * `{ issues }` and NOTHING is promoted (the app keeps serving its current live `spec`).
 *
 * Falls back to `spec` when there is no `draftSpec` (a legacy app whose draft == live) so Publish
 * is never a no-op that silently drops the app. Edit-scoped owner-or-in-domain-builder.
 */
export async function publishApp(
  appId: string,
  user: CurrentUser,
): Promise<{ app: App; issues: SpecIssue[]; warnings: SpecWarning[]; version: ArtifactVersion | null }> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  const ownerOrBuilder =
    app.owner === user.id || (roleAtLeast(user.role, 'builder') && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can publish this app'), 403);
  if (app.status === 'archived') throw withStatus(new Error('Archived apps cannot be published'), 409);

  // The candidate to go live: the autosaved draft, else the current live spec (draft == live).
  const candidate = app.draftSpec ?? app.spec;
  if (candidate === undefined) {
    throw withStatus(new Error('There is nothing to publish yet — build a draft first.'), 409);
  }

  // Structural gate first — a malformed candidate returns its parse issues, unpublished.
  const parsed = parseAppSpec(candidate);
  if (!parsed.ok) return { app, issues: parsed.issues, warnings: [], version: null };

  // Semantic gate — the SAME serving gate `setAppSpec` runs (dataset/column/metric/grant invariants).
  const { validateAppSpec } = await import('@tabs/software/lib/appspec/validate');
  const { issues, warnings } = await validateAppSpec(app, parsed.spec, user);
  if (issues.length > 0) return { app, issues, warnings, version: null };

  // Deterministic change summary: diff the PREVIOUS live spec vs the newly-published one.
  const { summarizeSpecChange, autoVersionName } = await import('@tabs/software/lib/appspec/change-summary');
  const previousLive = app.spec ?? null;
  const summary = summarizeSpecChange(previousLive, parsed.spec);

  // Promote draft → live. Serving flips on immediately (same-origin OS render, no build).
  app.spec = parsed.spec;
  app.draftSpec = undefined; // the draft is now the live spec — clear the candidate.
  app.serveMode = 'spec';
  app.deploy = { ...app.deploy, releases: app.deploy.releases + 1 };

  // Snapshot the published version via the shared version log (the app's version history).
  const name = autoVersionName(app.deploy.releases);
  const version = versions.record(appId, user.id, { spec: parsed.spec, name }, `${name} — ${summary}`);

  await persistApp(app);
  void trace({
    principal: app.mcpPrincipal,
    tool: 'generate',
    input: { action: 'publish_app', slug: app.slug, version: name, by: user.id, role: user.role },
    output: { summary, tabs: parsed.spec.tabs.length },
    decision: 'allow',
  });
  return { app, issues: [], warnings, version };
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
  const agentTools = agentToolsFromGrants(app.agents);
  generateAndCompile(app.mcpPrincipal, { tools: [...app.mcpTools, ...grantTools, ...agentTools] });
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
  input: {
    name: string;
    description?: string;
    template?: AppTemplateKey;
    domain?: string;
    surface?: SurfaceDeclaration;
    purpose?: string;
    /**
     * The app's SERVING KIND (AppSpec Phase 4a). Defaults to `'code'` — the coded
     * path (a scaffolded source tree served by the in-cluster runner). `'spec'` opts a
     * fresh app into DECLARATIVE serving: the OS renders its validated `spec` same-origin
     * under the viewer's session (see appspec/DESIGN.md), so it needs NO source tree /
     * image / pod. A spec app therefore seeds nothing at create time (`serveMode:'spec'`)
     * and becomes servable at `/apps/<slug>` the moment `setAppSpec` validates + persists
     * its spec.
     */
    kind?: 'spec' | 'code';
  },
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

  // A DECLARATIVE (spec) app is served same-origin by the OS renderer — it has NO
  // source tree / image / pod, so it seeds nothing at create time. Everything else
  // (governed MCP connection, data artifact, lifecycle) is identical to a code app.
  const specKind = input.kind === 'spec';

  // FAIL-CLOSED platform gate (os-ui 0.6.133): when the platform admin has coded apps
  // OFF (the default), a coded app (`kind:'code'`) cannot be created — from ANY front
  // door (UI, API, MCP). Declarative (spec) creation is always allowed. This is the
  // server-side gate: the UI merely reflects it, it does NOT enforce it. Rejected
  // BEFORE any side effect runs. Hydrate the persisted flag first so a redeployed pod
  // honours the admin's saved decision.
  if (!specKind) await ensureSettingsHydrated();
  if (!specKind && !codedAppsEnabled()) {
    throw withStatus(
      new Error('Coded apps are disabled by the platform administrator. Create a Declarative (no-code) app instead (kind: "spec").'),
      403,
    );
  }

  // 1. The source tree — code apps only. The template files are the app's first
  //    committed tree, written to the durable file mirror once the id is known below.
  const seedFiles: ScaffoldFile[] = specKind ? [] : tpl.files(name, slug);

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
    agents: emptyAgentGrants(),
    template: tpl.key,
    owner: user.id,
    domain,
    visibility: 'Personal',
    // Least-privilege: the creator is the sole (implicit) admin; no other account
    // has app-admin standing until explicitly added via addAppMember.
    members: [],
    folder: '/',
    // A spec app is served declaratively (same-origin OS renderer) from the moment its
    // spec is set; a code app is served the historic way (per-app image) until the owner
    // opts into OS runtime serving on the Publish surface. (setAppSpec also flips this to
    // 'spec' — this just makes a spec app's serveMode correct BEFORE its first spec.)
    serveMode: specKind ? 'spec' : 'image',
    repo: { seeded: seedFiles.map((f) => f.path) },
    subdomain,
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
  // The scaffold IS the first commit: seed the durable source tree (code apps only).
  if (seedFiles.length > 0) snapshotFiles(app.id, seedFiles);

  // 5. Audit the creation through the same Langfuse spine the agents use.
  void trace({
    principal: mcpPrincipal,
    tool: 'generate',
    input: { action: 'create_app', name, template: tpl.key },
    output: { appId: app.id, seeded: seedFiles.length, connection: connectionId },
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
  patch: { purpose?: string; epics?: AppEpic[]; grants?: ContextGrants; agents?: AppAgentGrant[] },
): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  if (patch.purpose !== undefined) a.purpose = patch.purpose.slice(0, 2000);
  if (patch.epics !== undefined) {
    // EARNED built-ness: a caller (esp. a build agent via design_software) must not flip a
    // story to `done` on an app with no built code — that was the phantom-built lie. If
    // nothing beyond the template seed exists, force every incoming `done`/`building` back
    // to `todo` before persist. A genuinely built app trusts the incoming status.
    const built = hasBuiltCode(a);
    const epics = normalizeEpicSpecs(patch.epics);
    a.epics = built
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
  if (patch.agents !== undefined) {
    // The Phase-4b agents grant follows the SAME grants→runtime-truth rule: an agent grant
    // re-compiles the app's OPA profile so a granted agent becomes runnable (run_agent_system
    // + its discovery companion), and access is dropped the moment the grant is revoked.
    a.agents = normalizeAgentGrants(patch.agents);
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
 * discipline: `slug` is the FROZEN physical identity (runner objects, container
 * image, per-app host). Unlike a dataset — whose physical slug is derived-from-name
 * and must be PINNED before the first rename — an app's `slug` is set ONCE at create
 * (`slugify(name)`) and stored as its own field; nothing ever re-derives it from
 * `name`. So it is already decoupled: renaming leaves `slug` (and thus the
 * image/container FQN + subdomain) byte-identical by construction —
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
 * Restore a prior version of an app. Restore is auditable + reversible: the current state is
 * snapshotted as a new version first, then the chosen version is applied. Edit-scoped.
 *
 * Two snapshot shapes are handled (0.6.135): a PUBLISHED spec snapshot (`{ spec }`, from
 * `publishApp`) restores that spec straight back to LIVE (and clears any draft); the historic
 * DOC-CONTENT snapshot (`{ designDecisions, … }`) restores the doc fields. A snapshot with
 * neither is 422 (nothing restorable).
 */
export async function restoreAppVersion(appId: string, user: CurrentUser, version: number): Promise<App> {
  const map = await getCache();
  const a = map.get(appId);
  if (!a || !visibleToUser(a, user)) throw withStatus(new Error('App not found'), 404);
  if (!isOwnerOrAdminApp(a, user)) throw withStatus(new Error('Not permitted to edit this app'), 403);
  const snap = versions.get(appId, version);
  if (!snap) throw withStatus(new Error(`Version ${version} not found`), 404);

  // Published-spec snapshot: promote the prior spec straight back to LIVE, snapshotting the
  // current live spec first so the restore itself is reversible.
  const specSnap = (snap.state as { spec?: unknown }).spec;
  if (specSnap && typeof specSnap === 'object') {
    if (a.spec) versions.record(appId, user.id, { spec: a.spec, name: `restore of v${version}` }, `restore of v${version}`);
    a.spec = specSnap as AppSpec;
    a.draftSpec = undefined; // the restored spec is now the live + working spec
    a.serveMode = 'spec';
    a.updatedAt = now();
    map.set(a.id, a);
    writeThrough(a);
    return a;
  }

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
  s.hydrated = false;
  mirror.__reset();
  versions.__reset();
}

export { withStatus };
export type { Artifact, ArtifactVersion };
