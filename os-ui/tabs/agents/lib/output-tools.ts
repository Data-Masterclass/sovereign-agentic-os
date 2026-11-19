/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    A declared output is the permission to write it — tool, folder, and what the agent is told
 * USER STORY: As an author I chose where the results go on the first step. I do not want to hunt
 *             for a "save file" tool afterwards, and I do not want my agent to guess a path: the
 *             agent that writes the result has the tool, may use it there and nowhere else, and
 *             is told so.
 * ARCHITECTURE:
 *   - An output is NOT a second permission system. `addOutput` (`simple-edit.ts`) already stores a
 *     Write folder grant for it and puts the kind's write tools into the team pool
 *     (`grants.tools`). What was missing is the last step: an agent with its OWN tool list
 *     (`agents[].tools`, a narrowing) never received a tool that entered the pool later, so it
 *     answered "upload_file is not in this agent's tools" — and the builder's capability picker
 *     offers capabilities, not tools, so there was nothing to add by hand.
 *   - `withOutputTools` closes that at RUN time, on the system the run executes
 *     (`prepareRun`, `build/run-service.ts`). Nothing is persisted, so removing the output takes
 *     the tool away again with no bookkeeping, and a hand-written tool list is never rewritten.
 *   - It only ever hands out a tool the output's own Write grant already justifies: an output
 *     whose folder grant was turned down to Read, or removed, provisions nothing.
 *   - WHERE the tool may write is enforced elsewhere (`build/grant-scope.ts`: a new file must be
 *     inside a writable folder) and WHETHER the write waits for a person is `build/hold.ts`.
 *     This module reads both rules to SAY what will happen; it changes neither.
 *   - Pure: no `server-only`. The builder, the run and the prompt share it.
 */
import { normaliseFolderPath } from '@core/kernel/folders';
import { capabilityWrites, writeToolsForKind } from '@tabs/agents/lib/capability-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import type { DeclaredOutput, OutputKind, System } from '@tabs/agents/lib/system-schema';

const OUTPUT_KINDS: OutputKind[] = ['files', 'knowledge', 'data'];

/** The ONE tool an agent calls to create an output of each kind (the first of the kind's write tools). */
export const OUTPUT_TOOL: Record<OutputKind, string> = {
  files: 'upload_file',
  knowledge: 'author_knowledge',
  data: 'create_dataset',
};

/** Whether that tool can FILE its result into a folder. Only `upload_file` takes a `folder`. */
export const OUTPUT_TOOL_TAKES_FOLDER: Record<OutputKind, boolean> = { files: true, knowledge: false, data: false };

const LANE: Record<OutputKind, { personal: string; domain: string }> = {
  files: { personal: 'My files', domain: 'Domain files' },
  knowledge: { personal: 'My knowledge', domain: 'Domain knowledge' },
  data: { personal: 'My data', domain: 'Domain data' },
};

const sameFolder = (a: { path: string; scope: string }, b: { path: string; scope: string }) =>
  a.scope === b.scope && normaliseFolderPath(a.path) === normaliseFolderPath(b.path);

/** True while the output's folder still carries a write-capable grant (its permission). */
export function outputIsWritable(sys: System, o: DeclaredOutput): boolean {
  return sys.grants[o.kind].some((g) => g.folder && sameFolder(g.folder, o.folder) && capabilityWrites(g.capability));
}

/** The agents that write an output: the one it names, or — unnamed / no longer on the team — all. */
export function outputProducers(sys: System, o: DeclaredOutput): string[] {
  const ids = sys.agents.map((a) => a.id);
  return o.agent && ids.includes(o.agent) ? [o.agent] : ids;
}

/** The write tools an agent holds BECAUSE of the declared outputs it produces. */
export function agentOutputTools(sys: System, agentId: string): string[] {
  const out = new Set<string>();
  for (const o of sys.outputs ?? []) {
    if (!outputIsWritable(sys, o) || !outputProducers(sys, o).includes(agentId)) continue;
    for (const t of writeToolsForKind(o.kind)) out.add(t);
  }
  return [...out];
}

/**
 * The system a RUN executes, with every declared output's write tool in the hands of the agent(s)
 * that produce it — and, where every output of a kind names its producer and nothing else of
 * that kind is writable, in nobody else's.
 *
 *   - producer with its own tool list  → the kind's write tools are added to it;
 *   - producer that inherits the pool  → nothing to do, the pool has them;
 *   - another agent that inherits      → it gets the pool WITHOUT that kind's write tools;
 *   - another agent with its own list  → left exactly as the builder wrote it.
 */
export function withOutputTools(input: System): System {
  const outputs = (input.outputs ?? []).filter((o) => outputIsWritable(input, o));
  if (outputs.length === 0) return input;
  const sys = structuredClone(input);
  const agentIds = new Set(sys.agents.map((a) => a.id));

  for (const kind of OUTPUT_KINDS) {
    const outs = outputs.filter((o) => o.kind === kind);
    if (outs.length === 0) continue;
    const tools = writeToolsForKind(kind);
    for (const t of tools) if (!sys.grants.tools.includes(t)) sys.grants.tools.push(t);

    const everyoneProduces = outs.some((o) => !o.agent || !agentIds.has(o.agent));
    const producers = new Set(outs.map((o) => o.agent).filter((a): a is string => !!a));
    // Is anything of this kind writable for a reason OTHER than a declared output? Then the
    // write tools are the whole team's, as granted, and are not taken from anyone.
    const otherWrite = sys.grants[kind].some(
      (g) => capabilityWrites(g.capability) && !(g.folder && outs.some((o) => sameFolder(o.folder, g.folder!))),
    );

    for (const a of sys.agents) {
      if (everyoneProduces || producers.has(a.id)) {
        if (a.tools) for (const t of tools) if (!a.tools.includes(t)) a.tools.push(t);
      } else if (!otherWrite && a.tools === undefined) {
        a.tools = sys.grants.tools.filter((t) => !tools.includes(t));
      }
    }
  }
  // A producer of one kind that was narrowed above as a non-producer of another keeps its own.
  for (const a of sys.agents) {
    if (!a.tools) continue;
    for (const t of agentOutputTools(sys, a.id)) if (!a.tools.includes(t)) a.tools.push(t);
  }
  return sys;
}

/** What happens when the output is written: it runs, or it waits for a person. */
export type OutputLanding = {
  mode: 'direct' | 'held' | 'blocked';
  /** One plain sentence for the builder, next to the output. */
  text: string;
};

/**
 * Says — from the SAME hold rule the engine applies (`holdDecisionFor`) — whether writing this
 * output runs directly or is held, and where it lands. An agent's write always creates the
 * RUNNER'S OWN artifact (My …); a Domain target is reached by the separate promotion, which a
 * domain admin approves. That is stated, not hidden behind the word "Domain".
 */
export function outputLanding(sys: System, o: DeclaredOutput): OutputLanding {
  const tool = OUTPUT_TOOL[o.kind];
  const lane = LANE[o.kind];
  const path = normaliseFolderPath(o.folder.path);
  const where = OUTPUT_TOOL_TAKES_FOLDER[o.kind]
    ? `${lane.personal}${path === '/' ? '' : ` ${path}`}`
    : `${lane.personal} (top level — ${tool} cannot file into a folder yet)`;
  if (!outputIsWritable(sys, o)) {
    return { mode: 'blocked', text: `Cannot be written: the Write access of this folder was turned off under “What your team can use”.` };
  }
  const hold = holdDecisionFor(sys.safetyPreset, tool);
  if (hold.held) {
    return {
      mode: 'held',
      text: `Held for ${hold.approverRole === 'admin' ? 'an admin’s' : 'a domain admin’s'} approval before it is saved — this team is read-only. Raise “What this team is allowed to do” to save directly.`,
    };
  }
  if (o.folder.scope === 'domain') {
    return {
      mode: 'direct',
      text: `Saved directly to ${where}. Sharing it to ${lane.domain} is a promotion, held for a domain admin’s approval.`,
    };
  }
  return { mode: 'direct', text: `Saved directly to ${where}.` };
}

/**
 * The OUTPUTS block of the run's system prompt: for each declared output, who writes it, with
 * which tool, and into which folder — generated from the declaration, so the agent does not
 * have to guess a path from free text. Empty when nothing writable is declared.
 */
export function outputsBrief(sys: System): string {
  const rows: string[] = [];
  for (const o of sys.outputs ?? []) {
    if (!outputIsWritable(sys, o)) continue;
    const tool = OUTPUT_TOOL[o.kind];
    const path = normaliseFolderPath(o.folder.path);
    const who = o.agent && sys.agents.some((a) => a.id === o.agent) ? `agent ${o.agent}` : 'the agent that produces it';
    const how = OUTPUT_TOOL_TAKES_FOLDER[o.kind]
      ? `${tool} with folder "${path}"`
      : `${tool} (it cannot file into a folder; the result lands at the top level)`;
    rows.push(`- "${o.name}" (${o.kind === 'files' ? 'file' : o.kind === 'data' ? 'dataset' : 'knowledge'}): written by ${who} using ${how}`);
  }
  if (rows.length === 0) return '';
  return [
    'Where this system\'s results go. Save each result with the tool named for it — do not pick',
    'another path, and do not say a result was saved unless the tool call succeeded.',
    '',
    ...rows,
  ].join('\n');
}
