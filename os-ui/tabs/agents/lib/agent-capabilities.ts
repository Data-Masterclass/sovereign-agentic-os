/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    An agent uses everything its team is granted — unless someone limited it, visibly
 * USER STORY: As an author I grant my team files, data and an output. Every agent should simply
 *             have that. If I (or a scaffold) once limited an agent, I want to SEE it on its card,
 *             see what the team was granted that it lacks, and undo it with one click.
 * ARCHITECTURE:
 *   - The model is unchanged: an agent WITHOUT `tools:` inherits the team pool (`grants.tools`);
 *     one WITH a list has exactly that list (`langgraph-compile.ts`, narrow-only). What changed is
 *     who writes a list: no creation path does any more (templates, the starter system, the team
 *     proposer, the helper's "add an agent", the workflow scaffold all used to), so a list now
 *     only comes from a person limiting an agent on purpose.
 *   - A list never updates itself, so a limited agent silently misses what the team gains later.
 *     `agentCapabilityState` says so; `useEverything` / `addMissingCapability` are the two repairs.
 *     Stored definitions are never rewritten on their own.
 *   - PERMISSION, NOT PRESENTATION OR ENFORCEMENT. Inheriting gives an agent the team's tools and
 *     nothing else: every call still passes the grant check (`build/grant-scope.ts`), the hold
 *     rule (`build/hold.ts`), the agent-forbidden list and the runner's role floor.
 *   - Pure: no `server-only`. The builder card and its tests share it.
 */
import { allToolsForKind, writeToolsForKind, type GrantKind } from '@tabs/agents/lib/capability-tools';
import { agentOutputTools } from '@tabs/agents/lib/output-tools';
import type { System } from '@tabs/agents/lib/system-schema';

const KINDS: GrantKind[] = ['data', 'knowledge', 'workflows', 'files', 'connections', 'metrics', 'plan'];

const READ_LABEL: Record<GrantKind, string> = {
  data: 'Data reading',
  knowledge: 'Knowledge search',
  workflows: 'Workflow reading',
  files: 'File reading',
  connections: 'Connections',
  metrics: 'Metrics',
  plan: 'Operating manual',
};
const WRITE_LABEL: Record<GrantKind, string> = {
  data: 'Dataset writing',
  knowledge: 'Knowledge writing',
  workflows: 'Workflow writing',
  files: 'File saving',
  connections: 'Connection setup',
  metrics: 'Metric definition',
  plan: 'Operating manual',
};

/** The plain name of the capability a tool belongs to ("File saving"); the tool name when unmapped. */
export function capabilityLabelForTool(tool: string): string {
  for (const k of KINDS) if (writeToolsForKind(k).includes(tool)) return WRITE_LABEL[k];
  for (const k of KINDS) if (allToolsForKind(k).includes(tool)) return READ_LABEL[k];
  return tool;
}

export type AgentCapabilityState =
  | { mode: 'inherits'; toolCount: number }
  | {
      mode: 'limited';
      /** The agent's own list. */
      tools: string[];
      /** Team tools it does not have — beyond those a declared output hands it at run time anyway. */
      missing: string[];
      /** `missing`, as distinct capability names for a sentence. */
      missingLabels: string[];
    };

/** Whether an agent uses everything the team is granted, or its own list — and what that list lacks. */
export function agentCapabilityState(sys: System, agentId: string): AgentCapabilityState {
  const agent = sys.agents.find((a) => a.id === agentId);
  if (!agent || agent.tools === undefined) return { mode: 'inherits', toolCount: sys.grants.tools.length };
  const own = new Set(agent.tools);
  const viaOutput = new Set(agentOutputTools(sys, agentId));
  const missing = sys.grants.tools.filter((t) => !own.has(t) && !viaOutput.has(t));
  const missingLabels = [...new Set(missing.map(capabilityLabelForTool))];
  return { mode: 'limited', tools: [...agent.tools], missing, missingLabels };
}

/** One line for the card: the state, in words. `limitedCount` is the number of capabilities shown selected. */
export function capabilityStateLine(state: AgentCapabilityState, limitedCount: number): string {
  if (state.mode === 'inherits') return 'Uses everything this team is granted (default).';
  return `Limited to ${limitedCount} ${limitedCount === 1 ? 'capability' : 'capabilities'}.`;
}

/** The quiet note for a limited agent the team has outgrown, or null. */
export function staleLimitNote(state: AgentCapabilityState): string | null {
  if (state.mode !== 'limited' || state.missing.length === 0) return null;
  const names = state.missingLabels;
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return `The team is granted ${list}, which this limited agent does not have.`;
}

/** A catalog message in the `agents` namespace (keys relative to it), rendered by the builder card. */
export type CapabilityMessage = { key: string; args?: Record<string, string | number> };

/** English capability label → its catalog key (`builder.capabilities.kinds.<id>`). */
const LABEL_KEY: Record<string, string> = {
  'Data reading': 'builder.capabilities.kinds.dataRead',
  'Knowledge search': 'builder.capabilities.kinds.knowledgeRead',
  'Workflow reading': 'builder.capabilities.kinds.workflowsRead',
  'File reading': 'builder.capabilities.kinds.filesRead',
  Connections: 'builder.capabilities.kinds.connectionsRead',
  Metrics: 'builder.capabilities.kinds.metricsRead',
  'Operating manual': 'builder.capabilities.kinds.plan',
  'Dataset writing': 'builder.capabilities.kinds.dataWrite',
  'Knowledge writing': 'builder.capabilities.kinds.knowledgeWrite',
  'Workflow writing': 'builder.capabilities.kinds.workflowsWrite',
  'File saving': 'builder.capabilities.kinds.filesWrite',
  'Connection setup': 'builder.capabilities.kinds.connectionsWrite',
  'Metric definition': 'builder.capabilities.kinds.metricsWrite',
};

/** Every English capability label this module can produce (for the catalog-parity test). */
export const CAPABILITY_LABELS: string[] = [...new Set([...Object.values(READ_LABEL), ...Object.values(WRITE_LABEL)])];

/**
 * The catalog message for a label from {@link capabilityLabelForTool}; null for an unmapped tool
 * name (which is shown as is). The English label stays the identity `addMissingCapability` takes.
 */
export function capabilityLabelMessage(label: string): CapabilityMessage | null {
  const key = LABEL_KEY[label];
  return key ? { key } : null;
}

/** {@link capabilityStateLine} as a catalog key + args — same English. */
export function capabilityStateMessage(state: AgentCapabilityState, limitedCount: number): CapabilityMessage {
  if (state.mode === 'inherits') return { key: 'builder.capabilities.inherits' };
  return { key: 'builder.capabilities.limited', args: { count: limitedCount } };
}

/**
 * {@link staleLimitNote} as a catalog key + args — same English. `label` renders one capability
 * label in the user's language (default: as is, i.e. English).
 */
export function staleLimitMessage(state: AgentCapabilityState, label: (english: string) => string = (s) => s): CapabilityMessage | null {
  if (state.mode !== 'limited' || state.missing.length === 0) return null;
  const names = state.missingLabels.map(label);
  if (names.length <= 3) return { key: 'builder.capabilities.staleNote', args: { list: names.join(', ') } };
  return { key: 'builder.capabilities.staleNoteMore', args: { list: names.slice(0, 3).join(', '), more: names.length - 3 } };
}

/** Remove the agent's own list: it uses everything the team is granted again. */
export function useEverything(input: System, agentId: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === agentId);
  if (a) delete a.tools;
  return sys;
}

/**
 * Add ONE missing capability (by its label, e.g. "File saving") to a limited agent, which stays
 * limited. Pool order is kept; a list that thereby equals the pool is dropped, because it no
 * longer limits anything and would only go stale again.
 */
export function addMissingCapability(input: System, agentId: string, label: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === agentId);
  if (!a || a.tools === undefined) return sys;
  const own = new Set(a.tools);
  for (const t of sys.grants.tools) if (!own.has(t) && capabilityLabelForTool(t) === label) own.add(t);
  const next = sys.grants.tools.filter((t) => own.has(t));
  if (next.length === sys.grants.tools.length) delete a.tools;
  else a.tools = next;
  return sys;
}

/**
 * What the capability picker stores for a selection. Selecting everything on offer is NOT a list:
 * the agent keeps inheriting — so opening the picker and applying it unchanged can never turn an
 * inheriting agent into a limited one. Anything less is the narrowed list (⊆ the team pool),
 * resolved by `resolve` (`toolsForCapabilityChipsInPool`).
 */
export function toolsForSelection(
  offeredIds: string[],
  selectedIds: string[],
  resolve: (ids: string[]) => string[],
): string[] | undefined {
  const all = offeredIds.length > 0 && offeredIds.every((id) => selectedIds.includes(id));
  if (all) return undefined;
  return resolve(selectedIds.filter((id) => offeredIds.includes(id)));
}
