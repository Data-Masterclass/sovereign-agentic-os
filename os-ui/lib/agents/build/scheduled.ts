/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CurrentUser } from '@/lib/auth';
import { getPublicUser } from '@/lib/users';
import { parseSystem } from '../system-schema.ts';
import { isAgenticOsTeam } from './os-tools.ts';
import { runOsTeam } from './agentic-graph-server.ts';
import { runSystem } from './server.ts';

/** The record the in-cluster scheduler reads (unscoped, no human session). */
export type SchedulerSystem = { yaml: string; owner: string; disabledAgents: string[] };

/** Injection seam for tests; every field defaults to the live implementation. */
export type ScheduledDeps = {
  /** Stored owner id → live governed principal, or null if unresolvable. */
  resolveOwner?: (ownerId: string) => Promise<CurrentUser | null>;
  runOsTeam?: typeof runOsTeam;
  runSystem?: typeof runSystem;
};

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
  return { id: u.id, name: u.name, domains: u.domains, role: u.role };
}

/**
 * Run one scheduled/unattended invocation of a system with NO human session.
 *
 * An agentic-os LangGraph team (`isAgenticOsTeam`) runs LIVE, in-process, under the
 * system OWNER's resolved live identity — the agent's governed tool calls execute
 * with exactly the owner's role + domains (OPA / DLS / Trino-RLS under `user:<id>`),
 * never a service principal, never escalated. If the owner cannot be resolved
 * (deleted / disabled / setup-incomplete) the run fails cleanly (409) rather than
 * falling back to a service identity or running ungoverned.
 *
 * Hermes / unmapped-legacy systems keep the existing `runSystem` fallback path
 * (attributed to 'scheduler'), which has no per-tool user identity to thread.
 */
export async function runScheduledSystem(
  systemId: string,
  rec: SchedulerSystem,
  prompt: string,
  deps: ScheduledDeps = {},
): Promise<ScheduledOutcome> {
  const sys = parseSystem(rec.yaml);

  if (isAgenticOsTeam(sys)) {
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
    const run = deps.runOsTeam ?? runOsTeam;
    const team = await run({
      user: owner,
      yaml: rec.yaml,
      systemId,
      messages: [{ role: 'user', content: prompt }],
      disabledAgents: rec.disabledAgents,
    });
    return {
      ok: true,
      report: {
        mode: 'live',
        team: true,
        path: team.path,
        finalText: team.finalText,
        nodes: team.runs.map((r) => ({
          node: r.node,
          model: r.model,
          steps: r.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
        })),
      },
    };
  }

  const run = deps.runSystem ?? runSystem;
  const report = await run(systemId, rec.yaml, {
    prompt,
    requestedBy: 'scheduler',
    disabledAgents: rec.disabledAgents,
  });
  return { ok: true, report };
}
