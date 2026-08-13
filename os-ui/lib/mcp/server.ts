/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { ROLES, type Role } from '@/lib/core/session';
import { config } from '@/lib/core/config';
import { PLATFORM_MCP_TOOLS, callPlatformMcp } from '@/lib/software/platform-mcp';
import { codedAppsEnabled } from '@/lib/platform-admin/settings';
import { authorize, queryRun, trace } from '@/lib/infra/governed';
import { servePredict } from '@/lib/science/serve';
import type { ChurnFeatures } from '@/lib/science';
import { retrieveKnowledge } from '@/lib/knowledge/retrieve';
import { listSystems, ensureHydrated as agentsHydrated } from '@/lib/agents/store';
import { ensureHydrated as datasetsHydrated } from '@/lib/data/store';
import { ensureHydrated as filesHydrated } from '@/lib/files/store';
import { ensureHydrated as knowledgeHydrated } from '@/lib/knowledge/store';
import { ensureHydrated as betsHydrated } from '@/lib/bigbets/store';
import { principalFor } from '@/lib/governance/roles';
import { readPrincipalFor } from '@/lib/data/store-fqn';
import { sanitizeSingleStatement } from '@/lib/data/sql-guard';
import { ALL_WRITE_TOOLS } from '@/lib/mcp/write-tools';
import { DISCOVERY_TOOLS } from '@/lib/mcp/discovery-tools';
import { governanceTools } from '@/lib/mcp/governance-tools';
import { strategyReadTools } from '@/lib/mcp/strategy-tools';
import { MANUAL_TOOLS } from '@/lib/mcp/manual-tools';
import { marketplaceReadTools } from '@/lib/mcp/marketplace-tools';
import { MONITORING_TOOLS } from '@/lib/mcp/monitoring-tools';
import {
  RESOURCES,
  RESOURCE_TEMPLATES,
  resourcesForTab,
  templatesForTab,
  type McpResource,
  type McpResourceTemplate,
} from '@/lib/mcp/resources';
import { PROMPTS, renderPrompt, promptsForTab, type McpPrompt } from '@/lib/mcp/prompts';
import { buildInstructions } from '@/lib/mcp/instructions';

/**
 * THE SOVEREIGN AGENTIC OS — remote MCP server (JSON-RPC 2.0 core).
 *
 * This is the ONE governed MCP surface a user imports into Claude / ChatGPT. It
 * is a pure, transport-free dispatcher (the HTTP/Streamable-HTTP shell lives in
 * `app/api/mcp/route.ts`) so it is trivially unit-testable.
 *
 * GOVERNANCE INVARIANT (inherited, not re-implemented): every tool delegates to
 * the EXACT SAME governed library function the UI + the bespoke `/api` routes
 * call, under the caller's delegated identity — so OPA policy, Langfuse audit and
 * role gates apply unchanged. There is NO privileged path here. The role→tool
 * visibility below is a conservative FLOOR: the underlying governed function is
 * always the real authority and is re-checked on every call (`tools/call` never
 * trusts the client, and re-checks the visibility floor too).
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_INFO = {
  name: 'sovereign-agentic-os',
  title: 'Sovereign Agentic OS',
  version: config.osVersion,
} as const;

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  /** Short schema-level note for the AI consumer. */
  description?: string;
  /** ≥1 worked example per write tool — an AI reads these to call correctly. */
  examples?: unknown[];
};

/**
 * The OS tabs that expose an MCP tool surface. Each tab gets a filtered view of
 * the ONE registry below (`/api/mcp/<tab>`) — a scoped lens, never a second
 * governance path. The overarching `/api/mcp` endpoint still serves them all.
 */
// `governance` + `marketplace` were the first mcp-v2 cross-cutting surfaces (P0):
// the approval queue + ladder + lineage + marketplace import. The mcp-v2 surfaces
// wave adds `strategy` (pillars/value) + `monitoring` (runs/traces, read-only) as
// full tabs alongside the marketplace/governance READ additions. `platform` lands
// WHEN its tools ship (every declared tab must carry ≥1 tool — the tabs.test invariant).
// `operating-manual` is the Plan-group tab that owns the My/Domain/Company
// Operating Model — its four MCP tools (get/update/list-versions/restore) wrap the
// governed manual store, so the tab now carries a real MCP surface. (The tab id + tool
// identifiers keep the `manual` name for wire stability; the product name is "Operating Model".)
export const MCP_TABS = ['software', 'data', 'science', 'knowledge', 'agents', 'files', 'metrics', 'dashboards', 'bigbets', 'connections', 'governance', 'marketplace', 'strategy', 'monitoring', 'operating-manual'] as const;
export type McpTab = (typeof MCP_TABS)[number];
export function isMcpTab(x: string): x is McpTab {
  return (MCP_TABS as readonly string[]).includes(x);
}

/**
 * `meta` is NOT a real tab (no route, no header button) — it tags the cross-cutting
 * discovery tools (`whoami`, `list_capabilities`) so they surface in EVERY per-tab
 * view AND the overarching endpoint. Kept out of {@link MCP_TABS} on purpose.
 */
export type ToolTab = McpTab | 'meta';

export type McpTool = {
  name: string;
  description: string;
  /** Lowest role that may SEE + CALL this tool (the governed fn still re-gates). */
  minRole: Role;
  /** The OS tab this tool lives under (used to build the per-tab MCP view). */
  tab: ToolTab;
  /** Extra tabs this tool ALSO surfaces on (e.g. promotion tools span data+files). */
  extraTabs?: ToolTab[];
  inputSchema: JsonSchema;
  call: (user: CurrentUser, args: Record<string, unknown>) => Promise<unknown>;
};

function rank(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleCanUse(role: Role, minRole: Role): boolean {
  return rank(role) >= rank(minRole);
}

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// --- Platform tools (Define→Design→Build→Test→Publish parity) ------------------
// Elevated tools are role-gated in the governed layer (promote/decide_deploy →
// builder+, delete → owner-or-builder+); we mirror that as the visibility floor.
// `commit` is DEVELOPER MODE — a raw direct file write that bypasses the staged
// governance, so it too floors at builder (the governed fn re-gates identically).
const ELEVATED = new Set(['promote', 'decide_deploy', 'delete', 'commit']);

// os-ui 0.6.133: the CODED-app-only tools. When the platform admin has coded apps OFF
// (the default), these are NOT advertised as available in list_capabilities (they are
// listed as gated with an honest reason) and fail-closed if called — Declarative
// authoring (set_app_spec / get_app_spec / generate) stays fully available. `commit`
// is the raw code-write path; the coded FRAMING of create_software (kind:'code') is
// enforced in createApp, so create_software itself stays advertised (a spec app uses it).
const CODED_ONLY_TOOLS = new Set(['commit']);

/** A build/test TARGET — the whole app, one epic, or one story (the Build-stage scope). */
const TARGET_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'The unit to act on. Omit for the whole app; pass epicId for an epic; epicId+storyId for one story.',
  properties: {
    kind: { type: 'string', enum: ['app', 'epic', 'story'], description: "Scope kind (default 'app')." },
    epicId: { type: 'string', description: 'Epic id (from get_software).' },
    storyId: { type: 'string', description: 'Story id (from get_software), with its epicId.' },
  },
};

// The Design-stage spec tree (epics → stories → per-story features/NFRs/rules). Mirrors
// the UI PATCH shape (set_app_design) so design_software authors it the governed way.
const DESIGN_EPICS_SCHEMA = {
  type: 'array' as const,
  description: 'Design epics. Each groups user stories under technical/UX/governance requirements; each story carries a spec (features/NFRs/rules) and a build status.',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      requirements: {
        type: 'object',
        properties: { technical: { type: 'string' }, ux: { type: 'string' }, governance: { type: 'string' } },
      },
      stories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            asA: { type: 'string' },
            iWant: { type: 'string' },
            soThat: { type: 'string' },
            acceptance: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'building', 'done'], description: "Set to 'done' after a build committed this story." },
            spec: {
              type: 'object',
              description: 'The Design spec: three editable lists the Build stage builds to and Test verifies against.',
              properties: {
                features: { type: 'array', items: { type: 'string' } },
                nfrs: { type: 'array', items: { type: 'string' } },
                rules: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['id', 'title', 'asA', 'iWant', 'soThat'],
        },
      },
    },
    required: ['id', 'title'],
  },
};

const GRANT_LEVELS = ['read-only', 'read-propose', 'read-write'];
const grantList = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: GRANT_LEVELS } }, required: ['id', 'access'] } };

const APP_ID_ONLY: JsonSchema = {
  type: 'object',
  properties: { appId: { type: 'string', description: 'Target app id.' } },
  required: ['appId'],
};

const CONSUME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    appId: { type: 'string', description: 'App consuming the resource.' },
    ref: { type: 'string', description: 'Reference to the granted resource (never a raw credential).' },
    label: { type: 'string', description: 'Human label for the consumed resource.' },
    scope: { type: 'string', enum: ['read', 'write-bounded'], description: 'Consumption scope.' },
  },
  required: ['appId', 'ref'],
};

const PLATFORM_SCHEMAS: Record<string, JsonSchema> = {
  create_software: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'App name.' },
      description: { type: 'string' },
      template: {
        type: 'string',
        description:
          "Only shapes a CODED app's scaffold (kind:'code'): 'sovereign-app' (Application — OS look, sign-in, admin; the default), 'website' (public site, no sign-in), 'api-service' (APIs only, headless), or 'empty' (blank canvas). Ignored for the default declarative (spec) app. Legacy keys (e.g. 'nextjs-supabase') stay accepted for existing apps.",
      },
      domain: { type: 'string', description: 'Domain to create in (must be one of yours).' },
      surface: {
        type: 'string',
        enum: ['ui', 'api', 'both'],
        description:
          "Declare the app's surface — 'ui' (serves a frontend), 'api' (headless / tool surface), or 'both'. Declaring it wins over auto-detection, so a UI app is never mislabelled as API. Omit to let the OS infer it from the code.",
      },
      purpose: {
        type: 'string',
        description: "The app's stated purpose (Define stage), ≤2000 chars. Optional at creation; update later with set_app_design.",
      },
      kind: {
        type: 'string',
        enum: ['spec', 'code'],
        description:
          "Serving kind. 'spec' (DEFAULT) creates a DECLARATIVE app served same-origin by the OS renderer — no Forgejo repo / CI / registry / pod; author it with set_app_spec or scaffold it with generate_app_spec (the spec IS the app). 'code' is the ADVANCED coded path (raw code + image build) — DISABLED unless a platform admin has enabled coded apps (createApp fails closed with 403 otherwise).",
      },
    },
    required: ['name'],
  },
  set_app_spec: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id from list_software.' },
      spec: {
        type: 'object',
        description:
          "The declarative AppSpec: { version: 2, name, description, theme?, tabs: [] }. Each tab is a cookbook PATTERN ({ kind:'pattern', pattern, config }) or a sandboxed CUSTOM block ({ kind:'custom', html, css?, js?, data? }). View-pattern sources must be a GRANTED dataset with REAL columns (get_dataset to discover). Validated author-time; blocking issues return { path, reason, fix } and persist nothing.",
      },
    },
    required: ['appId', 'spec'],
  },
  get_app_spec: {
    type: 'object',
    properties: { appId: { type: 'string', description: 'App id from list_software.' } },
    required: ['appId'],
  },
  generate_app_spec: {
    type: 'object',
    description:
      "Scaffold a complete declarative AppSpec from the app's designed epics/user-stories + granted data (datasets with real columns, metrics, agents). Returns a validated spec (NOT persisted) to review + publish with set_app_spec.",
    properties: { appId: { type: 'string', description: 'App id from list_software (must have designed epics + granted context).' } },
    required: ['appId'],
    examples: [{ appId: 'app_ab12cd' }],
  },
  design_software: {
    type: 'object',
    description: "STAGE 2 · DESIGN. Author the app's specification tree. All fields except appId are optional; unset fields are untouched.",
    properties: {
      appId: { type: 'string', description: 'App id from list_software.' },
      purpose: { type: 'string', description: "The app's stated purpose (Define/Design), ≤2000 chars." },
      epics: DESIGN_EPICS_SCHEMA,
      grants: {
        type: 'object',
        description: 'Governed context grants (capability metadata — never raw credentials).',
        properties: {
          connections: grantList,
          data: grantList,
          knowledge: grantList,
          files: grantList,
          metrics: grantList,
        },
      },
    },
    required: ['appId'],
    examples: [
      {
        appId: 'app_ab12cd',
        epics: [{ id: 'epic_1', title: 'Ticket triage', stories: [{ id: 'story_1', title: 'Auto-label', asA: 'agent', iWant: 'tickets labelled on arrival', soThat: 'I triage faster', spec: { features: ['Label on arrival'], nfrs: ['<200ms'], rules: ['No PII in logs'] } }] }],
      },
    ],
  },
  build_software: {
    type: 'object',
    description: 'STAGE 3 · BUILD. Build a unit from its finalized spec (design-before-build gated, standard tier). Returns the governed build directive + committed files + built-vs-pending.',
    properties: { appId: { type: 'string', description: 'App id from list_software.' }, target: TARGET_SCHEMA },
    required: ['appId'],
    examples: [{ appId: 'app_ab12cd', target: { kind: 'story', epicId: 'epic_1', storyId: 'story_1' } }],
  },
  verify_software: {
    type: 'object',
    description: 'STAGE 4 · TEST. 5-dimension verification of a built unit against its spec. Returns the governed test directive + committed files; optional findings become dimension-tagged refinements.',
    properties: {
      appId: { type: 'string', description: 'App id from list_software.' },
      target: TARGET_SCHEMA,
      findings: {
        type: 'array',
        description: 'Shortfalls found while verifying. Each is normalized into a dimension-tagged refinement.',
        items: {
          type: 'object',
          properties: {
            storyId: { type: 'string', description: 'The story the shortfall belongs to.' },
            note: { type: 'string', description: 'What to change.' },
            dimension: { type: 'string', enum: ['functionality', 'ux', 'code', 'security', 'docs'] },
            kind: { type: 'string', enum: ['rebuild', 'design'], description: "'rebuild' = missed spec (default); 'design' = the requirement itself changes." },
            featureIndex: { type: 'number' },
          },
          required: ['storyId', 'note'],
        },
      },
    },
    required: ['appId'],
    examples: [{ appId: 'app_ab12cd', target: { kind: 'story', epicId: 'epic_1', storyId: 'story_1' }, findings: [{ storyId: 'story_1', note: 'Empty state missing', dimension: 'ux' }] }],
  },
  commit: {
    type: 'object',
    properties: {
      appId: { type: 'string' },
      message: { type: 'string', description: 'Commit message.' },
      name: { type: 'string' },
      description: { type: 'string' },
      files: {
        type: 'array',
        description: 'Files to commit.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    required: ['appId'],
  },
  start_preview: APP_ID_ONLY,
  request_deploy: APP_ID_ONLY,
  decide_deploy: {
    type: 'object',
    properties: {
      cardId: { type: 'string', description: 'Deploy review card id.' },
      decision: { type: 'string', enum: ['approve', 'deny'] },
      note: { type: 'string' },
    },
    required: ['cardId', 'decision'],
  },
  use_connection: CONSUME_SCHEMA,
  use_data: CONSUME_SCHEMA,
  use_knowledge: CONSUME_SCHEMA,
  use_as_data: APP_ID_ONLY,
  promote: APP_ID_ONLY,
  archive: APP_ID_ONLY,
  delete: APP_ID_ONLY,
};

const platformTools: McpTool[] = PLATFORM_MCP_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  minRole: ELEVATED.has(t.name) ? 'builder' : 'creator',
  tab: 'software',
  inputSchema: PLATFORM_SCHEMAS[t.name] ?? APP_ID_ONLY,
  call: (user, args) => callPlatformMcp(user, t.name, args),
}));

// --- Cross-OS high-value tools -------------------------------------------------
const crossTools: McpTool[] = [
  {
    name: 'query_data',
    description:
      'Run a read-only SQL query over the governed Iceberg marts (Trino). OPA-authorized on your domain and Langfuse-audited, exactly like the UI data tool.',
    minRole: 'creator',
    tab: 'data',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A read-only SQL statement.' } },
      required: ['sql'],
    },
    call: async (user, args) => {
      const rawSql = str(args.sql).trim();
      if (!rawSql) fail('query_data needs a `sql` string', 400);
      // Normalize a model's trailing `;` (Trino rejects a bare separator) before the
      // governed read runs; a surviving internal `;` is a real multi-statement request
      // → a clear, actionable error, NOT a Trino syntax stack trace.
      const sanitized = sanitizeSingleStatement(rawSql);
      if (!sanitized.ok) fail(sanitized.reason, 400);
      const sql = sanitized.sql;
      // TWO distinct principals here:
      //  - TOOL-ACCESS authz (`agentic.authz`) is granted by DOMAIN/agent-key —
      //    `data.grants[<domain>]` holds `query` — so the access gate runs on the
      //    caller's domain principal (a uid has no grant of its own).
      //  - The TRINO SESSION USER (data-governance principal for row/column + the
      //    personal-lane `is_owned_personal` hard-deny) MUST be the OWNER uid when the
      //    SQL touches the caller's OWN personal lane (`personal_<uid>.*`) — even the
      //    owner is DENIED reading their own personal table under the domain principal.
      //    Every other read stays on the domain principal so cross-domain governance is
      //    intact. Derived server-side from session + SQL text (same rule preview/profile
      //    use), never from the request body; only the caller's OWN lane flips it.
      const domainPrincipal = user.domains[0] ?? user.id;
      const trinoPrincipal = readPrincipalFor(sql, { id: user.id, domains: user.domains });
      const authz = await authorize(domainPrincipal, 'query');
      if (!authz.allowed) fail(`OPA denied ${domainPrincipal} → query (${authz.policy})`, 403);
      const result = await queryRun(sql, trinoPrincipal);
      const traced = await trace({ principal: trinoPrincipal, tool: 'query', input: sql, output: result.rows });
      return { principal: trinoPrincipal, authorized: true, policy: authz.policy, traced, ...result };
    },
  },
  {
    name: 'science_predict',
    description:
      'Score a DEPLOYED model through the governed predict door. `model` = the registry model name from list_models (default: churn_model, the seeded slice). Path: the Science golden path (guide: sovereign-os://guide/path/science). Governance: runs AS YOU (principal user:<id>) — tier scope + your OPA `predict` grant (the model OWNER may always score their own model), then a Langfuse trace. 404 when ml.enabled=false; a missing grant → forbidden; a not-yet-deployed model → conflict.',
    minRole: 'creator',
    tab: 'science',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Registry model name to score (see list_models). Default: churn_model.' },
        account: { type: 'string', description: 'Account id to score.' },
        features: { type: 'object', description: "Optional feature overrides (keys = the model spec's feature names)." },
      },
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true to enable predict', 404);
      // Run-as-user invariant: score under the CALLER's own identity + domains,
      // never a hardcoded service principal. Their OPA `predict` grant decides.
      const result = await servePredict({
        model: str(args.model) || undefined,
        account: str(args.account) || undefined,
        features: (args.features as Partial<ChurnFeatures>) || undefined,
        principal: principalFor(user),
        domains: user.domains,
        isAgent: false,
        requestedBy: user.id,
      });
      return result.body;
    },
  },
];

// --- Knowledge tab (governed retrieval) ----------------------------------------
const knowledgeTools: McpTool[] = [
  {
    name: 'search_knowledge',
    description:
      'Governed hybrid knowledge retrieval (dense + lexical, reranked) with provenance for citations. Runs the same OPA `retrieve` gate + document-level grant filter as the Knowledge tab — you only ever see units you are entitled to.',
    minRole: 'creator',
    tab: 'knowledge',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to retrieve.' },
        k: { type: 'number', description: 'Max hits (default 6, capped at 20).' },
      },
      required: ['query'],
    },
    call: async (user, args) => {
      const query = str(args.query).trim();
      if (!query) fail('search_knowledge needs a `query` string', 400);
      const k = typeof args.k === 'number' && args.k > 0 ? Math.min(Math.floor(args.k), 20) : undefined;
      return retrieveKnowledge(
        query,
        { id: user.id, domains: user.domains, role: user.role },
        k ? { k } : {},
      );
    },
  },
];

// --- Agents tab (read-only system inventory) -----------------------------------
const agentTools: McpTool[] = [
  {
    name: 'list_agent_systems',
    description:
      'List the agent systems you can see (also called: AI teams, assistant teams) — yours, domain-shared, marketplace. Read-only and scoped to your identity — the same visibility rule as the Agents tab.',
    minRole: 'creator',
    tab: 'agents',
    inputSchema: { type: 'object', properties: {} },
    call: async (user) => listSystems({ id: user.id, domains: user.domains, role: user.role }),
  },
];

// --- Discovery (meta) tools — make the OS legible to an AI consumer ------------
/** A plain-language read of what a role can / cannot do (4 roles: creator <
 * builder < domain_admin < admin — the creator lockdown stays the floor). */
function capabilitySummary(role: Role): { can: string[]; cannot: string[] } {
  const builder = roleCanUse(role, 'builder');
  const domainAdmin = roleCanUse(role, 'domain_admin');
  const admin = roleCanUse(role, 'admin');
  return {
    can: [
      'create datasets, files, knowledge workflows, metrics, dashboards, big bets and agent systems in your own domain(s)',
      'build, document and query your own work',
      ...(builder ? ['promote/publish your work to a SHARED domain asset (dataset/file/workflow/agent)'] : []),
      ...(domainAdmin && !admin ? ['administer users in your OWN domain(s): invite, edit, deactivate, assign roles up to builder'] : []),
      ...(admin ? ['certify to the cross-domain marketplace', 'own a cross-domain big bet', 'administer users tenant-wide (incl. appointing domain admins)'] : []),
    ],
    cannot: [
      ...(!builder ? ['promote/publish to a shared domain asset — that is Builder+ (ask a Builder, or keep it Personal)'] : []),
      ...(!domainAdmin ? ['administer users — that is Domain admin+ (in-domain) or Admin (tenant-wide)'] : []),
      ...(!admin ? ['certify to the marketplace — that is Admin-only', ...(domainAdmin ? ['assign the domain_admin or admin role — only the platform Admin appoints those'] : [])] : []),
    ],
  };
}

const discoveryTools: McpTool[] = [
  {
    name: 'whoami',
    tab: 'meta',
    minRole: 'creator',
    description:
      'Return the caller’s delegated identity (id, name, role, domains) and a plain-language read of what this role can and cannot do. Every write tool runs AS this user — start here.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      domains: user.domains,
      ...capabilitySummary(user.role),
    }),
  },
  {
    name: 'list_capabilities',
    tab: 'meta',
    minRole: 'creator',
    description:
      'List every OS tool with its tab + role gate, split into what THIS caller can call now vs. what is gated to a higher role (and why). The map an AI reads before building a case study across tabs.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => {
      const rows = ALL_MCP_TOOLS.map((t) => ({
        name: t.name,
        tab: t.tab,
        minRole: t.minRole,
        description: t.description,
      }));
      // os-ui 0.6.133: when coded apps are OFF, the coded-only tools are advertised as
      // GATED (with an honest reason), never as available — Declarative authoring stays open.
      const coded = codedAppsEnabled();
      const codedGated = (name: string) => !coded && CODED_ONLY_TOOLS.has(name);
      const available = rows.filter((r) => roleCanUse(user.role, r.minRole) && !codedGated(r.name));
      const gated = rows
        .filter((r) => !roleCanUse(user.role, r.minRole) || codedGated(r.name))
        .map((r) => ({
          ...r,
          reason: codedGated(r.name)
            ? 'coded (custom) apps are disabled by the platform administrator — use Declarative authoring (set_app_spec)'
            : `requires ${r.minRole}; you are ${user.role}`,
        }));
      return {
        role: user.role,
        availableCount: available.length,
        available,
        gated,
        // A client fetches its tool manifest at connect: a tool listed here but not callable
        // in your client means your MCP session predates it — reconnect the MCP server to refresh.
        note: "If a tool listed here isn't callable in your client, your MCP session predates it — reconnect the MCP server to refresh the tool list.",
      };
    },
  },
];

export const ALL_MCP_TOOLS: McpTool[] = [
  ...platformTools,
  ...crossTools,
  ...knowledgeTools,
  ...agentTools,
  ...ALL_WRITE_TOOLS,
  ...DISCOVERY_TOOLS,
  ...governanceTools,
  ...strategyReadTools,
  ...MANUAL_TOOLS,
  ...marketplaceReadTools,
  ...MONITORING_TOOLS,
  ...discoveryTools,
];

/**
 * The subset of the registry that lives under one tab (the per-tab MCP view). The
 * cross-cutting `meta` discovery tools are ALWAYS included so `whoami` /
 * `list_capabilities` work on every per-tab endpoint too.
 */
export function toolsForTab(tab: McpTab): McpTool[] {
  return ALL_MCP_TOOLS.filter((t) => t.tab === tab || t.tab === 'meta' || t.extraTabs?.includes(tab));
}

/** The role-scoped, wire-shaped tool list for `tools/list` (no internals leak). */
export function listToolsForRole(
  role: Role,
  tools: McpTool[] = ALL_MCP_TOOLS,
): { name: string; description: string; inputSchema: JsonSchema }[] {
  return tools.filter((t) => roleCanUse(role, t.minRole)).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

// --- JSON-RPC 2.0 dispatch -----------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** The MCP resource-not-found error (-32002), carrying the uri in `data`. */
function rpcResourceNotFound(id: string | number | null | undefined, uri: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32002, message: `Resource not found: ${uri || '(none)'}`, data: { uri } } };
}

/**
 * Optional per-endpoint scoping. The overarching `/api/mcp` passes nothing (→ the
 * full registry + generic serverInfo); a per-tab `/api/mcp/<tab>` passes that
 * tab's filtered tool subset, a per-tab serverInfo, and its CONTEXT.md as MCP
 * `instructions`. It is a lens, NOT a second governance path — every tools/call
 * still routes through the same governed function and is re-gated by role.
 */
export type HandleRpcOptions = {
  tools?: McpTool[];
  resources?: McpResource[];
  resourceTemplates?: McpResourceTemplate[];
  prompts?: McpPrompt[];
  serverInfo?: { name: string; title: string; version: string };
  instructions?: string;
};

/** The role-scoped wire list for `resources/list` (no `read` fn / internals leak). */
export function listResourcesForRole(
  role: Role,
  resources: McpResource[] = RESOURCES,
): { uri: string; name: string; title: string; description: string; mimeType: string; annotations: { audience: string[]; priority?: number } }[] {
  return resources
    .filter((r) => roleCanUse(role, r.minRole))
    .map((r) => ({
      uri: r.uri,
      name: r.name,
      title: r.title,
      description: r.description,
      mimeType: r.mimeType,
      annotations: { audience: ['assistant'], ...(r.priority !== undefined ? { priority: r.priority } : {}) },
    }));
}

/** The wire list for `resources/templates/list`. */
export function listResourceTemplatesForRole(
  role: Role,
  templates: McpResourceTemplate[] = RESOURCE_TEMPLATES,
): { uriTemplate: string; name: string; title: string; description: string; mimeType: string }[] {
  return templates
    .filter((r) => roleCanUse(role, r.minRole))
    .map((r) => ({ uriTemplate: r.uriTemplate, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType }));
}

/** The wire list for `prompts/list`. */
export function listPromptsForRole(
  role: Role,
  prompts: McpPrompt[] = PROMPTS,
): { name: string; title: string; description: string; arguments: { name: string; description: string; required?: boolean }[] }[] {
  return prompts
    .filter((p) => roleCanUse(role, p.minRole))
    .map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments }));
}

/**
 * Match a concrete `resources/read` uri against the exact resources + the
 * templates ({id}). Returns a resolver bound to the caller, or null if no
 * registered uri matches (→ -32002, indistinguishable from "not visible").
 */
function resolveResourceUri(
  uri: string,
  resources: McpResource[],
  templates: McpResourceTemplate[],
): { minRole: Role; mimeType: string; read: (user: CurrentUser) => Promise<string> } | null {
  const exact = resources.find((r) => r.uri === uri);
  if (exact) return { minRole: exact.minRole, mimeType: exact.mimeType, read: exact.read };
  for (const t of templates) {
    // 'sovereign-os://dataset/{id}' → capture the single {id} segment.
    const prefix = t.uriTemplate.replace(/\{[^}]+\}$/, '');
    if (prefix && prefix !== t.uriTemplate && uri.startsWith(prefix)) {
      const idPart = uri.slice(prefix.length);
      if (idPart && !idPart.includes('/')) {
        return { minRole: t.minRole, mimeType: t.mimeType, read: (user) => t.read(user, { id: idPart }) };
      }
    }
  }
  return null;
}

/**
 * Handle a single JSON-RPC request under the caller's delegated identity.
 * Returns the response object, or `null` for a notification (no reply expected).
 */
export async function handleRpc(
  user: CurrentUser,
  req: JsonRpcRequest,
  opts: HandleRpcOptions = {},
): Promise<JsonRpcResponse | null> {
  const id = req?.id ?? null;
  const method = req?.method;
  const tools = opts.tools ?? ALL_MCP_TOOLS;
  const resources = opts.resources ?? RESOURCES;
  const resourceTemplates = opts.resourceTemplates ?? RESOURCE_TEMPLATES;
  const prompts = opts.prompts ?? PROMPTS;

  // Notifications (e.g. notifications/initialized) get no response body.
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  // Hydrate the durable-mirrored stores BEFORE any read/write — the same seam the
  // HTTP routes get via their server boundaries (requirePrincipal → ensureHydrated).
  // Without this, a fresh pod's first MCP call would see an EMPTY registry even
  // though the mirror has the data. Idempotent + graceful (offline → in-memory).
  if (method === 'tools/call' || method === 'resources/read') {
    await Promise.all([datasetsHydrated(), filesHydrated(), agentsHydrated(), knowledgeHydrated(), betsHydrated()]);
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Declare all three primitives. No subscribe/listChanged: this transport
        // is POST-only (no server-initiated stream), so we never promise updates.
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: { listChanged: false },
        },
        serverInfo: opts.serverInfo ?? MCP_SERVER_INFO,
        // Instructions ALWAYS present — orientation reaches the model before any
        // call. A per-tab endpoint passes its own; the overarching one defaults
        // to the full orientation.
        instructions: opts.instructions ?? buildInstructions(),
      });

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: listToolsForRole(user.role, tools) });

    case 'resources/list':
      return ok(id, { resources: listResourcesForRole(user.role, resources) });

    case 'resources/templates/list':
      return ok(id, { resourceTemplates: listResourceTemplatesForRole(user.role, resourceTemplates) });

    case 'resources/read': {
      const uri = str((req.params ?? {}).uri);
      const match = resolveResourceUri(uri, resources, resourceTemplates);
      // Unknown, out-of-scope, or role-denied → the SAME -32002. A denial is
      // indistinguishable from "not found" (no existence leak), mirroring tools.
      if (!match || !roleCanUse(user.role, match.minRole)) {
        return rpcResourceNotFound(id, uri);
      }
      try {
        const text = await match.read(user);
        return ok(id, { contents: [{ uri, mimeType: match.mimeType, text }] });
      } catch (e) {
        // A governed 404 (id you cannot see) is a resource-not-found, not a crash.
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 403) return rpcResourceNotFound(id, uri);
        return rpcError(id, -32603, (e as Error).message || 'resources/read failed');
      }
    }

    case 'prompts/list':
      return ok(id, { prompts: listPromptsForRole(user.role, prompts) });

    case 'prompts/get': {
      const params = req.params ?? {};
      const name = str(params.name);
      const prompt = prompts.find((p) => p.name === name && roleCanUse(user.role, p.minRole));
      if (!prompt) return rpcError(id, -32602, `Prompt not available: ${name || '(none)'}`);
      const args = (params.arguments as Record<string, string>) ?? {};
      // Validate required args (a prompt renders TEXT only — it never executes).
      const missing = prompt.arguments.filter((a) => a.required && !str(args[a.name]).trim());
      if (missing.length) {
        return rpcError(id, -32602, `Missing required argument(s): ${missing.map((m) => m.name).join(', ')}`);
      }
      return ok(id, { description: prompt.description, messages: renderPrompt(prompt, user, args) });
    }

    case 'tools/call': {
      const params = req.params ?? {};
      const name = str(params.name);
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const tool = tools.find((t) => t.name === name);
      // An unknown / out-of-scope tool stays a JSON-RPC error (don't even hint at
      // tools this endpoint doesn't serve).
      if (!tool) return rpcError(id, -32602, `Tool not available: ${name || '(none)'}`);
      // Re-check the role floor on every call — never trust the client. A denial is a
      // TYPED forbidden content block (the client named this tool, so this is a hint,
      // not a leak): the AI learns exactly what role it needs.
      if (!roleCanUse(user.role, tool.minRole)) {
        return toolError(id, {
          code: 'forbidden',
          reason: `${tool.name} requires ${tool.minRole}; you are ${user.role}`,
          hint: `Ask a ${tool.minRole} to run it, or keep your work Personal.`,
        });
      }
      try {
        const result = await tool.call(user, args);
        return ok(id, { content: [{ type: 'text', text: safeText(result) }] });
      } catch (e) {
        // Governance denials + execution failures surface as a TYPED MCP tool error
        // (isError + structuredContent) — model-readable, actionable, NEVER a crash.
        return toolError(id, structuredError(e));
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method ?? '(none)'}`);
  }
}

/** A structured, model-readable tool error: `{ error: { code, reason, hint } }`. */
export type ToolError = { code: string; reason: string; hint: string };

function toolError(id: string | number | null | undefined, error: ToolError): JsonRpcResponse {
  return ok(id, {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  });
}

/** Map a thrown error (its HTTP-ish `status`) to a typed code + an actionable hint. */
export function structuredError(e: unknown): ToolError {
  const status = (e as { status?: number }).status;
  const reason = (e as Error).message || 'Tool execution failed';
  const code =
    status === 403 ? 'forbidden'
      : status === 404 ? 'not_found'
        : status === 409 ? 'conflict'
          : status === 400 ? 'bad_request'
            : 'error';
  const hint =
    code === 'forbidden'
      ? 'This needs a higher role or a domain you belong to — ask a Builder/Admin, or keep it Personal.'
      : code === 'not_found'
        ? 'Check the id — call list_capabilities or the tab’s list tool first.'
        : code === 'conflict'
          ? 'Already in that state — this call is idempotent, so no further action is needed.'
          : code === 'bad_request'
            ? 'Check your arguments against the tool’s inputSchema (each carries an example).'
            : 'Unexpected failure — retry, or inspect `reason`.';
  return { code, reason, hint };
}

function safeText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
