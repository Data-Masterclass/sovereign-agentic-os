/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from './write-common';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  archiveDataset,
  deleteDataset,
  defineMeasure,
  buildGoldJoin as commitGoldJoin,
  addCheck,
  builtLayerFqn,
  type PromotionRequest,
} from '@/lib/data/store';
import { runQualityChecks } from '@/lib/data/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';
import { queryRun } from '@/lib/infra/governed';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@/lib/governance/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@/lib/data/panels';
import { scaffoldCubeYaml } from '@/lib/data/metrics';
import { ingestAndRegisterBronze } from '@/lib/data/ingest';
import { buildStage, commitLayerVersion } from '@/lib/data/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToCube,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@/lib/data/transform';
import { assetTarget } from '@/lib/data/store-fqn';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@/lib/data';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';
import { buildMetric } from '@/lib/metrics/build/server';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { getMetric } from '@/lib/metrics/store';
import { governMetric, canPromote as canPromoteMetric } from '@/lib/metrics/governance';
import { transition as transitionDataset } from '@/lib/data/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@/lib/knowledge/store';
import { knowledgeConsumers } from '@/lib/knowledge/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@/lib/governance/ladder';
import { pendingHandle } from '@/lib/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@/lib/knowledge/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import { putBlob } from '@/lib/files/object-store';
import type { Sensitivity } from '@/lib/files/asset-schema';

import { saveDashboard } from '@/lib/dashboards/store';
import { fromTiles, type ChartSpec } from '@/lib/dashboards/model';
import { claimsFromUser, delegate } from '@/lib/data/identity';

import {
  createBet,
  getBet,
  updateBet,
  addComponent,
  archiveBet,
  unarchiveBet,
  deleteBet,
  restoreBetVersion,
  setBetWorkflow,
  wireComponents,
  unwireComponents,
  canEdit as canEditBet,
  type CreateBetInput,
} from '@/lib/bigbets/store';
import { getPillar } from '@/lib/strategy/pillars';
import { deriveBetName, INTERPLAY_RELATIONS, type BigBet, type InterplayRelation, type Tab as BetTab, type ValueBasis } from '@/lib/bigbets';
import { resolveLinkedComponent } from '@/lib/bigbets/attach-server';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';
import { buildSystem } from '@/lib/agents/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@/lib/software/apps';
import { normalizeContextGrants } from '@/lib/core/context-grants';

// ================================ AGENTS ======================================
export const agentWriteTools: McpTool[] = [
  {
    name: 'create_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Create a new agent system (also called: AI team, assistant team). Always starts My-scope/owner-only — in My scope you have full rights and the system (which runs AS you) needs no approval. Sharing is the governed promote ladder (a domain admin approves the flip to Domain, an Admin certifies to Company). Optionally start from a server-authored template.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'System name, e.g. "Support triage".' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        template: { type: 'string', enum: ['blank', 'analyze', 'evaluate', 'recommend'], description: 'Optional starter template.' },
      },
      required: ['name'],
      examples: [{ name: 'Support triage', domain: 'support', template: 'analyze' }],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_agent_system needs a `name`', 400);
      const rec = createSystem(P(user), {
        name,
        domain: str(args.domain) || undefined,
        template: isTemplateKey(args.template) ? args.template : undefined,
      });
      return { id: rec.id, name: rec.name, visibility: rec.visibility };
    },
  },
  {
    name: 'commit_agent_files',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Commit one or more whitelisted files into an agent system you can edit (only `system.yaml` and `agents/<id>/AGENT.md` | `agents/<id>/MEMORY.md`). system.yaml is validated on write. Idempotent per identical content. GRANTS (what the team "can use") are authored IN system.yaml under `grants`, grouped exactly like the Agents-builder "What your team can use" surface: CONTEXT grants — `data` · `knowledge` · `metrics` · `connections` (each a list of { id, capability } items, plus `data` items may carry a `layer`) and `files` (folder grants only); and PLAN-ITEM grants — `plan` (the Operating Model, Strategic Pillars and Big Bets an agent may load as read context). CAPABILITIES: the system\'s Define grants are default-on — every sub-agent INHERITS the FULL set by default; narrow a sub-agent to REDUCE its reach, never to widen it. Per-item ACCESS LEVEL is the `capability`: `Read` (read-only) · `Write-approval` (read + propose — a write is DRAFTED/held for a human) · `Write-bounded` (read + write — this is what gives the agent that resource\'s write tools). The write GATE is scope-aware: a My (personal) write runs directly run-as-you with no hold; only a Domain/Company write is held for the right admin. A grant may instead target a whole FOLDER — set `folder: { path, scope }` (scope = personal|domain) with an empty `id`; it late-binds to every item currently under that folder at build/run time, each still per-item DLS-checked. Sub-agent grants ⊆ system grants; nothing here can exceed the caller\'s own entitlements or role. (The interactive labelled selector, category headings and folder-tree picker are the Agents-tab UI over this same schema.)',
    inputSchema: {
      type: 'object',
      properties: {
        systemId: { type: 'string', description: 'Target system id.' },
        files: {
          type: 'array',
          description: 'Files to write.',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        path: { type: 'string', description: 'Single-file shortcut (use with `content`).' },
        content: { type: 'string', description: 'Single-file content (use with `path`).' },
      },
      required: ['systemId'],
      examples: [
        { systemId: 'sys_ab12cd', files: [{ path: 'agents/analyst/AGENT.md', content: '# Analyst\nYou classify incoming tickets.' }] },
      ],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('commit_agent_files needs a `systemId`', 400);
      const files = normFiles(args);
      if (!files.length) fail('commit_agent_files needs `files` [{path,content}] (or a single path+content)', 400);
      const p = P(user);
      const committed = files.map((f) => {
        const r = writeAgentFile(systemId, p, { path: f.path, content: f.content, sha: '' });
        return { path: r.path, sha: r.sha };
      });
      return { systemId, committed };
    },
  },
  {
    name: 'build_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Build (execute + verify) an agent system you can edit across the adapters, landing Langfuse traces. Returns ✓/✗ rows. Idempotent — re-run any time.',
    inputSchema: {
      type: 'object',
      properties: { systemId: { type: 'string', description: 'System id to build.' } },
      required: ['systemId'],
      examples: [{ systemId: 'sys_ab12cd' }],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('build_agent_system needs a `systemId`', 400);
      const view = getSystemForEdit(systemId, P(user));
      return buildSystem(systemId, view.yaml);
    },
  },
  {
    name: 'run_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'RUN an agentic-os team (LangGraph, OS-MCP tool grants) for one turn and return the reply + the per-node governed tool steps — the same in-process, run-as-user executor the Agents tab uses. Purpose: close the Agents golden path (build → RUN) over MCP. Before: list_agent_systems / get_agent_system (and build_agent_system for a ✓ build). After: read the per-node steps; wire the system into a Big Bet or schedule. Governance + recursion, stated honestly: the team’s OWN tool calls dispatch through the SAME governed door as this call (grant-scoped, OPA `os-<systemId>` pre-gated, then handleRpc AS YOU) — so a team can never exceed its declared grants NOR your role; there is no escalation in the loop. You must own the system or be entitled to run it (a domain-Shared system is runnable by in-domain members); a non-runnable id is a typed forbidden. A hermes/legacy-grant system cannot run in-process — that is a typed bad_request pointing to the Agents tab UI. Note: the run drives a live LLM; each node takes seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        systemId: { type: 'string', description: 'The agent system to run (from list_agent_systems).' },
        message: { type: 'string', description: 'The user message for this turn.' },
        messages: {
          type: 'array',
          description: 'Optional multi-turn conversation (overrides `message`); last 20 kept.',
          items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'] },
        },
      },
      required: ['systemId', 'message'],
      examples: [{ systemId: 'sys_ab12cd', message: 'Analyze last quarter’s refund workflow and summarize the risks.' }],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('run_agent_system needs a `systemId`', 400);
      // Run-scope authorization BEFORE any side effect (owner / in-domain admin /
      // in-domain member of a Shared system) — the same gate as the Agents tab run.
      const view = getSystemForRun(systemId, P(user));
      const msgs = runMessages(args);
      // Dynamic imports: agentic-graph-server reads the tool registry at module init,
      // so a static import here would be a server.ts ↔ write-tools.ts cycle.
      const { isAgenticOsTeam } = await import('@/lib/agents/build/os-tools');
      if (!isAgenticOsTeam(view.system)) {
        fail(
          'This system does not run on the in-process agentic-os path (hermes runtime or legacy/unmapped tool grants) — run it from the Agents tab UI instead',
          400,
        );
      }
      const runTeam = runTeamOverride ?? (await import('@/lib/agents/build/agentic-graph-server')).runOsTeam;
      const team = await runTeam({ user, yaml: view.yaml, systemId, messages: msgs, disabledAgents: view.disabledAgents });
      return {
        systemId,
        mode: 'live',
        path: team.path,
        finalText: team.finalText,
        // Per-node summary: model + governed tool steps (no raw model text — tight).
        nodes: team.runs.map((r) => ({
          node: r.node,
          model: r.model,
          steps: r.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
        })),
      };
    },
  },
];

/** One turn's conversation: `messages` (validated, last 20) else the single `message`. */
function runMessages(args: Record<string, unknown>): { role: 'user' | 'assistant'; content: string }[] {
  const raw = Array.isArray(args.messages) ? (args.messages as { role?: string; content?: string }[]) : [];
  const clean = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: (m.content as string).trim() }));
  if (clean.length > 0) return clean;
  const message = str(args.message).trim();
  if (!message) fail('run_agent_system needs a `message` (or `messages`)', 400);
  return [{ role: 'user', content: message }];
}

/** The runOsTeam signature the tool drives (structural, so tests can inject a spy). */
type RunTeamFn = (input: {
  user: CurrentUser;
  yaml: string;
  systemId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  disabledAgents?: string[];
}) => Promise<{
  path: string[];
  finalText: string;
  runs: { node: string; model: string; result: { steps: { tool: string; isError: boolean }[] } }[];
}>;

// runOsTeam drives a LIVE LiteLLM call; tests inject a spy so the wrapper's
// identity threading + governance gates are testable offline (mirrors the
// injectable deps runOsTeam itself exposes). null → the real function.
let runTeamOverride: RunTeamFn | null = null;
export function __setRunOsTeamForTests(fn: RunTeamFn | null): void {
  runTeamOverride = fn;
}

