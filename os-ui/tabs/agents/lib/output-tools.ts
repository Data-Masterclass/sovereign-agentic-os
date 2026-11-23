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
 *   - SAVING the declared result is not the agent's job any more: the engine files it when the run
 *     finishes (`output-saver.ts`). What this module says to the builder (`outputLanding`,
 *     `outputCaveats`) and to the model (`outputsBrief`) states exactly that.
 *   - Pure: no `server-only`. The builder, the run and the prompt share it.
 */
import { normaliseFolderPath } from '@core/kernel/folders';
import { capabilityWrites, writeToolsForKind } from '@tabs/agents/lib/capability-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { dataFormatBrief, instructionsAskForTable } from '@tabs/agents/lib/output-table';
import type { DeclaredOutput, OutputKind, System } from '@tabs/agents/lib/system-schema';

const OUTPUT_KINDS: OutputKind[] = ['files', 'knowledge', 'data'];

/**
 * The ONE tool that creates an output of each kind in a folder. The ENGINE drives it when a run
 * finishes (`output-saver.ts`); the producing agent also holds it, for anything it writes on the
 * way. All three take a `folder`.
 */
export const OUTPUT_TOOL: Record<OutputKind, string> = {
  files: 'upload_file',
  knowledge: 'save_knowledge_note',
  data: 'create_dataset',
};

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

const AS_WHAT: Record<OutputKind, (o: DeclaredOutput) => string> = {
  files: () => 'as a dated markdown file',
  knowledge: () => 'as a note',
  data: (o) => `as the dataset “${o.name.trim()}”`,
};

/**
 * Says — from the SAME hold rule the engine applies (`holdDecisionFor`) — what happens to this
 * output when a run finishes, and where it lands. The write always creates the RUNNER'S OWN
 * artifact (My …); a Domain target is reached by the separate promotion, which the run requests
 * and a domain admin approves. That is stated, not hidden behind the word "Domain".
 */
export function outputLanding(sys: System, o: DeclaredOutput): OutputLanding {
  const tool = OUTPUT_TOOL[o.kind];
  const lane = LANE[o.kind];
  const path = normaliseFolderPath(o.folder.path);
  const where = `${lane.personal}${path === '/' ? '' : ` ${path}`}`;
  if (!outputIsWritable(sys, o)) {
    return { mode: 'blocked', text: `Cannot be written: the Write access of this folder was turned off under “What your team can use”.` };
  }
  if (holdDecisionFor(sys.safetyPreset, tool).held) {
    return {
      mode: 'held',
      text: `Not saved by a run: this team is read-only, so a run writes nothing by itself. After a run, “Save now” saves it as you. Raise “What this team is allowed to do” to have it saved automatically.`,
    };
  }
  const saved = `Saved automatically to ${where} ${AS_WHAT[o.kind](o)} when a run finishes`;
  if (o.folder.scope === 'domain') {
    return { mode: 'direct', text: `${saved}. Sharing it to ${lane.domain} is then requested for you and waits for a domain admin’s approval.` };
  }
  return { mode: 'direct', text: `${saved}.` };
}

/**
 * What the builder can know IN ADVANCE about an output that will not turn out the way its row
 * suggests — said at the row, before a run finds out. Each entry is one plain sentence; an empty
 * list means there is nothing to warn about. Nothing here changes what is saved.
 */
export function outputCaveats(sys: System, o: DeclaredOutput): string[] {
  if (!outputIsWritable(sys, o)) return [];
  const out: string[] = [];
  if (o.kind === 'data') {
    const producers = outputProducers(sys, o);
    const named = o.agent && producers.length === 1;
    const asks = sys.agents.filter((a) => producers.includes(a.id)).some((a) => instructionsAskForTable(a.agent_md));
    if (!asks) {
      out.push(
        `${named ? `The instructions of ${o.agent} do` : 'No agent’s instructions'} ${named ? 'not ' : ''}ask for rows. A dataset is saved only when the final answer contains one JSON list with one object per row; the run asks for that format itself, but instructions that ask for a different final answer win. Without the list the run says “no table in the result” and saves nothing to Data.`,
      );
    }
    out.push('Each run lands as a new version of this one dataset and replaces its rows with that run’s rows.');
    if (o.folder.scope === 'domain') {
      out.push('A dataset can be shared with the domain only once it is documented and has a Silver or Gold version; until then the request is refused with that reason and the dataset stays in My data.');
    }
  }
  if (o.kind === 'knowledge') {
    out.push('A note is listed in Knowledge → My knowledge and can be granted to agent systems. Knowledge search does not find notes yet.');
  }
  return out;
}

const KIND_WORD: Record<OutputKind, string> = { files: 'file', data: 'dataset', knowledge: 'knowledge note' };

/** The line that opens one result's section in an answer that carries more than one result. */
export const OUTPUT_SECTION_RE = /^[ \t]*===[ \t]*OUTPUT:[ \t]*(.+?)[ \t]*===[ \t]*$/gim;
export const outputSectionLine = (name: string): string => `=== OUTPUT: ${name.trim()} ===`;

/**
 * One result's part of an agent's final answer. An answer that uses the `=== OUTPUT: <name> ===` lines (an agent
 * that produces more than one result is told to) gives each result only its own section — '' when that result has
 * no section. An answer without such lines is the result as a whole (one result per agent, and every answer written
 * before sections existed).
 */
export function outputSection(text: string, name: string): string {
  const marks = [...text.matchAll(OUTPUT_SECTION_RE)];
  if (marks.length === 0) return text;
  const want = name.trim().toLowerCase();
  const i = marks.findIndex((m) => m[1].trim().replace(/^["“]|["”]$/g, '').toLowerCase() === want);
  if (i < 0) return '';
  const start = marks[i].index! + marks[i][0].length;
  const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
  return text.slice(start, end).trim();
}

/**
 * The OUTPUTS block of an agent's system prompt: the results the SYSTEM saves from that agent's final answer, and
 * what the answer must contain — generated from the declaration. With `agentId`, only the results that agent may
 * produce (the ones it is named for, and the unnamed ones, which the last agent of the run produces). The wording
 * matches the agent's granted write tools: the system saves these results, so the agent does not save them again;
 * its write tools are for other work its instructions ask for. When one agent produces more than one result, its
 * answer carries one section per result (`=== OUTPUT: <name> ===`), so a document and a dataset never share a body
 * (`outputSection` reads them back). Empty when nothing writable is declared.
 */
export function outputsBrief(sys: System, agentId?: string): string {
  const named = (o: DeclaredOutput) => (o.agent && sys.agents.some((a) => a.id === o.agent) ? o.agent : null);
  const mine = (sys.outputs ?? []).filter((o) => outputIsWritable(sys, o) && (agentId === undefined || named(o) === null || named(o) === agentId));
  if (mine.length === 0) return '';
  // Results that can land in ONE answer: the ones named for the same agent, plus the unnamed (last agent's) ones.
  const sharing = (o: DeclaredOutput) => mine.filter((x) => named(x) === named(o) || named(x) === null || named(o) === null).length;
  const rows = mine.map((o) => {
    const path = normaliseFolderPath(o.folder.path);
    const who = named(o) ? `agent ${named(o)}` : 'the last agent of the run';
    const sectioned = sharing(o) > 1;
    const what = o.kind === 'files'
      ? 'The complete document, in markdown.'
      : o.kind === 'knowledge'
        ? 'What should be kept, in markdown.'
        : dataFormatBrief(o.name.trim(), sectioned);
    return `- "${o.name.trim()}" (${KIND_WORD[o.kind]}, folder "${path}"), from the final answer of ${who}: ${what}${sectioned ? ` Under the line \`${outputSectionLine(o.name)}\`.` : ''}`;
  });
  const anySections = mine.some((o) => sharing(o) > 1);
  return [
    'The SYSTEM saves these results when the run finishes, from the final answer of the agent named for each one,',
    'into the folder shown. If one is yours, put its content in your final answer; you do not save it yourself and',
    'you do not say it was saved (the run report says where it went). Your granted write tools are for any OTHER',
    'work your instructions ask for — not for saving these results a second time.',
    ...(anySections
      ? ['When your final answer carries more than one of these results, give each its own section: a line',
        '`=== OUTPUT: <result name> ===`, then only that result. Nothing else belongs inside a section.']
      : []),
    '',
    ...rows,
  ].join('\n');
}
