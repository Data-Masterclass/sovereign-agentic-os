/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Capability, type System, parseSystem, serializeSystem } from '../system-schema.ts';
import {
  type RoutingTable,
  ACTIVITIES,
  defaultRoutingTable,
  resolveModel,
  routeProbe,
} from '../routing.ts';
import { type Decision } from '../gateway.ts';
import { type BuildAdapter, type StepResult } from './adapter.ts';
import {
  type ReloadRequest,
  type ReloadResponse,
  type RunRequest,
  type RunResponse,
  principalFor,
  reloadRequest,
  runRequest,
} from './runtime-contract.ts';

/**
 * The 5 LIVE Build adapters (Approach A) — the real apply→verify against the
 * services, replacing {@link makeMockAdapters}. They share the SAME
 * {@link BuildAdapter} interface, the same run order (forgejo → opa → litellm →
 * langgraph → langfuse) and the same cardinal rule (a row is ✓ ONLY when both
 * apply AND verify pass). Every backend is injected as a small client interface so
 * this module stays PURE and unit-testable against in-memory fakes; the real
 * fetch-backed clients live in `live-clients.ts` (server-only).
 *
 *   • forgejo  — write system.yaml + agents/<id>/AGENT.md + MEMORY.md (sha-checked);
 *                verify reads back + parseSystem round-trips.
 *   • opa      — PUT grants for principal os-<id> (+ connection_<id>; Write-approval
 *                merged into requires_approval); verify probes allow/deny/approval.
 *   • litellm  — idempotent /key/generate (alias os-<id>, routed models, budget +
 *                per-model caps, rpm/tpm); verify /key/info + routing resolves
 *                light→Ministral, reasoning→Qwen.
 *   • langgraph— compile()→IR→runtime /reload; verify runtime /run reaches END with
 *                every tool call governed and no granted tool denied.
 *   • langfuse — ensure the project; verify a trace landed for the test invocation.
 */

// ----------------------------------------------------------------- clients -------

export interface ForgejoClient {
  ensureRepo(repo: string): Promise<void>;
  readFile(repo: string, path: string): Promise<{ content: string; sha: string } | null>;
  writeFile(repo: string, path: string, content: string, sha?: string): Promise<{ sha: string }>;
}

export interface OpaClient {
  /** PUT the principal's allowed tools (in-memory data document). */
  putGrants(principal: string, tools: string[]): Promise<void>;
  /** Merge tool names into the global requires_approval list (held writes). */
  mergeRequiresApproval(tools: string[]): Promise<void>;
  decision(principal: string, tool: string): Promise<Decision>;
}

export type LiteLlmKeyInput = {
  alias: string;
  models: string[];
  maxBudget: number;
  modelMaxBudget: Record<string, number>;
  rpmLimit: number;
  tpmLimit: number;
  allowedTools: string[];
};

export interface LiteLlmClient {
  keyInfo(alias: string): Promise<{ models: string[]; maxBudget?: number } | null>;
  generateKey(input: LiteLlmKeyInput): Promise<{ key: string }>;
  models(): Promise<string[]>;
}

export interface RuntimeClient {
  reload(req: ReloadRequest): Promise<ReloadResponse>;
  run(req: RunRequest): Promise<RunResponse>;
}

export interface LangfuseClient {
  ensureProject(name: string): Promise<void>;
  /** How many traces have landed for the system principal (os-<id>). */
  tracesFor(principal: string): Promise<number>;
}

/** Per-key cost + rate caps (chart `litellmAgentKey` defaults). */
export type KeyCaps = {
  maxBudget: number;
  modelMaxBudget: Record<string, number>;
  rpmLimit: number;
  tpmLimit: number;
};

export const DEFAULT_KEY_CAPS: KeyCaps = {
  maxBudget: 5,
  modelMaxBudget: {},
  rpmLimit: 120,
  tpmLimit: 200_000,
};

export type LiveDeps = {
  forgejo: ForgejoClient;
  opa: OpaClient;
  litellm: LiteLlmClient;
  runtime: RuntimeClient;
  langfuse: LangfuseClient;
  caps?: KeyCaps;
};

// ------------------------------------------------------------------ helpers ------

const enabled = (c: Capability) => c === 'Read' || c === 'Write-approval' || c === 'Write-bounded';

/** A system's routing table = the defaults with its activity→model overrides applied. */
function routingTableFor(sys: System): RoutingTable {
  const table = defaultRoutingTable();
  for (const [activity, model] of Object.entries(sys.routing.overrides)) {
    const a = activity as keyof RoutingTable;
    if (table[a]) table[a] = { tier: table[a].tier, model };
  }
  return table;
}

/** Distinct LiteLLM model_names a system can route to (tier defaults + per-agent). */
function routedModels(sys: System, table: RoutingTable): string[] {
  const set = new Set<string>();
  for (const a of ACTIVITIES) set.add(table[a].model);
  for (const ag of sys.agents) if (ag.model) set.add(ag.model);
  return [...set];
}

/**
 * The tool vocabulary granted to a system's principal in OPA / LiteLLM: the RAW
 * grant names (kept so the runtime's raw-IR tool calls stay authorized) UNIONED
 * with their RESOLVED MCP registry names (so a legacy `retrieve` grant ALSO
 * authorizes `search_knowledge`, matching the sanctioned MCP vocabulary the Run
 * path resolves to), plus the enabled connection tools. Resolved via a dynamic
 * import so this module has no eager dependency on the (heavier) os-tools chain.
 */
async function grantVocabulary(sys: System, connections: string[]): Promise<string[]> {
  const { resolveGrantedTools } = await import('./os-tools.ts');
  const resolved = resolveGrantedTools(sys).mcpNames;
  return [...new Set([...sys.grants.tools, ...resolved, ...connections])];
}

/** connection_<id> tool names for enabled connections; and the write-held subset. */
function connectionTools(sys: System): { all: string[]; held: string[] } {
  const all: string[] = [];
  const held: string[] = [];
  for (const c of sys.grants.connections) {
    if (!enabled(c.capability)) continue;
    const tool = `connection_${c.id}`;
    all.push(tool);
    if (c.capability === 'Write-approval') held.push(tool);
  }
  return { all, held };
}

function ok(detail: string): StepResult {
  return { ok: true, detail };
}
function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}

// ----------------------------------------------------------------- adapters ------

export function makeLiveAdapters(deps: LiveDeps): BuildAdapter[] {
  const caps = deps.caps ?? DEFAULT_KEY_CAPS;

  const forgejo: BuildAdapter = {
    tool: 'forgejo',
    async apply(ctx) {
      const sys = ctx.system;
      const repo = `os-${ctx.systemId ?? 'sys'}`;
      await deps.forgejo.ensureRepo(repo);
      const put = async (path: string, content: string) => {
        const cur = await deps.forgejo.readFile(repo, path);
        await deps.forgejo.writeFile(repo, path, content, cur?.sha);
      };
      await put('system.yaml', serializeSystem(sys));
      for (const a of sys.agents) {
        await put(`agents/${a.id}/AGENT.md`, a.agent_md ?? '');
        await put(`agents/${a.id}/MEMORY.md`, a.memory_md ?? '');
      }
      return ok(`wrote system.yaml + ${sys.agents.length * 2} agent file(s) to ${repo}`);
    },
    async verify(ctx) {
      const repo = `os-${ctx.systemId ?? 'sys'}`;
      const f = await deps.forgejo.readFile(repo, 'system.yaml');
      if (!f) return fail('system.yaml is not in the repo');
      try {
        const reparsed = parseSystem(f.content);
        if (reparsed.agents.length !== ctx.system.agents.length) return fail('round-trip lost agents');
        for (const a of ctx.system.agents) {
          if (!(await deps.forgejo.readFile(repo, `agents/${a.id}/AGENT.md`))) {
            return fail(`AGENT.md missing for ${a.id}`);
          }
        }
        return ok('files present + parseSystem round-trips');
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  };

  const opa: BuildAdapter = {
    tool: 'opa',
    async apply(ctx) {
      const principal = principalFor(ctx.systemId ?? 'sys');
      const { all, held } = connectionTools(ctx.system);
      const tools = await grantVocabulary(ctx.system, all);
      await deps.opa.putGrants(principal, tools);
      if (held.length > 0) await deps.opa.mergeRequiresApproval(held);
      return ok(`granted ${tools.length} tool(s) to ${principal}${held.length ? `; ${held.length} held for approval` : ''}`);
    },
    async verify(ctx) {
      const principal = principalFor(ctx.systemId ?? 'sys');
      const { all, held } = connectionTools(ctx.system);
      const grantedTool = ctx.system.grants.tools[0] ?? all[0];
      const probes: string[] = [];
      if (grantedTool) {
        const d = await deps.opa.decision(principal, grantedTool);
        if (d.effect !== 'allow') return fail(`granted tool ${grantedTool} did not resolve (${d.effect})`);
        probes.push(`granted '${grantedTool}' → allow`);
      }
      const d2 = await deps.opa.decision(principal, 'connection_ghost');
      if (d2.effect === 'allow') return fail('a non-granted tool was not blocked');
      probes.push(`non-granted → ${d2.effect}`);
      if (held[0]) {
        const d3 = await deps.opa.decision(principal, held[0]);
        if (d3.effect !== 'requires_approval') return fail(`write tool ${held[0]} not held (${d3.effect})`);
        probes.push(`write '${held[0]}' → requires_approval`);
      }
      return ok(probes.join('; '));
    },
  };

  const litellm: BuildAdapter = {
    tool: 'litellm',
    async apply(ctx) {
      const alias = principalFor(ctx.systemId ?? 'sys');
      const existing = await deps.litellm.keyInfo(alias);
      if (existing) return ok(`key '${alias}' already provisioned (idempotent)`);
      const table = routingTableFor(ctx.system);
      const models = routedModels(ctx.system, table);
      // Per-model hard cost cap for the pay-per-token STACKIT (qwen) routes only.
      const modelMaxBudget: Record<string, number> = { ...caps.modelMaxBudget };
      for (const m of models) {
        if (/stackit|qwen/i.test(m) && modelMaxBudget[m] === undefined) modelMaxBudget[m] = 2;
      }
      const { all } = connectionTools(ctx.system);
      await deps.litellm.generateKey({
        alias,
        models,
        maxBudget: caps.maxBudget,
        modelMaxBudget,
        rpmLimit: caps.rpmLimit,
        tpmLimit: caps.tpmLimit,
        allowedTools: await grantVocabulary(ctx.system, all),
      });
      return ok(`registered scoped key '${alias}' (${models.length} model(s), budget ${caps.maxBudget})`);
    },
    async verify(ctx) {
      const alias = principalFor(ctx.systemId ?? 'sys');
      const info = await deps.litellm.keyInfo(alias);
      if (!info) return fail(`key '${alias}' not found via /key/info`);
      const table = routingTableFor(ctx.system);
      const light = routeProbe('coding', table);
      const reason = routeProbe('planning', table);
      if (light.tier !== 'light') return fail(`light activity routed to ${light.tier}`);
      if (reason.tier !== 'reasoning') return fail(`reasoning activity routed to ${reason.tier}`);
      const models = ctx.system.agents.map((a) => `${a.id}=${resolveModel('tool-selection', table, a.model)}`);
      return ok(`light→${light.model}; reasoning→${reason.model}; agents: ${models.join(', ')}`);
    },
  };

  const langgraph: BuildAdapter = {
    tool: 'langgraph',
    async apply(ctx) {
      const res = await deps.runtime.reload(reloadRequest(ctx.systemId ?? 'sys', ctx.ir));
      if (!res.ok) return fail(res.error ?? 'runtime /reload failed');
      if (res.nodes !== ctx.ir.nodes.length) {
        return fail(`runtime reloaded ${res.nodes} node(s), expected ${ctx.ir.nodes.length}`);
      }
      return ok(`graph reloaded — ${res.nodes} node(s), entrypoint '${res.entrypoint}'`);
    },
    async verify(ctx) {
      const res = await deps.runtime.run(runRequest(ctx.systemId ?? 'sys', ctx.probe ?? 'Build verification'));
      if (res.error) return fail(res.error);
      if (!res.reachedEnd) return fail('test invocation did not reach END');
      const denied = res.steps.filter((s) => s.effect === 'deny').map((s) => s.tool);
      if (denied.length > 0) return fail(`granted tool(s) blocked during the run: ${denied.join(', ')}`);
      return ok(`test invocation ran ${res.path.join(' → ')} (${res.steps.length} governed tool call(s))`);
    },
  };

  const langfuse: BuildAdapter = {
    tool: 'langfuse',
    async apply(ctx) {
      const project = `os-${ctx.systemId ?? 'sys'}`;
      await deps.langfuse.ensureProject(project);
      return ok(`ensured Langfuse project ${project}`);
    },
    async verify(ctx) {
      const principal = principalFor(ctx.systemId ?? 'sys');
      const n = await deps.langfuse.tracesFor(principal);
      if (n <= 0) return fail('no trace appeared for the test invocation');
      return ok(`${n} trace(s) landed for the test invocation`);
    },
  };

  return [forgejo, opa, litellm, langgraph, langfuse];
}
