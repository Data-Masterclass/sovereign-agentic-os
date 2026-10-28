/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The AGENTS Choose-Context model — the pure, client-safe descriptor of the grantable
 * context types the Grant stage renders inside the shared `<ChooseContextShell>`, ordered
 * to MIRROR the Software tab: Data · Metrics · Files · Knowledge · Connections · Workflows ·
 * Plan Items. Kept separate from the React component (GrantStage.tsx) so the UI and the unit
 * test share one source of truth (no default-string drift), mirroring
 * `lib/software/appspec/choose-context-model.ts`.
 *
 * Each type names the underlying grant MECHANISM, reusing `lib/agents/resource-groups.ts`:
 *   • `member`    — the single `ResourceMember` (`field` + `feedKind`) the row grants into,
 *                   for the flat/foldered types. The picker body (chosen in GrantStage) is
 *                   FolderResourcePicker for the foldered kinds (data/knowledge/files/
 *                   workflows) and ResourcePicker for the flat ones (connections/metrics).
 *   • `members`   — Plan Items collapses the THREE plan sub-kinds (Operating Model · Strategy ·
 *                   Big Bets) into ONE row with sub-pickers, all writing the shared `plan`
 *                   grant list. (`member`/`members` are mutually exclusive per type.)
 *
 * `createMode` decides the shell's "Create new" behaviour + focus-refresh:
 *   • deep-link — Connections + Data/Files/Knowledge open their own tab (the shell re-fetches
 *     the feed on window focus so a just-built artifact appears to grant);
 *   • derived — Metrics (a measure ON a dataset — nothing to create here directly);
 *   • none — Workflows + Plan Items have no create-new affordance in this surface.
 */

import type { CreateNewMode } from '@/lib/core/choose-context';
import { RESOURCE_MEMBERS, type ResourceMember } from '@/lib/agents/resource-groups';

export { grantedSummary } from '@/lib/core/choose-context';

/** Every Agents Choose-Context type, in stable display order (mirrors Software). */
export type AgentContextType =
  | 'data' | 'metrics' | 'files' | 'knowledge' | 'connections' | 'workflows' | 'plan';

export const AGENT_CONTEXT_TYPES: AgentContextType[] = [
  'data', 'metrics', 'files', 'knowledge', 'connections', 'workflows', 'plan',
];

/** Which grant channel a type binds to: one member, or the collapsed plan sub-members. */
export type AgentContextMeta = {
  type: AgentContextType;
  label: string;
  /** One honest line under the type header — what granting THIS type gives the team. */
  blurb: string;
  /** How this type's grants land in `system.grants`: one member, or plan's sub-members. */
  member?: ResourceMember;
  /** Plan Items only — the sub-kinds (Operating Model · Strategy · Big Bets) as one row. */
  members?: ResourceMember[];
  /** How "Create new" behaves in the shell — deep-link / derived / no create-new. */
  createMode?: CreateNewMode;
  /** For a deep-link create: the OS tab it opens (its own creator). */
  createTab?: 'data' | 'files' | 'knowledge' | 'connections';
  /** A short note under a deep-link / derived create. */
  createNote?: string;
};

/** The resource member with a given `key` (or throw — the model is a fixed contract). */
function memberByKey(key: string): ResourceMember {
  const m = RESOURCE_MEMBERS.find((r) => r.key === key);
  if (!m) throw new Error(`choose-context-meta: no resource member "${key}"`);
  return m;
}

/**
 * The seven type descriptors — the single source of the Grant-stage row copy + create
 * behaviour. Data/Files/Knowledge/Connections deep-link to their own tab (focus-refresh on
 * return); Metrics is derived (a measure on a dataset); Workflows + Plan Items carry no
 * create-new here (they're authored in their own surfaces and simply granted).
 */
export const AGENT_CONTEXT_META: Record<AgentContextType, AgentContextMeta> = {
  data: {
    type: 'data', label: 'Data',
    blurb: 'Governed datasets the team reads in place (OPA/DLS-scoped, run as the caller — never a copy).',
    member: memberByKey('data'),
    createMode: 'deep-link', createTab: 'data',
    createNote: 'Datasets are built in the Data tab. Create one there, then return — the list refreshes so you can grant it.',
  },
  metrics: {
    type: 'metrics', label: 'Metrics',
    blurb: 'Governed metrics (a measure on a dataset) the team can query.',
    member: memberByKey('metrics'),
    createMode: 'derived',
    createNote: 'A metric is a measure on a dataset — grant or create a dataset above first, then define its metric in the Data tab.',
  },
  files: {
    type: 'files', label: 'Files',
    blurb: 'Governed files the team can read (DLS-scoped).',
    member: memberByKey('files'),
    createMode: 'deep-link', createTab: 'files',
    createNote: 'Files are uploaded in the Files tab. Add one there, then return — the list refreshes so you can grant it.',
  },
  knowledge: {
    type: 'knowledge', label: 'Knowledge',
    blurb: 'Governed knowledge the team can search (DLS-scoped).',
    member: memberByKey('knowledge'),
    createMode: 'deep-link', createTab: 'knowledge',
    createNote: 'Knowledge is authored in the Knowledge tab. Add some there, then return — the list refreshes so you can grant it.',
  },
  connections: {
    type: 'connections', label: 'Connections',
    blurb: 'Mediated external access — the team uses a connection only through a governed capability, never raw credentials.',
    member: memberByKey('connections'),
    createMode: 'deep-link', createTab: 'connections',
    createNote: 'Connections are created in the Connections tab. Create one there, then return — the list refreshes so you can grant it.',
  },
  workflows: {
    type: 'workflows', label: 'Workflows',
    blurb: 'Your business processes (workflows) the team can run, loaded on demand under your access.',
    member: memberByKey('workflows'),
  },
  plan: {
    type: 'plan', label: 'Plan Items',
    blurb: 'Your strategy, big bets and operating model — each loaded on demand via its governed read tool, scope-checked as you.',
    members: [memberByKey('strategy'), memberByKey('bigbets'), memberByKey('operating-manual')],
  },
};

/** The granted count for a type — sums the plan sub-members' grants for the collapsed row. */
export function agentContextGrantedCount(
  type: AgentContextType,
  grantCountByField: (field: ResourceMember['field'], idFamily?: ResourceMember['idFamily']) => number,
): number {
  const meta = AGENT_CONTEXT_META[type];
  if (meta.members) {
    // Plan sub-members all share the `plan` grant list — count it once (they're the same field).
    return grantCountByField('plan');
  }
  const m = meta.member!;
  return grantCountByField(m.field, m.idFamily);
}
