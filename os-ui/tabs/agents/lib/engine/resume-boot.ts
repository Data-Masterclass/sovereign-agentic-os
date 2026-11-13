/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Boot registration — the Agents tab plugs its resume into the Governance decide() hook
 * USER STORY: As the platform I want "approve in Governance → the parked run continues" to work from
 *             every front door (inbox route, MCP `decide_approval`) without `core/policy` knowing the
 *             Agents tab exists.
 * ARCHITECTURE:
 *   - Imported once at os-ui boot (`instrumentation.ts`). `registerResumeHook()` is idempotent
 *     (globalThis-pinned) and wires the REAL deps into `resumeAfterDecision`: `principalById`
 *     (live user), the MCP registry's role floor (`ALL_MCP_TOOLS` + `roleCanUse`), the run service
 *     (`enqueueResumeAfterDecision`, which files a `resume` job the worker — or, inline, this
 *     process — executes as the live runner) and `recordResume`. Mirrors `core/folders/adapters.ts`: a registration, not an import.
 */
import 'server-only';
import { onDecided, recordResume } from '@core/policy/approvals';
import { principalById } from '@core/kernel/auth';
import { ALL_MCP_TOOLS, roleCanUse } from '@core/mcp/server';
import type { Role } from '@core/kernel/session';
import { resumeAfterDecision, type ResumeDeps } from '@tabs/agents/lib/engine/resume';
import { enqueueResumeAfterDecision } from '@tabs/agents/lib/build/run-jobs-server';

const KEY = Symbol.for('soa.agents.resume-hook-registered');

/** True when `role` clears the registry role floor of `tool` (an unknown tool is never permitted). */
export function toolPermittedForRole(role: Role, tool: string): boolean {
  const t = ALL_MCP_TOOLS.find((x) => x.name === tool);
  return !!t && roleCanUse(role, t.minRole);
}

/** The production deps for {@link resumeAfterDecision}. */
export function productionResumeDeps(): ResumeDeps {
  return {
    loadPrincipal: principalById,
    toolPermitted: toolPermittedForRole,
    resumeRun: enqueueResumeAfterDecision,
    markResume: (id, r) => { recordResume(id, r); },
  };
}

/** Register once per process. Returns the unregister function (tests). */
export function registerResumeHook(deps: ResumeDeps = productionResumeDeps()): () => void {
  const g = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  if (g[KEY]) return g[KEY]!;
  const off = onDecided(async (approval, decision) => {
    await resumeAfterDecision(approval, decision, deps);
  });
  const unregister = () => { off(); delete g[KEY]; };
  g[KEY] = unregister;
  return unregister;
}
