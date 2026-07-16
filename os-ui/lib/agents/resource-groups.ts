/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The two labelled SECTIONS of the Simple builder's "What your team can use" grant
 * panel, matching the OS information architecture:
 *
 *   ① Plan Items   — Strategy · Big Bets · Operating Manual · Workflows
 *   ② Context      — Knowledge · Files · Data · Connections · Metrics
 *
 * Workflows is its OWN member of Plan Items, SEPARATE from Knowledge (they were
 * historically conflated because a workflow id `wf_…` shares the `grants.knowledge`
 * list with knowledge docs `pk_…`; the two sections keep them visually distinct and
 * route each to the correct grant channel — see `resourceKindGrantField`).
 *
 * Each member names the underlying GRANTABLE mechanism:
 *   • `field`  — the `system.grants` key its per-item grants land in (when wireable).
 *   • `feedKind` — the `…/grants/available?kind=` feed to browse (when wireable).
 *   • `wireable` — every Plan-item kind (Strategy · Big Bets · Operating Manual) and
 *                  every Context kind is now a real per-item picker; `false` is reserved
 *                  for any future kind that lacks a scoped available feed, which would
 *                  surface as a labelled, explained placeholder rather than inventing a
 *                  grant channel that doesn't exist server-side.
 *
 * PURE + client-safe — the SimpleBuilder UI and the unit tests share this ONE list.
 */
import type { Grants } from './system-schema.ts';

/** A section of the grant panel. */
export type ResourceSection = 'plan' | 'context';

/** The `system.grants` id-list keys a member's grants can land in. */
export type GrantField = keyof Pick<Grants, 'data' | 'knowledge' | 'metrics' | 'connections' | 'files' | 'plan'>;

/** The `…/grants/available?kind=` feed a member browses. */
export type FeedKind =
  | 'data' | 'knowledge' | 'files' | 'connections' | 'metric'
  | 'operating-manual' | 'strategy' | 'big-bets';

export type ResourceMember = {
  /** Stable key — used in UI state + tests. */
  key: string;
  /** The plain noun shown as the group heading (also the `scopeLabel` noun). */
  label: string;
  section: ResourceSection;
  /** True when the builder can actually grant per-item access for this member. */
  wireable: boolean;
  /** Present only when wireable — the grant list + browse feed it uses. */
  field?: GrantField;
  feedKind?: FeedKind;
  /**
   * For Knowledge vs Workflows — both draw from the `knowledge` feed but each shows
   * only its OWN item family (workflows are `wf_…`, knowledge docs everything else).
   * `undefined` ⇒ show every item of `feedKind`.
   */
  idFamily?: 'workflow' | 'knowledge';
  /** Shown when the member is a non-wireable placeholder — why it isn't grantable yet. */
  note?: string;
};

/** True when an id from the shared knowledge feed is a WORKFLOW (`wf_…`). */
export function isWorkflowId(id: string): boolean {
  return id.startsWith('wf_');
}

/**
 * The ordered members of both sections. Data · Knowledge · Files · Connections ·
 * Metrics are wireable (they already have grant lists + available feeds). Workflows is
 * wireable via the shared knowledge feed, filtered to `wf_…` ids. The three Plan-item
 * kinds are all wireable through the ONE `plan` grant list, each with its own available
 * feed: Operating Manual (`operating-manual` feed → `get_operating_manual`), Strategy
 * (`strategy` feed → `get_pillar`) and Big Bets (`big-bets` feed → `get_big_bet`). A
 * granted plan item is loaded at run time via its governed read tool, RLS/DLS-checked
 * as the caller in-store — read-only, never widening.
 */
export const RESOURCE_MEMBERS: ResourceMember[] = [
  // ① Plan Items
  {
    key: 'strategy', label: 'Strategy', section: 'plan', wireable: true,
    field: 'plan', feedKind: 'strategy',
  },
  {
    key: 'bigbets', label: 'Big Bets', section: 'plan', wireable: true,
    field: 'plan', feedKind: 'big-bets',
  },
  {
    key: 'operating-manual', label: 'Operating Manual', section: 'plan', wireable: true,
    field: 'plan', feedKind: 'operating-manual',
  },
  {
    key: 'workflows', label: 'Workflows', section: 'plan', wireable: true,
    field: 'knowledge', feedKind: 'knowledge', idFamily: 'workflow',
  },

  // ② Context
  {
    key: 'knowledge', label: 'Knowledge', section: 'context', wireable: true,
    field: 'knowledge', feedKind: 'knowledge', idFamily: 'knowledge',
  },
  { key: 'files', label: 'Files', section: 'context', wireable: true, field: 'files', feedKind: 'files' },
  { key: 'data', label: 'Data', section: 'context', wireable: true, field: 'data', feedKind: 'data' },
  { key: 'connections', label: 'Connections', section: 'context', wireable: true, field: 'connections', feedKind: 'connections' },
  { key: 'metrics', label: 'Metrics', section: 'context', wireable: true, field: 'metrics', feedKind: 'metric' },
];

/** The members of one section, in order. */
export function membersOf(section: ResourceSection): ResourceMember[] {
  return RESOURCE_MEMBERS.filter((m) => m.section === section);
}

/** The two sections with their display titles (for the panel headings). */
export const RESOURCE_SECTIONS: { key: ResourceSection; title: string }[] = [
  { key: 'plan', title: 'Plan Items' },
  { key: 'context', title: 'Context' },
];
