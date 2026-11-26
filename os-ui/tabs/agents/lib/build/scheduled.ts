/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { liveDomains, type CurrentUser } from '@core/kernel/auth';
import { getPublicUser } from '@tabs/admin/lib/users';
import { autonomousAgentsEnabled, ensureHydrated as ensureSettingsHydrated } from '@tabs/admin/lib/settings';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { unmappedGrantNames } from '@tabs/agents/lib/build/os-tools';
import { newRunId } from '@tabs/agents/lib/store';
import type { StartedRunReport, StartRunInput } from '@tabs/agents/lib/build/run-jobs-server';

/** The record the in-cluster scheduler reads (unscoped, no human session). */
export type SchedulerSystem = { yaml: string; owner: string; disabledAgents: string[] };

/** Injection seam for tests; every field defaults to the live implementation. */
export type ScheduledDeps = {
  /** Stored owner id → live governed principal, or null if unresolvable. */
  resolveOwner?: (ownerId: string) => Promise<CurrentUser | null>;
  /** A4: the ONE queued start door. Default: `startQueuedRun`. */
  startQueuedRun?: (input: StartRunInput) => Promise<StartedRunReport>;
  /** The platform autonomous-execution gate (default: live setting). Injected for tests. */
  autonomousEnabled?: () => boolean;
};

/** The system as the durable mirror holds it NOW (`store.readScheduleFresh`). */
export type FreshScheduleRead =
  | { state: 'found'; system: { id: string; schedule: { kind: string; cron?: string }; archived: boolean } }
  | { state: 'absent' }
  | { state: 'unreachable' };

/**
 * THE AUTHORITATIVE GUARD for an unattended firing (review R-1). Whatever CronJob fired — a stale
 * one an older pod left, one a resync resurrected from a stale registry, or the chart's static
 * schedule — the receiver decides from the system read FRESH from the mirror:
 *   - unreachable → 503 (nothing can be concluded; never run on a guess);
 *   - absent      → 404;
 *   - archived    → 409 (the owner stopped it);
 *   - an os-ui-provisioned CronJob (`source === 'os-ui'`) whose cron is no longer the stored cron
 *     schedule (cleared, switched to manual/event, or edited) → 409.
 * The chart's static `agentRuntime.schedules` send no marker and are not schedule-checked: their
 * schedule lives in the chart values, not on the system.
 */
export function scheduledRunGate(
  fresh: FreshScheduleRead,
  marker: { source: string | null; cron: string | null },
): { ok: true } | { ok: false; status: number; error: string } {
  if (fresh.state === 'unreachable') return { ok: false, status: 503, error: 'Scheduled run refused: the system could not be read from the durable store — nothing was run.' };
  if (fresh.state === 'absent') return { ok: false, status: 404, error: 'system not found' };
  const sys = fresh.system;
  if (sys.archived) return { ok: false, status: 409, error: `Scheduled run refused: system ${sys.id} is archived.` };
  if (marker.source === 'os-ui') {
    const stored = sys.schedule.kind === 'cron' ? (sys.schedule.cron ?? '').trim() : null;
    const fired = (marker.cron ?? '').trim();
    if (stored === null) return { ok: false, status: 409, error: `Scheduled run refused: system ${sys.id} is no longer on a cron schedule (stored: ${sys.schedule.kind}).` };
    if (stored !== fired) return { ok: false, status: 409, error: `Scheduled run refused: the firing CronJob's cron "${fired}" is not the stored schedule "${stored}" of system ${sys.id}.` };
  }
  return { ok: true };
}

/** A discriminated outcome so the route stays a thin status/JSON translator. */
export type ScheduledOutcome =
  | { ok: true; report: unknown }
  | { ok: false; status: number; error: string };

/**
 * Resolve a stored owner id to the LIVE delegated identity, or null if the owner
 * no longer exists, is disabled, or has not completed first-run setup. This is the
 * SAME resolution `resolveMcpUser` applies (lib/mcp/token.ts) — the role + domains
 * are read live at run time, so a demoted/archived owner's agent immediately loses
 * rights. It NEVER returns a fallback or service identity: an unresolvable owner is
 * null, and the caller must fail the run rather than downgrade to a service principal.
 */
export async function resolveOwner(
  ownerId: string,
  get: (id: string) => ReturnType<typeof getPublicUser> = getPublicUser,
): Promise<CurrentUser | null> {
  const u = await get(ownerId);
  if (!u || u.disabled || u.mustChangeCredentials) return null;
  // Headless (no browser cookie) ⇒ no active-domain narrowing: operate across all domains that
  // are still active. An archived domain is out of scope here exactly as in the cookie session.
  const domains = liveDomains(u.domains);
  return { id: u.id, name: u.name, domains, allDomains: domains, activeDomain: null, role: u.role };
}

/**
 * Run one scheduled/unattended invocation of a system with NO human session.
 *
 * The run goes onto the SAME run queue the UI and the MCP use, under the system OWNER's
 * resolved live identity — the agent's governed tool calls execute with exactly the owner's
 * role + domains (OPA / DLS / Trino-RLS under `user:<id>`), never a service principal, never
 * escalated. If the owner cannot be resolved (deleted / disabled / setup-incomplete) the run
 * fails cleanly (409) rather than falling back to a service identity or running ungoverned.
 *
 * A5: there is no second path. A system whose grants name tools with no governed MCP tool
 * behind them is refused here (400, naming them) instead of being handed to a Python runtime.
 */
export async function runScheduledSystem(
  systemId: string,
  rec: SchedulerSystem,
  prompt: string,
  deps: ScheduledDeps = {},
): Promise<ScheduledOutcome> {
  // PLATFORM GATE (fail-closed): unattended execution — cron + event/API triggers —
  // only runs when a platform admin has enabled autonomous agents. A human-clicked Run
  // uses the interactive route and never reaches here, so it is unaffected. The CronJob
  // keeps firing; each firing no-ops cleanly with this policy message until re-enabled.
  // Restore the persisted flag first (a redeployed pod must not silently revert to OFF
  // — or, worse, run because a stale in-memory default said ON).
  if (!deps.autonomousEnabled) await ensureSettingsHydrated();
  if (!(deps.autonomousEnabled ?? autonomousAgentsEnabled)()) {
    return {
      ok: false,
      status: 403,
      error:
        'Autonomous agent execution is disabled by platform policy. A scheduled or ' +
        'event/API trigger will not run until a platform admin enables autonomous agents ' +
        'in Admin → Platform Settings. (Running a system by hand is unaffected.)',
    };
  }

  const sys = parseSystem(rec.yaml);
  // PRE-FLIGHT (A5): a grant with no governed MCP tool behind it is a definition bug, not a
  // reason to run somewhere else. Name the offending tools and refuse.
  const unmapped = unmappedGrantNames(sys);
  if (unmapped.length > 0) {
    return {
      ok: false,
      status: 400,
      error:
        `Scheduled run refused: this system grants tool(s) with no governed MCP tool behind ` +
        `them: ${unmapped.join(', ')}. Fix the grants in system.yaml.`,
    };
  }

  const owner = await (deps.resolveOwner ?? resolveOwner)(rec.owner);
  if (!owner) {
    return {
      ok: false,
      status: 409,
      error:
        `Scheduled run refused: the system owner (${rec.owner}) could not be resolved ` +
        `to an active user. Governed scheduled runs act under the owner's identity and ` +
        `never fall back to a service principal.`,
    };
  }
  // S1: the builder-gate is re-asserted against the owner's LIVE role by the executor
  // (`prepareRunYaml` → `governYamlForOwner`), so a stale direct-write grant is neutralised to
  // held-for-approval when the owner is no longer builder+ — on this path as on every other.
  // Thread id = a fresh run id.
  const runId = newRunId();
  // A4: a scheduled run goes through the SAME queue as the UI, so it is not bound to this
  // request either — a 20-minute nightly run finishes in the worker.
  const start = deps.startQueuedRun ?? (await import('@tabs/agents/lib/build/run-jobs-server')).startQueuedRun;
  const out = await start({
    user: owner,
    systemId,
    // LIFECYCLE (review M-3): a SCHEDULE runs the pinned definition, so its model calls carry
    // env:run and its Langfuse trace environment is `run` — never `studio`, which would attribute
    // production spend to a draft and cap it at the draft's smaller budget share.
    env: 'run',
    domain: sys.system.domain,
    messages: [{ role: 'user', content: prompt }],
    prompt,
    runId,
    // Recorded on the job row (`input.trigger`), so ops can tell a scheduled run from a click.
    trigger: 'schedule',
  });
  if (out.error) return { ok: false, status: out.error.status ?? 500, error: out.error.message };
  if (!out.body) {
    return { ok: true, report: { mode: 'live', engine: 'langgraph', runId, queued: true, team: true, note: 'filed on the run queue — the worker is executing it' } };
  }
  const b = out.body;
  return {
    ok: true,
    report: {
      mode: 'live',
      engine: 'langgraph',
      runId: b.runId ?? runId,
      checkpointer: b.checkpointer,
      // How the scheduled run ended — a run whose agent failed says `failed`, with the reason.
      status: b.status,
      failed: b.failed === true,
      ...(b.failure ? { failedNode: b.failure.node ?? undefined, failureReason: b.failure.reason } : {}),
      reachedEnd: b.reachedEnd,
      parked: b.parked,
      team: true,
      path: b.path,
      finalText: b.finalText,
      // A scheduled run saves its declared outputs like any other run (the same executor);
      // the schedule's report says where each went, or that one was not saved.
      outputs: b.outputs ?? [],
      completedWithUnsavedOutputs: b.completedWithUnsavedOutputs === true,
      nodes: b.nodes.map((r) => ({ node: r.node, model: r.model, steps: r.steps.map((x) => ({ tool: x.tool, isError: x.isError })) })),
    },
  };
}
