/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One-way reconcile, OS -> LiteLLM. Plan first, apply on request,
 *             and report drift without ever touching it.
 *
 * USER STORY: As a platform admin I see exactly what the OS would change in the
 *             gateway BEFORE anything is written, and I choose to apply it.
 *             As a platform admin, a LiteLLM rebuilt from empty is repopulated
 *             by one reconcile run, because the OS knows the domains and agents
 *             it governs.
 *             As a platform admin, what the OS creates shows up in LiteLLM's own
 *             UI with the same aliases, because the OS writes through LiteLLM's
 *             admin API rather than behind it.
 *             As a platform admin, something I made by hand in LiteLLM is listed
 *             as drift and left alone, so reconcile never deletes my work.
 *
 * ARCHITECTURE:
 *   Direction of truth: the OS owns identity (which domains and agents exist),
 *   LiteLLM owns enforcement and the ledger (budgets, spend, blocking). So this
 *   reconciler creates the SUBJECTS it can — a team per domain — and
 *   deliberately does NOT push budgets: a cap an admin set in LiteLLM is the
 *   real cap, and overwriting it from OS defaults would silently undo their work.
 *
 *   AGENT KEYS ARE NOT CREATED HERE ANY MORE. This reconciler used to create a key
 *   `agent-<id>` per agent system: alias and ownership stamp only — no budget, no
 *   model list — and it discarded the value LiteLLM returned, so nothing could ever
 *   call with it. It predates Build's per-system key (`os-<id>`), which IS the key a
 *   system's runs use: random value, budget, limits, model list, encrypted copy in
 *   the durable store (`core/infra/agent-system-keys.ts`). Two keys per system, one
 *   of them unbudgeted and unusable, was one too many. There is now ONE scheme —
 *   Build's — and a system that has no `os-<id>` key is listed under `needsBuild`
 *   ("press Build"), because only Build knows the models and caps and can store the
 *   value. The old `agent-<id>` keys are deleted by the key sweep
 *   (`core/infra/agent-system-key-sweep.ts`).
 *
 *   Three lists, and only two of them are ever applied:
 *     creates  subjects the OS governs that the gateway does not have yet
 *     updates  subjects whose OS-owned metadata has drifted (ownership stamps)
 *     drift    subjects the gateway has that the OS does not govern — REPORTED
 *              ONLY. Never created, never updated, never deleted. Deleting
 *              someone's hand-made key because the OS has no record of it is
 *              the worst thing a reconciler can do.
 *
 *   `planReconcile` is a read: it compares the gateway mirror against the OS.
 *   `applyReconcile` is the only write, and it writes through
 *   `core/infra/litellm-write.ts`, the single audited door. Every operation is
 *   attempted independently so one failure does not strand the rest, and
 *   failures come back as data.
 */
import 'server-only';
import { adminPost } from '@core/infra/litellm-write';
import { readMirror, type GatewayMirror } from '@tabs/admin/lib/gateway-mirror';

/** One intended change. `endpoint` + `payload` are exactly what would be sent. */
export type Op = {
  kind: 'team' | 'key';
  action: 'create' | 'update';
  /** The subject: a domain id, or an agent id. */
  id: string;
  /** Why this op exists, shown to the admin before they apply anything. */
  reason: string;
  endpoint: string;
  payload: Record<string, unknown>;
};

export type ReconcilePlan = {
  creates: Op[];
  updates: Op[];
  /** Exists in LiteLLM, not governed by the OS. REPORTED, never applied. */
  drift: Op[];
  /**
   * Agent systems with no key of their own at the gateway. NOT an op: reconcile cannot make the
   * key (Build does — it knows the models and caps and stores the value). Reported so an admin
   * sees which systems still need a Build before they can run.
   */
  needsBuild: string[];
  /** True when the mirror could not be read — the plan is then not trustworthy. */
  degraded: boolean;
};

/** The OS side: what this tenant actually governs. */
export type OsSubjects = { domains: string[]; agents: string[] };

const norm = (s: string) => s.trim().toLowerCase();

/** The alias convention. `ownerOf` in gateway-mirror reads these back. */
export const teamAlias = (domain: string) => domain;
/** The alias of an agent system's own key — the one Build mints (`principalFor` in the agents tab). */
export const agentKeyAlias = (agentId: string) => `os-${agentId}`;

/**
 * Compare the OS against the gateway. PURE, so the whole decision table is
 * testable without a network or a LiteLLM.
 */
export function buildPlan(mirror: GatewayMirror, os: OsSubjects): ReconcilePlan {
  const creates: Op[] = [];
  const updates: Op[] = [];
  const drift: Op[] = [];

  const teamByAlias = new Map(mirror.teams.map((t) => [norm(t.alias), t]));
  for (const domain of os.domains) {
    if (teamByAlias.has(norm(teamAlias(domain)))) continue;
    creates.push({
      kind: 'team', action: 'create', id: domain,
      reason: `Domain "${domain}" has no LiteLLM team, so its spend cannot be capped or attributed.`,
      endpoint: '/team/new',
      // No max_budget: budgets belong to whoever administers the gateway.
      payload: { team_alias: teamAlias(domain), metadata: { os_owner: 'domain', os_id: domain } },
    });
  }

  // Keys: reported, never created (see the header). A system without its `os-<id>` key needs a Build.
  const keyAliases = new Set(mirror.keys.map((k) => norm(k.alias)));
  const needsBuild = os.agents.filter((agent) => !keyAliases.has(norm(agentKeyAlias(agent))));

  for (const u of mirror.unmanaged) {
    drift.push({
      kind: u.kind, action: 'update', id: u.id,
      reason: `Exists in LiteLLM with no OS counterpart. Left untouched — adopt it in the OS or remove it in LiteLLM.`,
      endpoint: '(not applied)', payload: {},
    });
  }

  return { creates, updates, drift, needsBuild, degraded: mirror.degraded };
}

/** The OS subjects. Hydration happens upstream in `adminCtx`. */
async function osSubjects(): Promise<OsSubjects> {
  const [{ listDomains }, { listAllSystemsInternal }] = await Promise.all([
    import('@tabs/admin/lib/domains'),
    import('@tabs/agents/lib/store'),
  ]);
  return {
    domains: listDomains().filter((d) => !d.archived).map((d) => d.id),
    agents: listAllSystemsInternal().map((a) => a.id),
  };
}

/** What the OS would change in LiteLLM. Reads only; writes nothing. */
export async function planReconcile(): Promise<ReconcilePlan> {
  return buildPlan(await readMirror(), await osSubjects());
}

/**
 * Apply a plan's creates and updates. `drift` is ignored BY DESIGN — passing a
 * plan whose drift list is full must never delete anything.
 *
 * Each op is attempted independently: one gateway error must not strand the
 * remaining ops, and the caller needs to know precisely which ones failed.
 */
export async function applyReconcile(plan: ReconcilePlan): Promise<{ applied: number; failed: { op: Op; error: string }[] }> {
  const failed: { op: Op; error: string }[] = [];
  let applied = 0;
  for (const op of [...plan.creates, ...plan.updates]) {
    const res = await adminPost(op.endpoint, op.payload);
    if (res.ok) applied += 1;
    else failed.push({ op, error: res.error });
  }
  return { applied, failed };
}
