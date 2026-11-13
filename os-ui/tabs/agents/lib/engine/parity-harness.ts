/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Engine parity harness — the FROZEN golden fixtures of the pre-rebuild walker
 * USER STORY: As the engineer who replaced the hand-rolled graph walker with a real LangGraph
 *             engine I want the recording of what the OLD walker did (visited path, governed
 *             tool calls, final text) for every shipped system.yaml template plus three
 *             canonical shapes to stay in the repo as the thing the new engine is held to —
 *             so "existing system.yaml files run unchanged" is a measurement, not a claim.
 * ARCHITECTURE:
 *   - The fixtures in `./fixtures/*.json` are FROZEN. They were generated in A0/A1 by the walker
 *     under the scripted model `SCRIPT_ID`, and A5 deleted the walker — so there is no generator
 *     any more and `REGEN_FIXTURES` is gone. They are historical evidence; a fixture is changed
 *     only by adding a NEW one beside it (a regenerated "golden" from the engine under test would
 *     prove nothing, and would erase what the two guarded fixtures deliberately record).
 *   - What is left here drives the ENGINE against those goldens: the REAL `grantedToolSpecs` /
 *     `grantedToolExecutor` gates (so hold/not_found decisions are the production rules, not a
 *     mock's) and the replay caller in `core/runtime/llm-replay.ts`. Only the model and the MCP
 *     dispatch are faked.
 *   - The model is a DETERMINISTIC SCRIPT (`scriptedLlm`, rule set `SCRIPT_ID`): PLAN returns a
 *     fixed plan; a node's first ACT calls its first advertised tool; its next ACT answers
 *     `FINAL(<node>)`; a SUPERVISOR ROUTE request (the single `route` tool) picks the members in
 *     DECLARED order, then END. The node id is read from the `--- YOUR ROLE IN THE TEAM ---`
 *     marker the engine puts in the system prompt.
 *   - The MCP dispatch (`handleRpc`) is replaced by an echo of the call; `enqueue` records held
 *     writes; `trace` is a no-op. The acting user is a fixed BUILDER so role-floor narrowing is
 *     exercised the same way on every machine.
 *   - ENGINE PARITY RULE SET (A0 finding 3): the walker never asked a model where to go, so its
 *     transcripts carry no routing exchanges. A fixture WITHOUT a supervisor is replayed from the
 *     transcript through `buildGraph` (`replayGraph` — every exchange must be consumed); a
 *     fixture WITH a supervisor is driven by the scripted model (`scriptGraph`), whose route rule
 *     reproduces the walker's declared-order visit. Both assert the same golden fields.
 *   - The two GUARDED fixtures are where the engine deliberately DIVERGES: the walker ignored
 *     `when` guards, so `shape-guarded-handoff-held-write`'s golden records it visiting (and
 *     holding a write in) a node whose guard is false. `parity.test.ts` asserts both the golden's
 *     record of the defect and the engine's correct behaviour.
 */
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import type { AgenticStep, LlmCall, LlmRequest } from '@core/runtime/agentic';
import { replayCaller, type LlmTranscript } from '@core/runtime/llm-replay';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { TEMPLATES, templateYaml } from '@tabs/agents/lib/templates';
import { AGENT_TEMPLATES, agentTemplate } from '@tabs/agents/lib/agent-templates';
import { SOFTWARE_TEAM_YAML } from '@tabs/agents/lib/software-team';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import type { GraphDeps } from '@tabs/agents/lib/engine/build-graph';
import { memoryCheckpointer, type SelectedCheckpointer } from '@tabs/agents/lib/engine/checkpointer';
import { runGraphEngine, type EngineHooks } from '@tabs/agents/lib/engine/run';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { memoryApprovalPort, type MemoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';

/** The rule set every frozen fixture was recorded under; a fixture carrying another id is stale.
 *  @2: adds the declared-order `route` rule for supervisors (the walker never triggered it, so the
 *  walker goldens are unchanged; the id records that the engine side is driven by it too). */
export const SCRIPT_ID = 'first-tool-then-final@2';

/** The one task every fixture runs — purpose-neutral so it fits every template. */
export const FIXTURE_TASK = 'Assess the current state of the sales domain and recommend one next step.';

/** A fixed builder: role-floor narrowing in `grantedToolSpecs` is deterministic per machine. */
export const FIXTURE_USER: CurrentUser = {
  id: 'fixture-builder',
  name: 'Fixture Builder',
  domains: ['sales', 'platform'],
  allDomains: ['sales', 'platform'],
  activeDomain: null,
  role: 'builder',
};

/** The preamble every node is grounded in — fixed text, so prompts are byte-stable. */
export const FIXTURE_PREAMBLE = 'OS RULES (parity fixture): act only through your granted, governed tools.';

export type FixtureSpec = {
  /** File stem under ./fixtures/. */
  name: string;
  /** Where the yaml comes from (template key, module, or "hand-written shape"). */
  source: string;
  description: string;
  yaml: string;
};

/** How a governed step ended: ran ('ok'), was HELD for approval ('held'), or errored ('error'). */
export type StepOutcome = 'ok' | 'held' | 'error';

export type GoldenToolCall = { node: string; tool: string; args: Record<string, unknown>; outcome: StepOutcome };

/** Classify a step by its typed result envelope — `held` is not an error, it is a parked write. */
export function stepOutcome(step: Pick<AgenticStep, 'result' | 'isError'>): StepOutcome {
  if (!step.isError) return 'ok';
  try {
    if ((JSON.parse(step.result) as { error?: { code?: string } })?.error?.code === 'held') return 'held';
  } catch {
    /* not a typed envelope */
  }
  return 'error';
}

export type EngineFixture = {
  version: 1;
  name: string;
  source: string;
  description: string;
  /** True when any handoff edge carries a `when` guard — P1's walker side skipped these. */
  guarded: boolean;
  task: string;
  yaml: string;
  script: string;
  transcript: LlmTranscript;
  golden: {
    path: string[];
    toolCalls: GoldenToolCall[];
    finalText: string;
    reachedEnd: boolean;
    /** Writes the real hold gate enqueued to Governance during the run. */
    held: number;
  };
};

// ------------------------------------------------------------------ specs --

function singleAgentSystem(opts: { id: string; name: string; role: string; agentMd: string; tools: string[]; preset?: System['safetyPreset'] }): System {
  return {
    version: '1',
    system: { name: opts.name, domain: 'sales', visibility: 'Personal' },
    runtime: 'langgraph',
    safetyPreset: opts.preset ?? 'read-only',
    entrypoint: opts.id,
    state: { channels: { messages: 'add_messages' } },
    grants: { data: [], knowledge: [], metrics: [], tools: [...opts.tools], connections: [], files: [], plan: [] },
    routing: { overrides: {} },
    agents: [{ id: opts.id, role: opts.role, agent_md: opts.agentMd, memory_md: '# Memory', tools: [...opts.tools] }],
    edges: [],
  };
}

/** Shape (a): one agent, one read tool. */
export const SHAPE_SINGLE_READ_YAML = `version: '1'
system:
  name: Shape A — single agent, one read tool
  domain: sales
  visibility: Personal
entrypoint: reader
state:
  channels:
    messages: add_messages
grants:
  data: []
  knowledge: []
  metrics: []
  tools:
    - search_knowledge
  connections: []
agents:
  - id: reader
    role: Reads the granted knowledge and answers
    agent_md: |
      # reader
      Answer the question from the granted knowledge only. Cite what you used.
    memory_md: '# Memory'
    tools:
      - search_knowledge
`;

/** Shape (b): a supervisor with two members. */
export const SHAPE_SUPERVISOR_YAML = `version: '1'
system:
  name: Shape B — supervisor with two members
  domain: sales
  visibility: Personal
entrypoint: lead
state:
  channels:
    messages: add_messages
grants:
  data: []
  knowledge: []
  metrics: []
  tools:
    - search_knowledge
    - query_data
  connections: []
agents:
  - id: lead
    role: Routes the task to the researcher, then the analyst, then reports
    agent_md: |
      # lead
      Decide who works next: researcher first, analyst second, then END with a summary.
    memory_md: '# Memory'
    tools: []
    members:
      - researcher
      - analyst
  - id: researcher
    role: Gathers the relevant knowledge
    agent_md: |
      # researcher
      Search the granted knowledge for the facts the task needs.
    memory_md: '# Memory'
    tools:
      - search_knowledge
  - id: analyst
    role: Queries the granted data and explains it
    agent_md: |
      # analyst
      Query the granted data and explain what it says.
    memory_md: '# Memory'
    tools:
      - query_data
edges:
  - from: lead
    to: researcher
    type: supervise
  - from: lead
    to: analyst
    type: supervise
`;

/**
 * Shape (c): a GUARDED handoff `when: state.findings_ready` whose target holds ONE write grant
 * the `read-propose` preset HOLDS: `request_promotion` is creator-floor (so a builder's agent is
 * advertised it) and escalates My→Domain, so the scope-aware gate parks it for a domain_admin
 * (`holdDecision` → held, `enqueue` fires, the typed `held` result reaches the model). The walker
 * never evaluates `when`, so its golden visits `publisher` although `findings_ready` is never
 * set — the HANDOFF-GUARD defect Phase A1 fixes.
 */
export const SHAPE_GUARDED_YAML = `version: '1'
system:
  name: Shape C — guarded handoff with a held write
  domain: sales
  visibility: Personal
safety_preset: read-propose
entrypoint: researcher
state:
  channels:
    messages: add_messages
    findings_ready: last_value
grants:
  data: []
  knowledge: []
  metrics: []
  tools:
    - search_knowledge
    - request_promotion
  connections: []
agents:
  - id: researcher
    role: Gathers findings and sets findings_ready when done
    agent_md: |
      # researcher
      Search the granted knowledge. When the findings are complete, mark findings_ready.
    memory_md: '# Memory'
    tools:
      - search_knowledge
  - id: publisher
    role: Files the promotion of the findings to the domain (held for approval)
    agent_md: |
      # publisher
      File a promotion request for the researcher's findings to the Domain scope. The request
      is held for a domain admin's approval — never assume it was applied.
    memory_md: '# Memory'
    tools:
      - request_promotion
edges:
  - from: researcher
    to: publisher
    type: handoff
    when: state.findings_ready
`;

/** Every fixture spec: shipped templates, shipped per-agent templates, the software team, three shapes. */
export function fixtureSpecs(): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (const t of TEMPLATES) {
    specs.push({
      name: `template-${t.key}`,
      source: `tabs/agents/lib/templates.ts:${t.key}`,
      description: `Starter template "${t.label}" — ${t.blurb}`,
      yaml: templateYaml(t.key, `${t.label} starter`, 'sales'),
    });
  }
  for (const t of AGENT_TEMPLATES) {
    const a = agentTemplate(t.key);
    specs.push({
      name: `agent-template-${t.key}`,
      source: `tabs/agents/lib/agent-templates.ts:${t.key}`,
      description: `Per-agent template "${t.label}" as a single-agent system — ${t.blurb}`,
      yaml: serializeSystem(
        singleAgentSystem({
          id: t.key,
          name: `${t.label} (agent template)`,
          role: a.role,
          agentMd: `# ${t.key}\n\n${a.instructions}`,
          tools: a.suggestedTools ?? [],
        }),
      ),
    });
  }
  specs.push({
    name: 'software-team',
    source: 'tabs/agents/lib/software-team.ts',
    description: 'The shipped 6-agent Software Delivery Team (supervisor + guarded handoffs).',
    yaml: SOFTWARE_TEAM_YAML,
  });
  specs.push(
    { name: 'shape-single-read', source: 'hand-written shape (a)', description: 'Single agent with one read tool.', yaml: SHAPE_SINGLE_READ_YAML },
    { name: 'shape-supervisor-two-members', source: 'hand-written shape (b)', description: 'A supervisor with two members (declared order).', yaml: SHAPE_SUPERVISOR_YAML },
    {
      name: 'shape-guarded-handoff-held-write',
      source: 'hand-written shape (c)',
      description: 'Guarded handoff when:"state.findings_ready" into an agent whose only write grant the read-propose preset holds.',
      yaml: SHAPE_GUARDED_YAML,
    },
  );
  return specs;
}

/** True when any handoff edge carries a `when` guard. */
export function hasWhenGuard(sys: System): boolean {
  return sys.edges.some((e) => e.type === 'handoff' && typeof e.when === 'string' && e.when.length > 0);
}

// -------------------------------------------------------------- the script --

const ROLE_MARKER = /--- YOUR ROLE IN THE TEAM: (\S+) ---/;

/** The node a request belongs to, read from the engine's own system-prompt marker. */
export function nodeOfRequest(req: LlmRequest): string {
  for (const m of req.messages) {
    if (m.role !== 'system') continue;
    const hit = ROLE_MARKER.exec(m.content);
    if (hit) return hit[1];
  }
  return 'unknown';
}

/** True for a supervisor ROUTE request: the only advertised tool is the engine's `route`. */
function isRouteRequest(req: LlmRequest): boolean {
  return !!req.tools && req.tools.length === 1 && req.tools[0].function.name === 'route';
}

/** The members a `route` tool offers, in DECLARED order (its `next` enum minus END). */
function routeMembers(req: LlmRequest): string[] {
  const props = (req.tools?.[0]?.function.parameters?.properties ?? {}) as Record<string, { enum?: string[] }>;
  return (props.next?.enum ?? []).filter((m) => m !== 'END');
}

/**
 * The deterministic fake model (rule set {@link SCRIPT_ID}):
 *   • PLAN (no `tools` on the request) → a fixed one-line plan;
 *   • a node's FIRST ACT → call its first advertised tool with fixed args;
 *   • every later ACT → `FINAL(<node>)` prose (no tool calls);
 *   • a node advertised no tools → FINAL at once;
 *   • a supervisor ROUTE request → its members in declared order, one per decision, then END
 *     (empty brief, so the team's final text is the last member's — the walker's behaviour).
 * Keyed on the node id so the same rules hold for a 1-agent and a 6-agent system.
 */
export function scriptedLlm(task: string): LlmCall {
  const acts = new Map<string, number>();
  const routed = new Map<string, number>();
  return async (req) => {
    const node = nodeOfRequest(req);
    if (!req.tools) return { content: `plan(${node}): 1. use the first granted tool  2. answer the task.`, toolCalls: [] };
    if (isRouteRequest(req)) {
      const members = routeMembers(req);
      const n = routed.get(node) ?? 0;
      routed.set(node, n + 1);
      const next = members[n] ?? 'END';
      return { content: '', toolCalls: [{ id: `route-${node}-${n + 1}`, name: 'route', args: { next, brief: '' } }] };
    }
    const n = (acts.get(node) ?? 0) + 1;
    acts.set(node, n);
    const first = req.tools[0]?.function.name;
    if (n === 1 && first) {
      return { content: '', toolCalls: [{ id: `call-${node}-1`, name: first, args: { input: `fixture:${node}`, task } }] };
    }
    return {
      content: first ? `FINAL(${node}): answered the task using ${first}.` : `FINAL(${node}): no tools granted; answered from the team context.`,
      toolCalls: [],
    };
  };
}

// ----------------------------------------------------------- fake dispatch --

/** Records what the REAL hold gate enqueued (the tools node's ApprovalPort). */
export type HoldSink = { enqueued: string[]; port?: MemoryApprovalPort };

/**
 * Collaborators for `grantedToolExecutor`: the gates stay REAL; only the MCP dispatch is an
 * echo (`{ mock, tool, args }`), `enqueue` records the held tool, `trace` is a no-op.
 */
export function fixtureToolDeps(sink: HoldSink): OsToolDeps {
  const enqueue = ((req: { tool?: string }) => {
    sink.enqueued.push(req.tool ?? '?');
    return { id: `fixture-approval-${sink.enqueued.length}` };
  }) as unknown as OsToolDeps['enqueue'];
  const handleRpc = (async (_user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
    jsonrpc: '2.0',
    id: req.id ?? 1,
    result: { content: [{ type: 'text', text: JSON.stringify({ mock: true, tool: req.params?.name, args: req.params?.arguments ?? {} }) }] },
  })) as unknown as OsToolDeps['handleRpc'];
  const trace = (async () => undefined) as unknown as OsToolDeps['trace'];
  return { enqueue, handleRpc, trace };
}

/**
 * The engine's deps, wired EXACTLY as `agentic-graph-server.ts` wires production (minus the
 * embedder and the live hooks, since events flow through the stream writer). A2: the hold is
 * decided in the tools NODE (`hold`, over a memory ApprovalPort recorded on the sink) and the
 * executor runs with `holdAt: 'node'` — exactly as production wires it.
 */
export function graphDeps(sys: System, systemId: string, llm: LlmCall, sink: HoldSink): Omit<GraphDeps, 'checkpointer'> {
  sink.port ??= memoryApprovalPort();
  return {
    llm,
    toolSpecsFor: (node) => grantedToolSpecs(FIXTURE_USER, sys, node.tools),
    callTool: grantedToolExecutor(FIXTURE_USER, sys, systemId, fixtureToolDeps(sink), { holdAt: 'node' }),
    preamble: FIXTURE_PREAMBLE,
    reasoningModel: 'sovereign-reasoning',
    execModel: 'sovereign-default',
    maxIterations: 4,
    maxRunSteps: 40,
    hold: {
      decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
      approvals: sink.port,
      systemId,
      domain: sys.system.domain,
      runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
      agent: `os-${systemId}`,
    },
  };
}

/** True when any agent supervises members — such a fixture needs the scripted `route` rule. */
export function hasSupervisor(sys: System): boolean {
  return sys.agents.some((a) => (a.members ?? []).length > 0);
}

// --------------------------------------------------------- generate/replay --

/** The golden fields a run is compared on: where it went, what it called, what it said. */
export type GoldenRun = Pick<EngineFixture['golden'], 'path' | 'toolCalls' | 'finalText' | 'reachedEnd' | 'held'>;

export type GraphRun = GoldenRun & { warnings: string[]; interrupted: boolean; runId: string };

export type GraphRunOptions = {
  runId?: string;
  resume?: boolean;
  checkpointer?: SelectedCheckpointer;
  signal?: AbortSignal;
  hooks?: EngineHooks;
  /** Tool calls recorded so far (a resume appends to the aborted run's list). */
  toolCalls?: GoldenToolCall[];
  sink?: HoldSink;
};

/** Run (or resume) a fixture through the LangGraph engine with the real gates and a memory checkpointer. */
export async function runGraph(spec: Pick<EngineFixture, 'name' | 'yaml' | 'task'>, llm: LlmCall, opts: GraphRunOptions = {}): Promise<GraphRun> {
  const sys = parseSystem(spec.yaml);
  const ir = compile(sys);
  const toolCalls = opts.toolCalls ?? [];
  const sink = opts.sink ?? { enqueued: [] };
  const runId = opts.runId ?? `fixture-run-${spec.name}`;
  const result = await runGraphEngine({
    ir,
    deps: graphDeps(sys, `fixture-${spec.name}`, llm, sink),
    messages: [{ role: 'user', content: spec.task }],
    runId,
    resume: opts.resume,
    signal: opts.signal,
    checkpointer: opts.checkpointer ?? memoryCheckpointer(),
    hooks: {
      onNodeStart: opts.hooks?.onNodeStart,
      onNodeComplete: opts.hooks?.onNodeComplete,
      onStep: (ev) => {
        toolCalls.push({ node: ev.node, tool: ev.step.tool, args: ev.step.args, outcome: stepOutcome(ev.step) });
        opts.hooks?.onStep?.(ev);
      },
    },
  });
  return {
    path: result.path,
    toolCalls,
    finalText: result.finalText,
    reachedEnd: result.reachedEnd,
    held: sink.enqueued.length + (sink.port?.all().length ?? 0),
    warnings: result.warnings,
    interrupted: result.interrupted,
    runId,
  };
}

/** Replay a fixture's transcript through `buildGraph`; `remaining` must be 0 for a faithful replay. */
export async function replayGraph(fx: EngineFixture): Promise<GraphRun & { remaining: number }> {
  const llm = replayCaller(fx.transcript);
  const run = await runGraph(fx, llm);
  return { ...run, remaining: llm.remaining() };
}

/** Drive a fixture through `buildGraph` with the scripted model (supervisor fixtures — see the rule set above). */
export async function scriptGraph(fx: EngineFixture, opts: GraphRunOptions = {}): Promise<GraphRun> {
  return runGraph(fx, scriptedLlm(fx.task), opts);
}
