/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from '@/lib/mcp/server';
import { PLATFORM_MCP_TOOLS, callPlatformMcp } from '@/lib/experimental/software/platform-mcp';

// #28: extracted from server.ts (Define→Design→Build→Test→Publish tools, `software` tab, non-base).
//
// Elevated tools are role-gated in the governed layer (promote/decide_deploy →
// builder+, delete → owner-or-builder+); we mirror that as the visibility floor.
// `commit` is DEVELOPER MODE — a raw direct file write that bypasses the staged
// governance, so it too floors at builder (the governed fn re-gates identically).
const ELEVATED = new Set(['promote', 'decide_deploy', 'delete', 'commit']);

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

export const platformTools: McpTool[] = PLATFORM_MCP_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  minRole: ELEVATED.has(t.name) ? 'builder' : 'creator',
  tab: 'software',
  inputSchema: PLATFORM_SCHEMAS[t.name] ?? APP_ID_ONLY,
  call: (user, args) => callPlatformMcp(user, t.name, args),
}));
