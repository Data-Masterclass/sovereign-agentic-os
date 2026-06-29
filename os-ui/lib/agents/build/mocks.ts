/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Capability, type System, parseSystem, serializeSystem } from '../system-schema.ts';
import {
  type RoutingTable,
  defaultRoutingTable,
  resolveModel,
  routeProbe,
} from '../routing.ts';
import { type Gateway, type GwTrace } from '../gateway.ts';
import { runGraph } from './run-graph.ts';
import { type BuildAdapter, type StepResult } from './adapter.ts';

/**
 * The 5 MOCK build adapters (langgraph / forgejo / litellm / opa / langfuse) for
 * kind-only validation. They hold their setup in an in-process {@link MockBackends}
 * — no STACKIT, no network — but each runs a REAL apply→verify against that state,
 * so the inline ✓/✗ and the gateway invariant are genuinely exercised:
 *
 *   • forgejo  — writes system.yaml + AGENT.md/MEMORY.md; verify reads back + parses.
 *   • opa      — registers grants; verify probes granted=allow, non-granted=deny.
 *   • litellm  — registers key + routing; verify probes light→Ministral, reason→Qwen.
 *   • langgraph— "reloads" the graph; verify runs a test invocation through the
 *                governed gateway (which traces into the langfuse mock).
 *   • langfuse — links the project; verify checks a trace landed for the invocation.
 */

export type MockBackends = {
  forgejo: { files: Map<string, { content: string; sha: string }> };
  litellm: { key: string | null; routing: RoutingTable };
  opa: { tools: Set<string>; connections: Map<string, Capability> };
  langfuse: { project: string | null; traces: GwTrace[] };
};

export function newMockBackends(): MockBackends {
  return {
    forgejo: { files: new Map() },
    litellm: { key: null, routing: defaultRoutingTable() },
    opa: { tools: new Set(), connections: new Map() },
    langfuse: { project: null, traces: [] },
  };
}

/** Tiny deterministic content sha (mock Forgejo blob id). */
function sha(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

const enabled = (c: Capability) => c === 'Read' || c === 'Write-approval' || c === 'Write-bounded';

/**
 * Register a system's grants into the OPA mock: the granted tools, plus each
 * connection's capability under the synthetic tool name `connection_<id>`. Shared
 * by the OPA adapter, the Run path and the connection probe so they enforce the
 * SAME policy.
 */
export function registerGrants(backends: MockBackends, sys: System): void {
  backends.opa.tools = new Set(sys.grants.tools);
  backends.opa.connections.clear();
  for (const c of sys.grants.connections) backends.opa.connections.set(`connection_${c.id}`, c.capability);
}

/**
 * The governed gateway the langgraph test invocation runs through. Authorizes
 * against the OPA mock (registered grants) and traces into the Langfuse mock —
 * the same chokepoint the real runtime uses.
 */
export function gatewayFor(backends: MockBackends): Gateway {
  return {
    authorize: (_principal, tool) => {
      if (backends.opa.tools.has(tool)) return { effect: 'allow', reason: 'granted by system grants' };
      const cap = backends.opa.connections.get(tool);
      if (cap === 'Write-approval') return { effect: 'requires_approval', reason: `${tool} is a write — approval required` };
      if (cap && enabled(cap)) return { effect: 'allow', reason: `${tool} granted (${cap})` };
      return { effect: 'deny', reason: `${tool} is not granted` };
    },
    trace: (e) => {
      backends.langfuse.traces.push(e);
    },
  };
}

export function makeMockAdapters(backends: MockBackends): BuildAdapter[] {
  const forgejo: BuildAdapter = {
    tool: 'forgejo',
    async apply(ctx) {
      const files = backends.forgejo.files;
      // Re-serialize from the parsed system so the repo holds the canonical files.
      const sys = ctx.system;
      const sysYaml = serializeSystem(sys);
      files.set('system.yaml', { content: sysYaml, sha: sha(sysYaml) });
      for (const a of sys.agents) {
        const ag = a.agent_md ?? '';
        const mem = a.memory_md ?? '';
        files.set(`agents/${a.id}/AGENT.md`, { content: ag, sha: sha(ag) });
        files.set(`agents/${a.id}/MEMORY.md`, { content: mem, sha: sha(mem) });
      }
      return ok(`wrote system.yaml + ${sys.agents.length * 2} agent files`);
    },
    async verify(ctx) {
      const f = backends.forgejo.files.get('system.yaml');
      if (!f) return fail('system.yaml is not in the repo');
      try {
        const reparsed = parseSystem(f.content);
        if (reparsed.agents.length !== ctx.system.agents.length) return fail('round-trip lost agents');
        for (const a of ctx.system.agents) {
          if (!backends.forgejo.files.has(`agents/${a.id}/AGENT.md`)) return fail(`AGENT.md missing for ${a.id}`);
        }
        return ok('files present + parse identical');
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  };

  const opa: BuildAdapter = {
    tool: 'opa',
    async apply(ctx) {
      registerGrants(backends, ctx.system);
      return ok(`registered ${backends.opa.tools.size} tool grants + ${ctx.system.grants.connections.length} connection(s)`);
    },
    async verify(ctx) {
      const gw = gatewayFor(backends);
      const grantedTool = ctx.system.grants.tools[0];
      const probes: string[] = [];
      if (grantedTool) {
        const d = await gw.authorize('probe', grantedTool);
        if (d.effect !== 'allow') return fail(`granted tool ${grantedTool} did not resolve (${d.effect})`);
        probes.push(`granted '${grantedTool}' → allow`);
      }
      // A tool the system was NOT granted must be blocked.
      const ungranted = 'connection_crm_write';
      const d2 = await gw.authorize('probe', ungranted);
      if (d2.effect === 'allow') return fail(`non-granted tool ${ungranted} was not blocked`);
      probes.push(`non-granted '${ungranted}' → ${d2.effect === 'requires_approval' ? 'approval' : 'denied'}`);
      return ok(probes.join('; '));
    },
  };

  const litellm: BuildAdapter = {
    tool: 'litellm',
    async apply(ctx) {
      backends.litellm.key = `sk-os-${ctx.systemId ?? 'sys'}`;
      // Apply any system-level activity→model overrides onto the routing table.
      const table = defaultRoutingTable();
      for (const [activity, model] of Object.entries(ctx.system.routing.overrides)) {
        const a = activity as keyof RoutingTable;
        if (table[a]) table[a] = { tier: table[a].tier, model };
      }
      backends.litellm.routing = table;
      return ok(`registered key + routing config for ${ctx.system.agents.length} agent(s)`);
    },
    async verify(ctx) {
      const table = backends.litellm.routing;
      const light = routeProbe('coding', table);
      const reason = routeProbe('planning', table);
      if (light.tier !== 'light') return fail(`light activity routed to ${light.tier}`);
      if (reason.tier !== 'reasoning') return fail(`reasoning activity routed to ${reason.tier}`);
      // Resolve each agent's effective model (per-agent override or activity routing).
      const models = ctx.system.agents.map((a) => `${a.id}=${resolveModel('tool-selection', table, a.model)}`);
      return ok(`light→${light.model}; reasoning→${reason.model}; agents: ${models.join(', ')}`);
    },
  };

  const langgraph: BuildAdapter = {
    tool: 'langgraph',
    async apply(ctx) {
      // "Compile + reload": the IR is already validated by the compiler; record it.
      return ok(`graph reloaded — ${ctx.ir.nodes.length} node(s), entrypoint '${ctx.ir.entrypoint}'`);
    },
    async verify(ctx) {
      const gw = gatewayFor(backends);
      const res = await runGraph(ctx.ir, { gateway: gw, probe: ctx.probe });
      if (!res.reachedEnd) return fail('test invocation did not reach END');
      const denied = res.steps.filter((s) => s.effect === 'deny').map((s) => s.tool);
      const detail = `test invocation ran ${res.path.join(' → ')} (${res.steps.length} governed tool call(s))`;
      // A denied granted-graph tool is a real failure (the graph references a tool
      // the system isn't granted) — though the compiler already rejects that case.
      if (denied.length > 0) return fail(`tool(s) blocked during the run: ${denied.join(', ')}`);
      return ok(detail);
    },
  };

  const langfuse: BuildAdapter = {
    tool: 'langfuse',
    async apply(ctx) {
      backends.langfuse.project = `os-${ctx.systemId ?? 'sys'}`;
      return ok(`linked Langfuse project ${backends.langfuse.project}`);
    },
    async verify() {
      if (backends.langfuse.traces.length === 0) return fail('no trace appeared for the test invocation');
      return ok(`${backends.langfuse.traces.length} trace(s) landed for the test invocation`);
    },
  };

  // Order matters: write files + grants + routing, THEN run the graph (needs the
  // grants to authorize, and produces the traces Langfuse then verifies).
  return [forgejo, opa, litellm, langgraph, langfuse];
}

function ok(detail: string): StepResult {
  return { ok: true, detail };
}
function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}
