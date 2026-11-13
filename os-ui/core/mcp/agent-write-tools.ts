/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from '@core/mcp/write-common';

import { queryRun } from '@core/infra/governed';
import type { ExecuteIdentity } from '@core/infra/governed';
import { enqueue, getApproval, decide, listApprovals } from '@core/policy/approvals';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@core/policy/ladder';
import { pendingHandle } from '@core/mcp/pending';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@tabs/agents/lib/store';
import { newRunId } from '@core/kernel/run-id';
import { isTemplateKey } from '@tabs/agents/lib/templates';
import { buildSystem } from '@tabs/agents/lib/build/server';

import { normalizeContextGrants } from '@core/kernel/context-grants';
import { config } from '@core/kernel/config';

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
      'RUN an agent system (a real LangGraph StateGraph over your OS-MCP tool grants) for one turn and return the reply + the per-node governed tool steps — the SAME queue, engine and executor the Agents tab uses. Purpose: close the Agents golden path (build → RUN → approval → resume → trace) over MCP. Before: list_agent_systems / get_agent_system (and build_agent_system for a ✓ build). After: get_agent_run(runId) to follow it, decide_approval if it parks, resume_agent_run after a restart, get_run_trace(runId) for the trace. Returns `runId` (= the LangGraph thread id AND the Langfuse trace id) and `traceUrl`. Governance + recursion, stated honestly: the team’s OWN tool calls dispatch through the SAME governed door as this call (grant-scoped, OPA `os-<systemId>` pre-gated, then handleRpc AS YOU) — so a team can never exceed its declared grants NOR your role; there is no escalation in the loop. You must own the system or be entitled to run it (a domain-Shared system is runnable by in-domain members); a non-runnable id is a typed forbidden. A grant naming a tool with no governed MCP tool behind it is a typed bad_request that names the tool. A run that hits a write needing approval PARKS (`parked: true` + `heldApprovals`) instead of executing it. Note: the run drives a live LLM; each node takes seconds, and in worker mode it may return `queued: true` with the runId to follow.',
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
      // PRE-FLIGHT (A5): the one engine runs every system; the only definition bug that stops a
      // run is a grant naming a tool with no governed MCP tool behind it. Name them.
      // Dynamic import: os-tools reads the tool registry at module init, so a static import here
      // would be a server.ts ↔ write-tools.ts cycle.
      const { unmappedGrantNames } = await import('@tabs/agents/lib/build/os-tools');
      const unmapped = unmappedGrantNames(view.system);
      if (unmapped.length > 0) {
        fail(
          `This system grants tool(s) with no governed MCP tool behind them: ${unmapped.join(', ')}. ` +
            'Fix the grants with commit_agent_files (system.yaml), then run again.',
          400,
        );
      }
      // Thread id = run id, returned so an MCP client can correlate (and resume) the run.
      const runId = newRunId();
      // A4: the MCP goes through the SAME queue as the UI and the scheduler — one start door.
      const startRun = startQueuedRunOverride ?? (await import('@tabs/agents/lib/build/run-jobs-server')).startQueuedRun;
      const out = await startRun({ user, systemId, domain: view.system.system.domain, messages: msgs, runId });
      if (out.error) fail(out.error.message, out.error.status ?? 500);
      if (!out.body) return { systemId, mode: 'live', engine: 'langgraph', runId, queued: true, note: 'filed on the run queue — tail it with get_agent_run' };
      const b = out.body;
      return {
        systemId,
        mode: 'live',
        engine: 'langgraph',
        runId: b.runId ?? runId,
        checkpointer: b.checkpointer,
        // A3: the deep link to THIS run's Langfuse trace (id = run id), when the trace store recorded it.
        traceUrl: b.traceUrl,
        reachedEnd: b.reachedEnd,
        // A2: a run PARKED on a held write — decide its approvals (decide_approval) to resume it.
        parked: b.parked,
        heldApprovals: b.heldApprovals ?? [],
        path: b.path,
        finalText: b.finalText,
        // Per-node summary: model + governed tool steps (no raw model text — tight).
        nodes: b.nodes.map((r) => ({ node: r.node, model: r.model, steps: r.steps.map((x) => ({ tool: x.tool, isError: x.isError })) })),
      };
    },
  },
  {
    name: 'resume_agent_run',
    tab: 'agents',
    minRole: 'creator',
    description:
      'RESUME an interrupted agent run (LangGraph engine) from its last checkpoint — restart recovery after a pod restart or a dropped request. NOT for a run parked on an approval: that one resumes by itself when the approval is decided (decide_approval). Governance: only the RUNNER can resume their run (typed not_found otherwise); a finished run is a typed conflict; the resumed run executes AS YOU through the same governed door. Returns the completed report (or the next parked state).',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'The run id to continue.' } },
      required: ['runId'],
      examples: [{ runId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427' }],
    },
    call: async (user, args) => {
      const runId = str(args.runId).trim();
      if (!runId) fail('resume_agent_run needs a `runId`', 400);
      // A4-review-H-1: the SAME visibility gate the run route and the re-attach stream use — the
      // checkpoint's owner AND the `run_jobs` row must both be this caller's, both answering 404.
      const { assertRunVisible } = await import('@tabs/agents/lib/engine/run-visibility');
      const { peekRunOwner } = await import('@tabs/agents/lib/build/agentic-graph-server');
      const owner = await peekRunOwner(runId);
      const seen = assertRunVisible(owner ? { requestedBy: owner.userId, systemId: owner.systemId } : null, runId, user.id);
      const view = getSystemForRun(seen.systemId, P(user));
      // A4: a resume is a `run_jobs` row too — the same queue the decision hook and the UI use.
      const { resumeQueuedRun, runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');
      assertRunVisible(await (await runJobStore()).get(runId), runId, user.id, seen.systemId);
      const out = await resumeQueuedRun({ user, systemId: seen.systemId, domain: view.system.system.domain, runId });
      if (out.error) fail(out.error.message, out.error.status ?? 500);
      if (!out.body) return { runId, systemId: seen.systemId, engine: 'langgraph', queued: true, note: 'the resume is filed — the worker is executing it' };
      const body = out.body;
      return {
        runId,
        systemId: seen.systemId,
        engine: 'langgraph',
        traceUrl: body.traceUrl,
        reachedEnd: body.reachedEnd,
        parked: body.parked,
        heldApprovals: body.heldApprovals,
        path: body.path,
        finalText: body.finalText,
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

/**
 * The `startQueuedRun` signature the tool drives (structural, so tests can inject a spy).
 * A5 replaced the old `RunTeamFn` seam: there is one start door now, and it is this one.
 */
type StartRunFn = (input: {
  user: CurrentUser;
  systemId: string;
  domain: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  prompt?: string;
  runId: string;
}) => Promise<{
  runId: string;
  body?: {
    runId?: string;
    checkpointer?: 'postgres' | 'memory';
    traceUrl?: string;
    reachedEnd: boolean;
    parked?: boolean;
    heldApprovals?: { approvalId: string; tool: string; node: string }[];
    path: string[];
    finalText: string;
    nodes: { node: string; model: string; steps: { tool: string; isError: boolean }[] }[];
  };
  error?: { message: string; status?: number };
}>;

// A real start files a `run_jobs` row and drives a LIVE LiteLLM call; tests inject a spy so the
// wrapper's identity threading + governance gates are testable offline. null → the real function.
let startQueuedRunOverride: StartRunFn | null = null;
export function __setStartQueuedRunForTests(fn: StartRunFn | null): void {
  startQueuedRunOverride = fn;
}
