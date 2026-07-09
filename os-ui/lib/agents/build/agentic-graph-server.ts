/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { roleModel } from '@/lib/models/roles';
import type { CurrentUser } from '@/lib/auth';
import { ALL_MCP_TOOLS, isMcpTab, listToolsForRole, toolsForTab, type McpTab } from '@/lib/mcp/server';
import { loadTabContext, tabTitle } from '@/lib/tabs/context';
import { tabToolExecutor, liteLlmCaller } from '@/lib/assistant/runtime';
import type { ToolSpec, AgenticStep, LlmCall } from '@/lib/assistant/agentic';
import { loadBuildSpec } from '@/lib/tabs/build-spec';
import { parseSystem, type System } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { runAgenticGraph, runNode, type AgenticGraphResult } from './agentic-graph.ts';
import {
  grantedToolSpecs,
  grantedToolExecutor,
  resolveGrantedTools,
  type OsToolDeps,
} from './os-tools.ts';
import {
  preRoute,
  postRoute,
  extractSignals,
  stripControlTags,
  phaseGuidance,
  getSession,
  saveSession,
  lastUserText,
  type Phase,
} from './phase-router.ts';

/**
 * SERVER WIRING for the agentic graph executor. Binds the pure walker
 * (`agentic-graph.ts`) to the SAME governed surface the live software build chat
 * uses — per-user MCP execution via `handleRpc`, the software tab context, and
 * the two LiteLLM tiers — so the Software Delivery Team genuinely builds and
 * requests deploys AS THE SIGNED-IN USER, with no embedded token and no system
 * principal.
 */

// The set of software-MCP tool names — the only surface a team may drive live.
const SOFTWARE_TOOL_NAMES = new Set(toolsForTab('software').map((t) => t.name));

/**
 * A LangGraph system is runnable by the in-process agentic executor iff it is a
 * `langgraph` system whose EVERY granted tool is a software-MCP tool. Anything
 * broader (data/knowledge/agents grants, or the hermes runtime) keeps the
 * existing `runSystem` path (Python runtime / offline mock).
 */
export function isAgenticSoftwareTeam(sys: System): boolean {
  if (sys.runtime !== 'langgraph') return false;
  if (sys.grants.tools.length === 0) return false;
  return sys.grants.tools.every((t) => SOFTWARE_TOOL_NAMES.has(t));
}

// The OS rules preamble every node is grounded in (mirrors the tab assistant's).
const OS_RULES = [
  'You are one agent in a governed Software Delivery Team inside the Sovereign',
  'Agentic OS — a sovereign platform where nothing leaves the tenant boundary.',
  '- Every tool call runs under YOUR delegated identity: OPA-authorized, role-gated',
  '  and Langfuse-audited. If a tool is denied, explain it plainly; do not retry blindly.',
  '- Deploy is a Builder-REVIEWED draft, never auto-live: request_deploy opens a review',
  '  gate; it does not go live until a human Builder approves it.',
  '- Consume granted resources by reference via the use_* tools, never a raw secret.',
  '- Prefer real action over description: use your tools to actually do the work.',
].join('\n');

export function preamble(): string {
  const spec = loadBuildSpec();
  return [
    OS_RULES,
    '',
    '--- SOFTWARE TAB CONTEXT (authoritative environment reference) ---',
    loadTabContext('software') || '(no tab context available)',
    ...(spec ? ['', '--- BUILD SPEC (canonical — the exact template, tool sequence, governance) ---', spec] : []),
  ].join('\n');
}

/** Role-scope the software tools once, then narrow per node to its tool list. */
function toolSpecsFactory(user: CurrentUser): (nodeTools: string[]) => ToolSpec[] {
  const byName = new Map(
    listToolsForRole(user.role, toolsForTab('software')).map((t) => [
      t.name,
      { name: t.name, description: t.description, inputSchema: t.inputSchema as ToolSpec['inputSchema'] },
    ]),
  );
  return (nodeTools) =>
    nodeTools.map((n) => byName.get(n)).filter((s): s is ToolSpec => s !== undefined);
}

// The OS-wide rules preamble for a GENERAL (any-tab) agentic-os team — tab-agnostic
// (the software team gets the richer, software-flavoured `OS_RULES`/`preamble()`).
const OS_TEAM_RULES = [
  'You are one agent in a governed team inside the Sovereign Agentic OS — a sovereign',
  'platform where nothing leaves the tenant boundary.',
  '- Every tool call runs under the RUNNING USER\'s delegated identity: OPA-authorized,',
  '  role-gated and Langfuse-audited. If a tool is denied or held for approval, explain',
  '  it plainly; do not retry blindly.',
  '- You may use ONLY the tools you are granted; consume granted resources by reference,',
  '  never a raw secret.',
  '- Prefer real action over description: use your tools to actually do the work.',
].join('\n');

/** The distinct OS tabs a system's granted MCP tools live under (for context grounding). */
function grantedTabs(sys: System): McpTab[] {
  const names = new Set(resolveGrantedTools(sys).mcpNames);
  const tabs = new Set<McpTab>();
  for (const t of ALL_MCP_TOOLS) {
    if (names.has(t.name) && isMcpTab(t.tab)) tabs.add(t.tab);
  }
  return [...tabs];
}

/**
 * The preamble for a general agentic-os team: OS rules + the CONTEXT.md for every
 * tab the system's grants touch (so a data+knowledge team is grounded in BOTH tabs'
 * environment references), and — only when software tools are granted — the build
 * spec. Mirrors `preamble()` but tab-agnostic.
 */
export function osPreamble(sys: System): string {
  const tabs = grantedTabs(sys);
  const parts = [OS_TEAM_RULES];
  for (const tab of tabs) {
    const ctx = loadTabContext(tab);
    if (ctx) parts.push('', `--- ${tabTitle(tab)} TAB CONTEXT (authoritative environment reference) ---`, ctx);
  }
  if (tabs.includes('software')) {
    const spec = loadBuildSpec();
    if (spec) parts.push('', '--- BUILD SPEC (canonical — the exact template, tool sequence, governance) ---', spec);
  }
  return parts.join('\n');
}

export type RunOsTeamInput = {
  user: CurrentUser;
  yaml: string;
  /** The system id — for the `os-<id>` OPA pre-gate + trace attribution. */
  systemId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  disabledAgents?: string[];
  maxIterations?: number;
  /** Injected in tests; defaults to the live LiteLLM caller. */
  llm?: LlmCall;
  /** Injected in tests; the governed executor deps (authorize/enqueue/handleRpc/trace). */
  toolDeps?: OsToolDeps;
};

/**
 * Run ANY agentic-os team (`isAgenticOsTeam`) over one turn, live, in-process, as
 * the RUNNING USER. Generalises the former `runAgenticTeam` (software-only) to the
 * whole governed OS MCP toolset: per node, the granted, role-scoped tool schemas
 * (`grantedToolSpecs`) go to LiteLLM, and every tool call is dispatched through
 * `grantedToolExecutor(user, sys, systemId)` → `handleRpc(user, …)` — the exact
 * governed door the external MCP server uses, under `user:<id>`, never a service
 * principal. Software-only teams are a strict subset, so their behaviour is
 * preserved. The last node's narration is the single user-facing reply.
 */
export async function runOsTeam(input: RunOsTeamInput): Promise<AgenticGraphResult> {
  const sys = parseSystem(input.yaml);
  const ir = compile(sys);
  return runAgenticGraph(ir, input.messages, {
    llm: input.llm ?? liteLlmCaller(),
    toolSpecsFor: (node) => grantedToolSpecs(input.user, sys, node.tools),
    callTool: grantedToolExecutor(input.user, sys, input.systemId, input.toolDeps),
    preamble: osPreamble(sys),
    reasoningModel: roleModel('reasoning'),
    // ACT/tool-calling fallback model (a per-agent pin still wins). The `tools`
    // role defaults to Qwen for clean OpenAI tool_calls; the harmony-format
    // light default mangles tool names. Admin-overridable.
    execModel: roleModel('tools'),
    maxIterations: input.maxIterations,
    disabled: input.disabledAgents,
  });
}

export type PhaseTurnResult = {
  /** The user-facing narration (control tags stripped). */
  reply: string;
  /** The phase the session is now in (after this turn advanced it). */
  phase: Phase;
  /** The role-agent that ran this turn. */
  role: string;
  /** The app id, once the builder has created it (persisted in the session). */
  appId: string | null;
  /** The governed tool steps this turn took (for the UI). */
  steps: { tool: string; isError: boolean }[];
};

export type RunPhaseTurnInput = {
  user: CurrentUser;
  yaml: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Streamed after each governed tool step so the UI shows live progress. */
  onStep?: (step: AgenticStep) => void;
};

/**
 * ONE TURN of the interactive builder: the phase router picks the single
 * role-agent to run (given the persisted session + the user's latest message),
 * runs it live as the signed-in user (~2-8 LLM calls, not ~42), advances the
 * phase from the run's signals, and persists the session (globalThis-pinned per
 * user). This is what the Software-tab Team panel drives — questions genuinely
 * gate building, and feedback loops as diff commits.
 */
export async function runPhaseTurn(input: RunPhaseTurnInput): Promise<PhaseTurnResult> {
  const key = input.user.id;
  const session = getSession(key);
  const { phase, role } = preRoute(session, lastUserText(input.messages));

  const ir = compile(parseSystem(input.yaml));
  const specsFor = toolSpecsFactory(input.user);
  const run = await runNode(
    ir,
    role,
    input.messages,
    {
      llm: liteLlmCaller(),
      toolSpecsFor: (node) => specsFor(node.tools),
      callTool: tabToolExecutor(input.user, 'software'),
      preamble: preamble(),
      reasoningModel: roleModel('reasoning'),
      // Tool-calling fallback model (per-agent pin still wins) — Qwen by default
      // for clean OpenAI tool_calls, not the harmony-format light model.
      execModel: roleModel('tools'),
    },
    { extraGuidance: phaseGuidance(phase, session.appId), onStep: input.onStep },
  );

  const signals = extractSignals(run.result);
  const nextPhase = postRoute(phase, signals);
  const appId = signals.appId ?? session.appId;
  saveSession(key, {
    phase: nextPhase,
    appId,
    planApproved: session.planApproved || phase === 'build',
    updatedAt: session.updatedAt,
  });

  return {
    reply: stripControlTags(run.result.finalText) || '(the team produced no narration)',
    phase: nextPhase,
    role,
    appId,
    steps: run.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
  };
}
