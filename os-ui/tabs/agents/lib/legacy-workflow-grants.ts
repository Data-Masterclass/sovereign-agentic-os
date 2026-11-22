/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A saved agent system that granted a workflow under "knowledge" keeps running
 * USER STORY: As the owner of an agent system written before workflows and knowledge notes were
 *             split, I want my system to keep working after the upgrade, with its workflows now
 *             granted as workflows and its tools under their new names, without editing anything.
 * ARCHITECTURE:
 *   - PURE (no I/O, no server-only): the ONE rule shared by the read path (`parseSystem` applies it,
 *     the way an old bare-string grant is already upgraded on read) and the stored migration
 *     (`migrateStoredWorkflowGrants` in `store.ts`, with a dry run). Both call `migrateLegacyWorkflowGrants`,
 *     so they cannot disagree.
 *   - What it does, and nothing else:
 *       1. every `grants.knowledge` entry whose id starts `wf_` moves to `grants.workflows`, with its
 *          capability unchanged (a note, `pk_…`, a folder grant and any other entry stay);
 *       2. the four write tools renamed (`author_knowledge` → `author_workflow`, …) are renamed in
 *          `grants.tools` and in every agent's own tool list;
 *       3. when a workflow grant moved or a workflow tool was renamed, the workflow read tools join the
 *          list next to the knowledge read tools the system already had (`list_knowledge` →
 *          `list_workflows`, `get_knowledge` → `get_workflow`), because those two used to read workflows.
 *   - IDEMPOTENT: a second application finds nothing to move or rename and returns the input unchanged
 *     (same array identities, `changed: false`).
 *   - It never grants anything new: every id and every tool it writes was already granted under an old
 *     spelling, at the same capability.
 */
import yaml from 'js-yaml';
import type { ArtifactGrant } from '@tabs/agents/lib/system-schema';
import { DEPRECATED_TOOL_ALIASES } from '@core/mcp/deprecated-aliases';

export type LegacyGrantInput = {
  knowledge: ArtifactGrant[];
  workflows?: ArtifactGrant[];
  tools: string[];
};

export type LegacyGrantResult = {
  knowledge: ArtifactGrant[];
  workflows: ArtifactGrant[];
  tools: string[];
  /** True when anything moved or was renamed. */
  changed: boolean;
  /** One plain sentence per change, for the migration report. */
  notes: string[];
};

/** Old read tool → the workflow read tool that now reads what it used to read. */
const READ_COMPANIONS: Readonly<Record<string, string>> = {
  list_knowledge: 'list_workflows',
  get_knowledge: 'get_workflow',
};

const isWorkflowGrant = (g: ArtifactGrant): boolean => !g.folder && typeof g.id === 'string' && g.id.startsWith('wf_');

/** Rename the four deprecated tool names in one list; keeps order, drops the duplicate a rename makes. */
export function renameLegacyWorkflowTools(tools: string[]): { tools: string[]; renamed: string[] } {
  const renamed: string[] = [];
  const out: string[] = [];
  for (const t of tools) {
    const next = Object.hasOwn(DEPRECATED_TOOL_ALIASES, t) ? DEPRECATED_TOOL_ALIASES[t] : t;
    if (next !== t) renamed.push(t);
    if (!out.includes(next)) out.push(next);
  }
  return renamed.length === 0 ? { tools, renamed } : { tools: out, renamed };
}

/**
 * One tool list upgraded: the four names renamed and, when `workflowsInPlay`, the workflow read tools
 * added next to the knowledge read tools. Returns the SAME array when nothing changes.
 */
export function upgradeLegacyToolList(tools: string[], workflowsInPlay: boolean): { tools: string[]; renamed: string[]; added: string[] } {
  const { tools: renamedTools, renamed } = renameLegacyWorkflowTools(tools);
  let out = renamedTools;
  const added: string[] = [];
  if (workflowsInPlay || renamed.length > 0) {
    for (const [oldRead, wfRead] of Object.entries(READ_COMPANIONS)) {
      if (out.includes(oldRead) && !out.includes(wfRead)) added.push(wfRead);
    }
    if (added.length > 0) out = [...out, ...added];
  }
  return { tools: out, renamed, added };
}

export function migrateLegacyWorkflowGrants(input: LegacyGrantInput): LegacyGrantResult {
  const notes: string[] = [];
  const moving = input.knowledge.filter(isWorkflowGrant);
  const workflows = input.workflows ?? [];
  let knowledge = input.knowledge;
  let nextWorkflows = workflows;
  if (moving.length > 0) {
    knowledge = input.knowledge.filter((g) => !isWorkflowGrant(g));
    const have = new Set(workflows.map((g) => g.id));
    nextWorkflows = [...workflows, ...moving.filter((g) => !have.has(g.id))];
    notes.push(`moved ${moving.length} workflow grant${moving.length === 1 ? '' : 's'} (${moving.map((g) => g.id).join(', ')}) from knowledge to workflows`);
  }
  const { tools, renamed, added } = upgradeLegacyToolList(input.tools, moving.length > 0);
  if (renamed.length > 0) notes.push(`renamed tool${renamed.length === 1 ? '' : 's'} ${renamed.join(', ')} to ${renamed.map((t) => DEPRECATED_TOOL_ALIASES[t]).join(', ')}`);
  if (added.length > 0) notes.push(`added ${added.join(', ')} next to the knowledge read tools, which used to read workflows`);
  return { knowledge, workflows: nextWorkflows, tools, changed: notes.length > 0, notes };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a STORED `system.yaml` still carries in the old spelling — read from the raw text, because
 * `parseSystem` already upgrades on read and so cannot tell. One plain sentence per finding; empty
 * means nothing to migrate (which is also what a system that was already migrated answers).
 */
export function legacyWorkflowFindings(yamlText: string): string[] {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText);
  } catch {
    return [];
  }
  if (!isRec(doc)) return [];
  const out: string[] = [];
  const g = isRec(doc.grants) ? doc.grants : {};
  const wfIds = (Array.isArray(g.knowledge) ? g.knowledge : [])
    .map((e) => (typeof e === 'string' ? e : isRec(e) && !isRec(e.folder) ? e.id : ''))
    .filter((id): id is string => typeof id === 'string' && id.startsWith('wf_'));
  if (wfIds.length > 0) out.push(`grants.knowledge holds ${wfIds.length} workflow id${wfIds.length === 1 ? '' : 's'} (${wfIds.join(', ')})`);
  const oldTools = (list: unknown): string[] =>
    (Array.isArray(list) ? list : []).map(String).filter((t) => Object.hasOwn(DEPRECATED_TOOL_ALIASES, t));
  const sysTools = oldTools(g.tools);
  if (sysTools.length > 0) out.push(`grants.tools uses the old name${sysTools.length === 1 ? '' : 's'} ${sysTools.join(', ')}`);
  for (const a of Array.isArray(doc.agents) ? doc.agents : []) {
    if (!isRec(a)) continue;
    const t = oldTools(a.tools);
    if (t.length > 0) out.push(`agent ${String(a.id)} tools use the old name${t.length === 1 ? '' : 's'} ${t.join(', ')}`);
  }
  return out;
}
