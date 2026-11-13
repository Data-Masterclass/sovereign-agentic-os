/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run a committed agent system's compiled graph from a plain checkout — no cluster,
 *             no database, no model credential (engine rebuild Part F, checklist A4)
 * USER STORY: As an engineer who cloned a domain repository I want to execute the `system.yaml`
 *             the OS committed and watch it reach END, so the artefact is something I can run
 *             and reason about rather than a file only the OS can interpret.
 * ARCHITECTURE:
 *   - Takes the SAME `system.yaml` the OS commits to `agents/<slug>/system.yaml`, parses and
 *     compiles it with the OS's own `parseSystem` → `compile` → `buildGraph` (via the engine's
 *     `runGraphEngine`), so what runs here is the production graph, not a re-implementation.
 *   - Everything the cluster supplies is stubbed at the engine's own seams, which is why no
 *     credential is needed: the LiteLLM caller becomes a DETERMINISTIC scripted model (the same
 *     protocol `parity-harness.ts` uses — PLAN prose, then the node's first advertised tool, then
 *     `FINAL(<node>)`), the governed executor becomes a stub that echoes its arguments, and the
 *     Postgres checkpointer becomes LangGraph's in-memory saver. Nothing writes anywhere.
 *   - It therefore proves the artefact RUNS and the graph is honest about where it goes — it does
 *     NOT prove A4's "with LangGraph alone": `buildGraph` is still the OS's compiler, and a
 *     standalone `graph.ts` that emits LangGraph calls directly is still unbuilt (deviation D-8).
 *     The checklist row says exactly that.
 *   - Registers the repo's module-resolution hook before importing anything from `tabs/`/`core/`
 *     (the alias + `server-only` hook the test runner uses — one resolver, not a second one).
 *
 * USAGE (from os-ui/):
 *   node scripts/run-agent-graph.mjs <path/to/system.yaml> ["the task"]
 *   node scripts/run-agent-graph.mjs ../path/to/repo/agents/my-system/system.yaml
 * Exits 0 when the run reaches END, 1 otherwise (so it is usable as a smoke test).
 */
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./test-alias-hook.mjs', import.meta.url);

const [yamlPath, taskArg] = process.argv.slice(2);
if (!yamlPath) {
  console.error('usage: node scripts/run-agent-graph.mjs <path/to/system.yaml> ["the task"]');
  process.exit(2);
}
const task = taskArg ?? 'Describe what you would do for this task, then finish.';

const { parseSystem } = await import('../tabs/agents/lib/system-schema.ts');
const { compile } = await import('../tabs/agents/lib/langgraph-compile.ts');
const { runGraphEngine } = await import('../tabs/agents/lib/engine/run.ts');
const { memoryCheckpointer } = await import('../tabs/agents/lib/engine/checkpointer.ts');

const system = parseSystem(readFileSync(yamlPath, 'utf8'));
const ir = compile(system);

/** The node the engine is asking about, read from its own system-prompt marker. */
const nodeOf = (req) => {
  for (const m of req.messages) {
    if (m.role !== 'system') continue;
    const hit = /--- YOUR ROLE IN THE TEAM: (\S+) ---/.exec(m.content);
    if (hit) return hit[1];
  }
  return 'unknown';
};
const isRoute = (req) => !!req.tools && req.tools.length === 1 && req.tools[0].function.name === 'route';

/** A deterministic stand-in for the LiteLLM gateway — no network, no key, no cost. */
function scriptedModel() {
  const acts = new Map();
  const routed = new Map();
  return async (req) => {
    const node = nodeOf(req);
    if (!req.tools) return { content: `plan(${node}): use the granted tools, then answer.`, toolCalls: [] };
    if (isRoute(req)) {
      const members = (req.tools[0].function.parameters?.properties?.next?.enum ?? []).filter((m) => m !== 'END');
      const n = routed.get(node) ?? 0;
      routed.set(node, n + 1);
      return { content: '', toolCalls: [{ id: `route-${node}-${n + 1}`, name: 'route', args: { next: members[n] ?? 'END', brief: '' } }] };
    }
    const n = (acts.get(node) ?? 0) + 1;
    acts.set(node, n);
    const first = req.tools[0]?.function.name;
    if (n === 1 && first) return { content: '', toolCalls: [{ id: `call-${node}-1`, name: first, args: { task } }] };
    return { content: `FINAL(${node}): answered the task${first ? ` using ${first}` : ''}.`, toolCalls: [] };
  };
}

const steps = [];
const result = await runGraphEngine({
  ir,
  deps: {
    llm: scriptedModel(),
    // Stubbed tools: every tool the node was GRANTED, advertised with a trivial schema.
    toolSpecsFor: (node) =>
      (node.tools ?? []).map((name) => ({
        name,
        description: `Stubbed ${name} — this runner executes no governed tool.`,
        inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      })),
    callTool: async (name, args) => ({ text: `stub(${name}) ← ${JSON.stringify(args)}`, isError: false }),
    preamble: 'You are running outside the OS, against a stubbed model and stubbed tools.',
    reasoningModel: 'stub-reasoning',
    execModel: 'stub-default',
    maxIterations: 4,
    maxRunSteps: 40,
  },
  messages: [{ role: 'user', content: task }],
  runId: `local-${Date.now()}`,
  checkpointer: memoryCheckpointer(),
  hooks: { onStep: (ev) => steps.push(`${ev.node} → ${ev.step.tool}`) },
});

console.log(`system:     ${system.system.name} (domain ${system.system.domain}, entrypoint ${ir.entrypoint})`);
console.log(`engine:     ${result.engine}, checkpointer ${result.checkpointer}`);
console.log(`path:       ${result.path.join(' → ')}`);
console.log(`tool calls: ${steps.length ? steps.join(', ') : '(none)'}`);
console.log(`budget:     ${result.budget.stepsUsed}/${result.budget.limit}${result.budget.exhausted ? ' (exhausted)' : ''}`);
if (result.warnings.length) console.log(`warnings:   ${result.warnings.join(' | ')}`);
console.log(`final:      ${result.finalText}`);
console.log(`reachedEnd: ${result.reachedEnd}${result.parked ? ' (PARKED on an approval — resume with a decision)' : ''}`);
process.exit(result.reachedEnd ? 0 : 1);
