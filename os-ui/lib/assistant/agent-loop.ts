/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import {
  handleRpc,
  ALL_MCP_TOOLS,
  toolsForTab,
  listToolsForRole,
  isMcpTab,
  type McpTab,
} from '@/lib/mcp/server';
import { loadTabContext, tabTitle } from '@/lib/tabs/context';
import { buildInstructions } from '@/lib/mcp/instructions';
import { runAgentic, type AgenticResult, type LlmCall, type ToolExecutor, type ToolSpec } from './agentic.ts';
import { liteLlmCaller } from './runtime.ts';
import { resolveAssistantModelId } from './complete.ts';

/**
 * THE ONE OVERARCHING SOVEREIGN OS ASSISTANT (server wiring).
 *
 * A single, globally-available assistant that is present on every tab. It is
 * CONTEXT-AWARE of the tab the user is on (its CONTEXT.md is injected and its
 * tools are surfaced first) while carrying OVERARCHING OS context — it can reach
 * EVERY governed MCP tool across every tab.
 *
 * It is an MCP CLIENT of the OS's OWN MCP server: it gets all information and
 * triggers all actions through the EXACT SAME governed dispatch (`handleRpc`)
 * that external clients (Claude Desktop) use, under the signed-in user's
 * delegated identity. So it inherits identical guardrails — role floor,
 * approvals, OPA/RLS, Langfuse audit. There is NO ungoverned side-channel.
 *
 * It reuses the pure PLAN→ACT harness (`agentic.ts`) and the governed LiteLLM
 * caller (`runtime.ts`), and runs on the ONE assistant model
 * (`resolveAssistantModelId()` → `sovereign-default`).
 */

/**
 * Route → MCP tab. The app's nav hrefs don't all match the MCP tab ids (Files
 * lives at `/unstructured`; Big Bets at `/big-bets`), so map explicitly. Routes
 * with no governed tool surface (Home, Cockpit, Settings, Admin…) return null —
 * the assistant is still fully available, just without a tab lens.
 */
const PATH_TAB: Record<string, McpTab> = {
  data: 'data',
  science: 'science',
  knowledge: 'knowledge',
  agents: 'agents',
  software: 'software',
  unstructured: 'files',
  metrics: 'metrics',
  dashboards: 'dashboards',
  'big-bets': 'bigbets',
  connections: 'connections',
  governance: 'governance',
  marketplace: 'marketplace',
  strategy: 'strategy',
  monitoring: 'monitoring',
};

/** Resolve the current MCP tab from a browser pathname, or null (no tab lens). */
export function mcpTabForPath(path: string | null | undefined): McpTab | null {
  if (!path) return null;
  const seg = path.replace(/^\/+/, '').split('/')[0] ?? '';
  const tab = PATH_TAB[seg];
  if (tab && isMcpTab(tab)) return tab;
  return null;
}

// OS-wide grounding every turn is anchored in. Short, honest, governance-first.
const OS_RULES = [
  'You are the Sovereign OS Assistant — the single, overarching assistant of the',
  'Sovereign Agentic OS, a governed, in-tenant platform where nothing leaves the',
  'tenant boundary. You are present on every tab and help with whatever the user',
  'is doing there, while understanding the whole OS.',
  '',
  'HOW YOU ACT (non-negotiable): you get all information and take all actions by',
  "calling the OS's own governed MCP tools. Every tool call runs under the user's",
  'delegated identity through the SAME governed dispatch external MCP clients use —',
  'OPA-authorized, role-gated, approval-gated and Langfuse-audited. You have no',
  'privileged side-channel.',
  '',
  'ROLES (4 ranks): creator < builder < domain admin < admin. Creators build in',
  'their own domain; promoting/publishing a shared asset is Builder+; certifying to',
  'the marketplace is Admin. Deploy is a Builder-REVIEWED draft (request_deploy',
  'opens a review gate) — never auto-live.',
  '',
  'BE HONEST: if a tool is blocked by governance (role or approval), say so plainly',
  '— name the role required — and do NOT pretend you performed the action. Prefer',
  'real tool calls over description. Start from `whoami` / `list_capabilities` when',
  'you are unsure what you can do.',
  '',
  'BEFORE YOU BUILD OR CHANGE ANYTHING (clarify → plan → confirm):',
  '• Read-only / informational requests (list, show, profile, query, explain): just',
  '  answer — use the read tools freely, no confirmation needed. Stay snappy.',
  '• For any request that CREATES, BUILDS, TRANSFORMS, PROMOTES, PUBLISHES, DELETES,',
  '  DEPLOYS or otherwise CHANGES state:',
  '   1. If the request is ambiguous or under-specified, ASK 1–3 concise clarifying',
  '      questions FIRST — never guess the user into building the wrong thing. You',
  '      MAY call read-only tools (whoami, list_*, get_*, profile_*) to ground your',
  '      questions, but do NOT call any mutating tool yet.',
  '   2. Once it is clear, OUTLINE a short plan — the steps, the artifacts/tools',
  '      involved, and the end result — in a few plain-language bullets, then ASK the',
  '      user to confirm (e.g. "Shall I go ahead?").',
  '   3. Only AFTER the user confirms do you execute the plan with the mutating tools.',
  '   4. Keep it lightweight: one obvious, low-risk step needs only a one-line',
  '      heads-up, not a ceremony. Bigger or irreversible work gets the full plan.',
].join('\n');

/** The system prompt: OS overview + current-tab context + governance note. */
export function osAssistantSystem(tab: McpTab | null): string {
  const parts = [OS_RULES, '', '--- OS ORIENTATION ---', buildInstructions()];
  if (tab) {
    parts.push(
      '',
      `--- CURRENT TAB: ${tabTitle(tab)} (the user is on this tab right now) ---`,
      'Help with this tab first; its tools are listed before the rest. You may still',
      'reach any other governed tool across the OS when the task calls for it.',
      loadTabContext(tab) || '(no tab context available)',
    );
  } else {
    parts.push(
      '',
      '--- CURRENT TAB: none (an overview page) ---',
      'No single tab is in focus; help across the whole OS using any governed tool.',
    );
  }
  return parts.join('\n');
}

/**
 * Every governed tool the caller may use, role-scoped, with the current tab's
 * tools ordered FIRST so the model reaches for them preferentially — but the full
 * registry is present, so the assistant can act on any tab.
 */
export function osToolSpecs(user: CurrentUser, tab: McpTab | null): ToolSpec[] {
  const all = listToolsForRole(user.role, ALL_MCP_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as ToolSpec['inputSchema'],
  }));
  if (!tab) return all;
  const tabNames = new Set(toolsForTab(tab).map((t) => t.name));
  const first = all.filter((t) => tabNames.has(t.name));
  const rest = all.filter((t) => !tabNames.has(t.name));
  return [...first, ...rest];
}

/**
 * A governed tool executor: dispatch through the SAME `handleRpc` the MCP HTTP
 * route uses, over the FULL registry (no per-tab scoping — the assistant is
 * overarching). handleRpc re-checks the role floor and the underlying governed
 * function (OPA + Langfuse) is the real authority, so this never bypasses
 * governance. A denial comes back as an honest `isError` result, not a throw.
 */
export function osToolExecutor(user: CurrentUser): ToolExecutor {
  return async (name, args) => {
    const res = await handleRpc(user, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res?.error) return { text: `Error: ${res.error.message}`, isError: true };
    const result = (res?.result ?? {}) as { content?: { text?: string }[]; isError?: boolean };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    return { text: text || '(no output)', isError: !!result.isError };
  };
}

export type RunOsAssistantInput = {
  user: CurrentUser;
  /** The tab the user is currently on, or null (overview page / no tool surface). */
  tab: McpTab | null;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxIterations?: number;
  /** Injected in tests; defaults to the live governed LiteLLM caller. */
  llm?: LlmCall;
};

export type OsAssistantResult = AgenticResult & { tab: McpTab | null };

/**
 * Run one PLAN→ACT turn for the overarching OS assistant and return the full
 * trace (plan, every governed tool call, final answer). Production runs on the
 * ONE assistant model; a missing model throws the honest AssistantNotConfigured
 * error via `resolveAssistantModelId()`.
 */
export async function runOsAssistant(input: RunOsAssistantInput): Promise<OsAssistantResult> {
  const injected = input.llm;
  // Production: the ONE assistant model for both plan + act. Tests inject `llm`
  // and own model selection, so the config tier ids are opaque placeholders.
  const assistantId = injected ? config.litellmExecModel : resolveAssistantModelId();
  const result = await runAgentic({
    system: osAssistantSystem(input.tab),
    userMessages: input.messages,
    tools: osToolSpecs(input.user, input.tab),
    callTool: osToolExecutor(input.user),
    llm: injected ?? liteLlmCaller(),
    planModel: injected ? config.litellmReasoningModel : assistantId,
    actModel: assistantId,
    maxIterations: input.maxIterations ?? config.assistantMaxSteps,
  });
  return { ...result, tab: input.tab };
}
