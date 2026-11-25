/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Delete a whole domain — the engine: plan (dry run, the default), backup gate,
 *             ordered, audited, stop-on-first-failure, resumable run
 * USER STORY: As the tenant admin I want to remove a domain and everything in it — every
 *             owner's artifacts, its tables, its repo, its grants, its gateway team — after
 *             reading exactly what will go and what will be KEPT because another domain still
 *             maps to it, and I want a half-finished run to finish when I run it again.
 * ARCHITECTURE:
 *   - CONTRACT IN THE KERNEL, IMPLEMENTATION IN THE TABS (the `core/kernel/reindex.ts` split). A
 *     tab may not import another tab and the kernel may not import a tab, so every component
 *     that holds domain state ships a {@link DomainDeleteComponent} from its own tab, and the two
 *     doors (the Admin route and the `delete_domain` MCP tool) hand the list in. This module
 *     never knows which tabs exist.
 *   - EACH COMPONENT REMOVES THROUGH ITS OWN DOCUMENTED TOOL: a store's own delete function, Trino
 *     `DROP TABLE`, OPA's Data API `DELETE`, LiteLLM `/team/delete` and `/key/delete`, the
 *     Kubernetes API. Nothing here re-implements a removal; it only orders, gates and audits.
 *   - IDEMPOTENT BY CONSTRUCTION. Every run re-plans from the components' CURRENT state, so what
 *     a partial run already removed is simply no longer in the plan; re-running finishes it. A
 *     component's `remove` must treat an already-absent object as done.
 *   - STOP AND REPORT. The first failing step ends the run: it is audited as `error`, the report
 *     names it and lists what is left. There is no skip and no "best effort".
 *   - THE PLAN IS THE PROMISE. `keep` lists every object a component deliberately leaves because
 *     something outside the domain still maps to it (a non-deleted dataset — archived included —
 *     another domain's schema). A run removes exactly the plan's `remove` items, in order.
 */
import { roleAtLeast, type Role } from '@core/kernel/session';

export type DomainDeleteActor = { id: string; role: Role; domains: string[] };

/** One object a component will remove. `id` is what its own `remove` needs back. */
export type PlanItem = {
  component: string;
  kind: string;
  id: string;
  label: string;
  owner?: string;
  detail?: string;
};

/** One object a component will deliberately NOT remove, and why. */
export type KeptItem = PlanItem & { reason: string };

export type ComponentPlan = {
  component: string;
  remove: PlanItem[];
  keep: KeptItem[];
  /** Objects of the domain this OS cannot remove yet (no documented delete path). Any blocked
   *  object refuses the run: the plan shows them, nothing pretends they are gone. */
  blocked?: KeptItem[];
};

export type PlanContext = { domainId: string; actor: DomainDeleteActor };

/** The audit sink the engine writes every step to (the platform audit log in production). */
export type AuditFn = (entry: {
  action: string;
  target: string;
  detail: string;
  result: 'ok' | 'error' | 'denied';
  data?: Record<string, unknown>;
}) => void;

export type DomainDeleteComponent = {
  /** Stable name, e.g. `os.datasets`, `trino`, `opa`, `litellm`. */
  component: string;
  /** Read-only: what this component holds for the domain, now. */
  plan(ctx: PlanContext): Promise<ComponentPlan>;
  /** Remove ONE planned item through the component's own tool. Throws on failure; an already
   *  absent object is success. Returns a short evidence line for the audit entry. */
  remove(item: PlanItem, ctx: PlanContext): Promise<string | void>;
};

/** What the backup gate found. `at` is the newest completed backup that covers the delete. */
export type BackupEvidence = { ok: true; name: string; at: string } | { ok: false; reason: string };
export type BackupCheck = () => Promise<BackupEvidence>;

export const BACKUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type DomainDeletePlan = {
  domainId: string;
  dryRun: boolean;
  components: ComponentPlan[];
  totals: { remove: number; keep: number; blocked: number; byComponent: Record<string, { remove: number; keep: number; blocked: number }> };
};

export type StepResult = { component: string; kind: string; id: string; label: string; evidence: string };

export type DomainDeleteReport =
  | { status: 'planned'; plan: DomainDeletePlan }
  | { status: 'refused'; reason: string; plan: DomainDeletePlan }
  | { status: 'done'; plan: DomainDeletePlan; done: StepResult[]; backup: string }
  | {
      status: 'failed';
      plan: DomainDeletePlan;
      done: StepResult[];
      failed: { component: string; kind: string; id: string; label: string; error: string };
      remaining: PlanItem[];
      backup: string;
    };

export type DomainDeleteOptions = {
  /** Default TRUE: nothing is written unless the caller passes `dryRun: false`. */
  dryRun?: boolean;
  /** The operator's explicit statement that a backup exists, overriding the 2 h check. */
  iHaveABackup?: boolean;
  /** The typed confirmation; must equal the domain id for a run. */
  confirm?: string;
};

function err(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** The engine's own pseudo-component that carries the delete-window block in a plan. */
export const DELETE_WINDOW_COMPONENT = 'delete-window';

/**
 * The domain's own bookkeeping — every domain has it, empty or not: its registry record, its
 * members' memberships, its policy (OPA) entries and its gateway (LiteLLM) team and keys. Removing
 * these is not removing an artifact, so they do not count towards the delete window. Every other
 * component's `remove` (datasets, Trino objects, files, knowledge, connections, metrics,
 * dashboards, agents, apps, folders, approvals, the git repo, …) does.
 */
export const DOMAIN_BOOKKEEPING_COMPONENTS: ReadonlySet<string> = new Set(['domain', 'users', 'opa', 'litellm']);

/** How many artifacts a plan would remove (bookkeeping excluded). */
export function artifactRemovals(plans: Pick<ComponentPlan, 'component' | 'remove'>[]): number {
  return plans.reduce((n, p) => n + (DOMAIN_BOOKKEEPING_COMPONENTS.has(p.component) ? 0 : p.remove.length), 0);
}

/** Ask every component what it holds, in order. A component whose plan fails fails the plan:
 *  a partial plan would let a run "finish" while state is left behind.
 *
 *  THE DELETE WINDOW (`opts.windowOpen`, chart `polaris.purge.enabled`): while it is closed, a
 *  plan that would remove ANY artifact of the domain carries ONE block — only a truly empty
 *  domain (bookkeeping only) is deletable without the window. Omitted = not checked (a plan-only
 *  caller); `deleteDomain` always passes it. */
export async function planDomainDelete(
  components: DomainDeleteComponent[],
  ctx: PlanContext,
  dryRun = true,
  opts: { windowOpen?: () => boolean } = {},
): Promise<DomainDeletePlan> {
  const plans: ComponentPlan[] = [];
  for (const c of components) {
    let p: ComponentPlan;
    try {
      p = await c.plan(ctx);
    } catch (e) {
      throw err(`Planning ${c.component} failed: ${(e as Error).message}`, (e as { status?: number }).status ?? 502);
    }
    plans.push({ component: c.component, remove: p.remove, keep: p.keep, blocked: p.blocked ?? [] });
  }
  const artifacts = artifactRemovals(plans);
  if (opts.windowOpen && artifacts > 0 && !opts.windowOpen()) {
    const reason = `delete window closed — ${artifacts} item${artifacts === 1 ? '' : 's'} would be removed. Open it for an announced delete window (chart polaris.purge.enabled=true), run the delete, then close it again. Only an empty domain is deletable without it.`;
    plans.push({ component: DELETE_WINDOW_COMPONENT, remove: [], keep: [], blocked: [{ component: DELETE_WINDOW_COMPONENT, kind: 'delete-window', id: DELETE_WINDOW_COMPONENT, label: 'Delete window', reason }] });
  }
  const byComponent: Record<string, { remove: number; keep: number; blocked: number }> = {};
  for (const p of plans) byComponent[p.component] = { remove: p.remove.length, keep: p.keep.length, blocked: p.blocked?.length ?? 0 };
  return {
    domainId: ctx.domainId,
    dryRun,
    components: plans,
    totals: {
      remove: plans.reduce((n, p) => n + p.remove.length, 0),
      keep: plans.reduce((n, p) => n + p.keep.length, 0),
      blocked: plans.reduce((n, p) => n + (p.blocked?.length ?? 0), 0),
      byComponent,
    },
  };
}

/** The backup gate: a completed backup newer than 2 h, or the operator's explicit flag. */
export async function checkBackup(check: BackupCheck, iHaveABackup: boolean, now = Date.now()): Promise<{ ok: true; evidence: string } | { ok: false; reason: string }> {
  if (iHaveABackup) return { ok: true, evidence: 'operator stated a backup exists (--i-have-a-backup)' };
  const b = await check();
  if (!b.ok) return { ok: false, reason: `No backup could be confirmed: ${b.reason}. Take one, or pass --i-have-a-backup.` };
  const age = now - Date.parse(b.at);
  if (!Number.isFinite(age) || age > BACKUP_MAX_AGE_MS) {
    return { ok: false, reason: `The newest backup (${b.name}, ${b.at}) is older than 2 hours. Take a fresh one, or pass --i-have-a-backup.` };
  }
  return { ok: true, evidence: `backup ${b.name} completed ${b.at}` };
}

/**
 * Delete a domain. Admin only. A dry run (the default) returns the plan and writes nothing but
 * one audit entry. A run needs the typed confirmation and the backup gate, then removes the
 * plan's items component by component, auditing every step, and stops at the first failure.
 */
export async function deleteDomain(
  domainId: string,
  opts: DomainDeleteOptions,
  deps: {
    actor: DomainDeleteActor;
    components: DomainDeleteComponent[];
    audit: AuditFn;
    backup: BackupCheck;
    /** Throws (400/404) unless `domainId` is a registered, non-reserved domain. */
    validateTarget?: (domainId: string) => Promise<void>;
    /** False for a door that may only PLAN (the MCP tool): a run is then refused. */
    allowRun?: boolean;
    /** Run-only preconditions of the deployment (e.g. the query-tool build): a reason refuses. */
    preflight?: () => Promise<string | null>;
    /** Is the delete window open (chart `polaris.purge.enabled`)? Required: a domain holding any
     *  artifact is refused while it is closed (see `planDomainDelete`). */
    deleteWindow: () => boolean;
  },
): Promise<DomainDeleteReport> {
  const { actor, components, audit } = deps;
  const id = (domainId ?? '').trim();
  const target = `domain:${id}`;
  if (!roleAtLeast(actor.role, 'admin')) {
    audit({ action: 'domain.delete', target, detail: 'Refused: deleting a domain requires an admin', result: 'denied' });
    throw err('Deleting a domain requires an admin', 403);
  }
  if (!id) throw err('A domain id is required', 400);
  const dryRun = opts.dryRun !== false;
  if (!dryRun && deps.allowRun === false) {
    audit({ action: 'domain.delete', target, detail: 'Refused: this door may only plan; a run needs Admin → Domains in a signed-in session', result: 'denied' });
    throw err('This door may only plan (dry run). Run the delete from Admin → Domains, signed in, with the typed confirmation.', 403);
  }
  if (deps.validateTarget) {
    try {
      await deps.validateTarget(id);
    } catch (e) {
      audit({ action: 'domain.delete', target, detail: `Refused: ${(e as Error).message}`, result: 'denied' });
      throw e;
    }
  }
  const ctx: PlanContext = { domainId: id, actor };
  const plan = await planDomainDelete(components, ctx, dryRun, { windowOpen: deps.deleteWindow });

  if (dryRun) {
    audit({ action: 'domain.delete.plan', target, detail: `Dry run: ${plan.totals.remove} to remove, ${plan.totals.keep} kept, ${plan.totals.blocked} blocked`, result: 'ok', data: { byComponent: plan.totals.byComponent } });
    return { status: 'planned', plan };
  }
  if ((opts.confirm ?? '').trim() !== id) {
    const reason = `Type the domain id "${id}" to confirm.`;
    audit({ action: 'domain.delete', target, detail: `Refused: ${reason}`, result: 'denied' });
    return { status: 'refused', reason, plan };
  }
  if (plan.totals.blocked > 0) {
    const kinds = [...new Set(plan.components.flatMap((p) => (p.blocked ?? []).map((b) => `${p.component}/${b.kind}`)))];
    const reason = `${plan.totals.blocked} object(s) have no delete path yet (${kinds.join(', ')}); nothing was removed.`;
    audit({ action: 'domain.delete', target, detail: `Refused: ${reason}`, result: 'denied' });
    return { status: 'refused', reason, plan };
  }
  if (deps.preflight) {
    const why = await deps.preflight();
    if (why) {
      audit({ action: 'domain.delete', target, detail: `Refused: ${why}`, result: 'denied' });
      return { status: 'refused', reason: why, plan };
    }
  }
  const gate = await checkBackup(deps.backup, opts.iHaveABackup === true);
  if (!gate.ok) {
    audit({ action: 'domain.delete', target, detail: `Refused: ${gate.reason}`, result: 'denied' });
    return { status: 'refused', reason: gate.reason, plan };
  }

  audit({ action: 'domain.delete.start', target, detail: `Deleting: ${plan.totals.remove} objects, ${plan.totals.keep} kept; ${gate.evidence}`, result: 'ok', data: { byComponent: plan.totals.byComponent } });
  const done: StepResult[] = [];
  const all = plan.components.flatMap((p) => p.remove);
  for (const c of components) {
    const p = plan.components.find((x) => x.component === c.component)!;
    for (const item of p.remove) {
      const stepTarget = `${item.component}:${item.kind}:${item.id}`;
      try {
        const evidence = (await c.remove(item, ctx)) || 'removed';
        done.push({ component: item.component, kind: item.kind, id: item.id, label: item.label, evidence });
        audit({ action: 'domain.delete.step', target: stepTarget, detail: `${item.label}: ${evidence}`, result: 'ok', data: { domain: id } });
      } catch (e) {
        const error = (e as Error).message || String(e);
        audit({ action: 'domain.delete.step', target: stepTarget, detail: `${item.label}: FAILED ${error}`, result: 'error', data: { domain: id } });
        audit({ action: 'domain.delete', target, detail: `Stopped at ${stepTarget}: ${error}. ${done.length} removed, ${all.length - done.length} left; re-run to resume.`, result: 'error' });
        const doneKeys = new Set(done.map((d) => `${d.component}|${d.kind}|${d.id}`));
        return {
          status: 'failed',
          plan,
          done,
          failed: { component: item.component, kind: item.kind, id: item.id, label: item.label, error },
          remaining: all.filter((x) => !doneKeys.has(`${x.component}|${x.kind}|${x.id}`)),
          backup: gate.evidence,
        };
      }
    }
  }
  audit({ action: 'domain.delete', target, detail: `Deleted domain "${id}": ${done.length} objects removed, ${plan.totals.keep} kept`, result: 'ok', data: { byComponent: plan.totals.byComponent } });
  return { status: 'done', plan, done, backup: gate.evidence };
}

/** A plan as plain text lines — what the dry run prints and the report quotes. */
export function planLines(plan: DomainDeletePlan): string[] {
  const out: string[] = [`Domain "${plan.domainId}": ${plan.totals.remove} to remove, ${plan.totals.keep} kept.`];
  for (const p of plan.components) {
    const nb = p.blocked?.length ?? 0;
    if (!p.remove.length && !p.keep.length && !nb) continue;
    out.push(`${p.component}: remove ${p.remove.length}${p.keep.length ? `, keep ${p.keep.length}` : ''}${nb ? `, blocked ${nb}` : ''}`);
    for (const k of p.keep) out.push(`  KEEP ${k.kind} ${k.label} — ${k.reason}`);
    for (const b of p.blocked ?? []) out.push(`  BLOCKED ${b.kind} ${b.label} — ${b.reason}`);
  }
  return out;
}

// ---------------------------------------------------------------------------- the wiring --
/** The component list is assembled OUTSIDE core and tabs (`domain-delete-sources.ts`, registered
 *  by `instrumentation.ts`): the one place allowed to know every tab. Both doors read it here. */
export type DomainDeleteWiring = {
  components: () => DomainDeleteComponent[];
  backup: BackupCheck;
  validateTarget: (domainId: string) => Promise<void>;
  preflight: () => Promise<string | null>;
  /** Is the delete window open? (config `domainDeleteWindowOpen`, chart `polaris.purge.enabled`) */
  deleteWindow: () => boolean;
  /** The platform audit log, bound to the acting admin. */
  audit: (actor: { id: string; role: Role }) => AuditFn;
};
const WIRING = Symbol.for('soa.domain-delete.wiring');
export function registerDomainDeleteWiring(w: DomainDeleteWiring): void {
  (globalThis as unknown as Record<symbol, DomainDeleteWiring>)[WIRING] = w;
}
export function domainDeleteWiring(): DomainDeleteWiring {
  const w = (globalThis as unknown as Record<symbol, DomainDeleteWiring | undefined>)[WIRING];
  if (!w) throw err('Delete domain is not wired in this process (instrumentation did not register it)', 409);
  return w;
}
