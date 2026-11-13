/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Agents tab's engineering view — the compiled LangGraph graph, the git files, the trace
 * USER STORY: As an engineer I open "Under the hood" on an agent system and read the graph the OS
 *             compiled: the `plan`/`act`/`tools`/`route` node of every agent, the conditional
 *             edges, the `when` guards, the state channels, where a run parks on `interrupt()`,
 *             the checkpointer, and that the LangGraph `thread_id` IS the OS run id — plus the
 *             `system.yaml` as committed and the Langfuse trace of the last run (T1, T5, T6).
 * ARCHITECTURE:
 *   - `getSystem` first (the tab's own gate; it throws the 404/403 the MCP maps), then PURE
 *     derivation: `compile()` is the same IR the engine builds from, and the node names come from
 *     the engine's own `safeNodeName`, so the graph shown is the graph compiled rather than a
 *     drawing of it. `engineering.test.ts` pins the derivation against a real `buildGraph`.
 *   - The edge rules mirror `build-graph.ts`'s assembly exactly: `addEdge(START, plan_<entry>)`,
 *     `plan → act | END` (a `Command` with `ends`), the two `addConditionalEdges` on `act` and
 *     `tools`, and the supervisor's `route` fan-out to members ∪ handoff targets ∪ parent ∪ END.
 *   - The `system.yaml` body is read from the REPOSITORY when it is committed there; the store's
 *     copy is used only as a labelled fallback, never silently.
 */
import 'server-only';
import { getSystem } from '@tabs/agents/lib/store';
import { compile, type IR } from '@tabs/agents/lib/langgraph-compile';
import { safeNodeName } from '@tabs/agents/lib/engine/build-graph';
import { AGENTS_PREFIX, ownerToken, segment } from '@tabs/agents/lib/git/generate';
import { readRepoFiles, repoPaths } from '@core/engineering/repo';
import { gitSection, langfuseSection, langgraphSection, LANGFUSE_REDACTIONS, dbtSection, dagsterSection } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';
import type { EngineeringGraph, GraphEdge, GraphNode } from '@core/engineering/graph';
import { langfuseEnabled, traceUrlFor } from '@core/infra/langfuse';
import { config } from '@core/kernel/config';

const OS_NOUN = 'agent system';

/** The four LangGraph node names of one agent — `build-graph.ts`'s own `nameOf`. */
export function nodeNamesFor(agentId: string): { plan: string; act: string; tools: string; route: string } {
  const safe = safeNodeName(agentId);
  return { plan: `plan_${safe}`, act: `act_${safe}`, tools: `tools_${safe}`, route: `route_${safe}` };
}

/**
 * The compiled graph, derived from the SAME IR the engine compiles and the SAME node naming.
 * `disabled` prunes agents exactly as `buildGraph` does.
 */
export function compiledGraphOf(ir: IR, disabled: string[], checkpointer: string): EngineeringGraph {
  const off = new Set(disabled);
  const active = ir.nodes.filter((n) => !off.has(n.id));
  const parentOf = new Map<string, string>();
  for (const n of active) for (const m of n.members) parentOf.set(m, n.id);
  const handoffs = new Map<string, { to: string; when: string | null }[]>();
  for (const c of ir.commands) {
    if (off.has(c.from) || off.has(c.to)) continue;
    handoffs.set(c.from, [...(handoffs.get(c.from) ?? []), { to: c.to, when: c.when }]);
  }

  const nodes: GraphNode[] = [{ id: 'START', phase: 'start', agent: null }];
  for (const n of active) {
    const nn = nodeNamesFor(n.id);
    nodes.push(
      { id: nn.plan, phase: 'plan', agent: n.id },
      { id: nn.act, phase: 'act', agent: n.id },
      { id: nn.tools, phase: 'tools', agent: n.id },
      { id: nn.route, phase: 'route', agent: n.id },
    );
  }
  nodes.push({ id: 'END', phase: 'end', agent: null });

  const edges: GraphEdge[] = [{ from: 'START', to: nodeNamesFor(ir.entrypoint).plan, kind: 'direct', when: null }];
  for (const n of active) {
    const nn = nodeNamesFor(n.id);
    edges.push(
      { from: nn.plan, to: nn.act, kind: 'command', when: null },
      { from: nn.plan, to: 'END', kind: 'command', when: 'the step budget is exhausted, or the visit failed' },
      { from: nn.act, to: nn.tools, kind: 'conditional', when: 'a tool call is pending' },
      { from: nn.act, to: nn.route, kind: 'conditional', when: 'no tool call is pending' },
      { from: nn.tools, to: nn.tools, kind: 'conditional', when: 'more tool calls are pending' },
      { from: nn.tools, to: nn.act, kind: 'conditional', when: 'every tool call has run' },
    );
    const parent = parentOf.get(n.id);
    const outgoing = handoffs.get(n.id) ?? [];
    if (n.supervisor) {
      for (const m of n.members) if (!off.has(m)) edges.push({ from: nn.route, to: nodeNamesFor(m).plan, kind: 'conditional', when: `the supervisor routed to '${m}'` });
      for (const h of outgoing) edges.push({ from: nn.route, to: nodeNamesFor(h.to).plan, kind: 'conditional', when: h.when });
      if (parent) edges.push({ from: nn.route, to: nodeNamesFor(parent).route, kind: 'conditional', when: 'the supervisor ended; control returns to its own supervisor' });
      edges.push({ from: nn.route, to: 'END', kind: 'conditional', when: 'the supervisor routed to END' });
    } else {
      for (const h of outgoing) edges.push({ from: nn.route, to: nodeNamesFor(h.to).plan, kind: 'command', when: h.when });
      if (parent) edges.push({ from: nn.route, to: nodeNamesFor(parent).route, kind: 'command', when: 'control returns to the supervisor' });
      edges.push({ from: nn.route, to: 'END', kind: 'command', when: 'no handoff and no supervisor to return to' });
    }
  }

  return {
    entrypoint: nodeNamesFor(ir.entrypoint).plan,
    nodes,
    edges,
    channels: Object.entries(ir.channels).map(([name, declaration]) => ({ name, declaration })),
    interrupts: active.map((n) => ({
      node: nodeNamesFor(n.id).tools,
      reason: 'a tool call that needs an approval parks the thread here on `interrupt()`; the approval decision resumes it with `Command({ resume })`',
    })),
    checkpointer,
    threadIdSemantics: 'the LangGraph `thread_id` IS the OS run id, which is also the Langfuse trace id — one id for the whole run',
    resumeSemantics: 'resuming re-enters the thread at its last checkpoint with `Command({ resume: { <approvalId>: <decision> } })`; nothing before the interrupt runs twice',
  };
}

/** The checkpointer this deployment compiles graphs with, named as LangGraph names it. */
export function checkpointerName(): string {
  return config.agentRunsDatabaseUrl
    ? 'PostgresSaver (@langchain/langgraph-checkpoint-postgres) — threads survive a restart'
    : 'MemorySaver (@langchain/langgraph) — in-process only; a restart loses in-flight threads';
}

/** The directory `agents/…` the system's files are generated into (domain lane or personal lane). */
export function systemDirCandidates(rec: { id: string; name: string; owner: string; visibility: string }): string[] {
  const slug = segment(rec.name, 'system');
  const suffixed = `${slug}-${rec.id.slice(-12)}`;
  const personal = `${AGENTS_PREFIX}personal/${ownerToken(rec.owner)}`;
  return rec.visibility === 'Personal'
    ? [`${personal}/${slug}`, `${personal}/${suffixed}`]
    : [`${AGENTS_PREFIX}${slug}`, `${AGENTS_PREFIX}${suffixed}`];
}

/** The engineering view of one agent system. */
export async function agentSystemEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const view = getSystem(id, principal);
  const domain = view.domain;

  // ---- LangGraph: the compiled graph -------------------------------------------
  let graph: EngineeringGraph | null = null;
  let compileError: string | null = null;
  try {
    graph = compiledGraphOf(compile(view.system), view.disabledAgents ?? [], checkpointerName());
  } catch (e) {
    compileError = (e as Error).message;
  }
  const langgraph = langgraphSection({
    osNoun: OS_NOUN,
    graph,
    unavailable: compileError ? `this \`system.yaml\` does not compile to a graph: ${compileError}` : undefined,
  });

  // ---- git: the files as committed ---------------------------------------------
  const listed = await repoPaths(domain);
  const dirs = systemDirCandidates(view);
  const dir = dirs.find((d) => listed.paths.some((p) => p === `${d}/system.yaml`)) ?? null;
  const wanted = dir ? listed.paths.filter((p) => p.startsWith(`${dir}/`)) : [];
  const read = dir ? await readRepoFiles(domain, (p) => p === `${dir}/system.yaml` || p === `${dir}/graph.json`) : null;
  const committedYaml = read?.files.find((f) => f.path.endsWith('/system.yaml'))?.content ?? null;

  const git = gitSection({
    osNoun: OS_NOUN,
    repo: domain,
    cloneUrl: null,
    head: listed.head,
    files: wanted.sort().map((p) => ({ path: p })),
    tracked: new Set(listed.paths),
    unavailable:
      listed.reason ??
      `no \`system.yaml\` for this system is committed in '${domain}' yet — the generator writes it to ${dirs[0]}/system.yaml on the next commit`,
  });
  // The `system.yaml` bytes themselves ride on the git section as a file artefact, and the
  // honest label says where they came from.
  if (committedYaml && dir) {
    git.artefacts.unshift({
      noun: 'git file',
      name: 'system.yaml',
      repoPath: `${dir}/system.yaml`,
      language: 'yaml',
      body: committedYaml,
    });
  } else {
    git.caveats = [
      ...(git.caveats ?? []),
      `The \`system.yaml\` shown here is the OS store's copy, not the repository's bytes: no \`${dirs[0]}/system.yaml\` was found in '${domain}'.`,
    ];
    git.artefacts.unshift({
      noun: 'git file',
      name: 'system.yaml (OS store copy)',
      language: 'yaml',
      body: view.yaml,
    });
  }

  // ---- Langfuse: the trace of the last run -------------------------------------
  const runId = view.lastRun?.runId ?? null;
  const langfuse = langfuseSection({
    osNoun: OS_NOUN,
    enabled: langfuseEnabled(),
    traces: runId ? [{ runId, url: view.lastRun?.traceUrl ?? traceUrlFor(runId) ?? null }] : [],
    noUrlReason: 'this deployment does not expose the Langfuse console, so the trace exists but has no address to open here',
    unavailable: runId ? undefined : 'this system has not run yet, so there is no Langfuse trace',
    redactions: LANGFUSE_REDACTIONS,
  });

  // ---- the two tools this kind does not touch, said out loud -------------------
  const dbt = dbtSection({
    osNoun: OS_NOUN,
    node: null,
    files: [],
    unavailable: 'an agent system is not a dbt project; the data it reads is a dbt model on the data product it was granted',
  });
  const dagster = dagsterSection({
    osNoun: OS_NOUN,
    facts: { assetKeys: [], jobName: null, scheduleName: null, lastRun: null, uiBaseUrl: null },
    unavailable:
      'an agent system is scheduled by the OS (a Kubernetes CronJob per schedule), not by Dagster — Dagster schedules dbt models',
  });

  return sealView({
    kind: 'agent_system',
    id: view.id,
    name: view.name,
    domain,
    sections: [dbt, dagster, langgraph, git, langfuse],
    export: dir
      ? {
        tool: 'langgraph',
        label: 'the LangGraph graph JSON plus the committed system.yaml',
        href: null,
        unresolvedReason:
          'a one-click export is not built yet; the two files are the `system.yaml` above and the compiled graph JSON in this panel, and a `git clone` of the domain repository gives you both',
        commands: [`git clone <os>/git/${domain}.git`, `cat ${dir}/system.yaml`, `cat ${dir}/graph.json`],
      }
      : undefined,
  }, new Set(listed.paths));
}
