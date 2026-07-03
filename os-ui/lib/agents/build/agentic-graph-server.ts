/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import { listToolsForRole, toolsForTab } from '@/lib/mcp/server';
import { loadTabContext } from '@/lib/tabs/context';
import { tabToolExecutor, liteLlmCaller } from '@/lib/assistant/runtime';
import type { ToolSpec } from '@/lib/assistant/agentic';
import { parseSystem, type System } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { runAgenticGraph, type AgenticGraphResult } from './agentic-graph.ts';

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

function preamble(): string {
  return [
    OS_RULES,
    '',
    '--- SOFTWARE TAB CONTEXT (authoritative environment reference) ---',
    loadTabContext('software') || '(no tab context available)',
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

export type RunAgenticTeamInput = {
  user: CurrentUser;
  yaml: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  disabledAgents?: string[];
  maxIterations?: number;
};

/**
 * Run the whole team over one turn, live, as the signed-in user. Each node runs
 * the PLAN→ACT harness with its pinned model; every tool call goes through
 * `tabToolExecutor(user,'software')` → `handleRpc(user, …)` — the exact governed
 * dispatch the MCP route uses. The last node's narration is the user-facing reply.
 */
export async function runAgenticTeam(input: RunAgenticTeamInput): Promise<AgenticGraphResult> {
  const ir = compile(parseSystem(input.yaml));
  const specsFor = toolSpecsFactory(input.user);
  return runAgenticGraph(ir, input.messages, {
    llm: liteLlmCaller(),
    toolSpecsFor: (node) => specsFor(node.tools),
    callTool: tabToolExecutor(input.user, 'software'),
    preamble: preamble(),
    reasoningModel: config.litellmReasoningModel,
    execModel: config.litellmExecModel,
    maxIterations: input.maxIterations,
    disabled: input.disabledAgents,
  });
}
