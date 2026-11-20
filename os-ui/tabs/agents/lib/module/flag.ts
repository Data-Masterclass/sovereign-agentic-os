/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53d — which domains run agent systems on their native LangGraph module
 * USER STORY: As the operator I want to switch the module path on for ONE domain (`test`) first,
 *             with every other domain unchanged, and widen it domain by domain.
 * ARCHITECTURE:
 *   - `AGENT_GRAPH_MODULE` is the master switch; `AGENT_GRAPH_MODULE_DOMAINS` (comma-separated)
 *     narrows it. Empty list ⇒ every domain (the flag's original global meaning).
 *   - Decides only what is NEW: a new run's engine and whether a domain's repo is generated in the
 *     module layout. A RESUME never asks this: it follows the engine stamped when the run started
 *     (`agent_module_runs`), so changing the allowlist never moves a parked run to the other engine.
 *   - Pure over its inputs (defaults read `config`), so os-ui, the worker and the tests share it.
 */
import { config } from '@core/kernel/config';

export function moduleEnabledFor(
  domain: string,
  opts: { enabled?: boolean; domains?: readonly string[] } = {},
): boolean {
  const enabled = opts.enabled ?? config.agentGraphModule;
  const domains = opts.domains ?? config.agentGraphModuleDomains;
  if (!enabled) return false;
  return domains.length === 0 || domains.includes(domain);
}

/**
 * The engine one run executes on. A NEW run: the module path iff the domain is enabled. A RESUME:
 * the engine the run STARTED on — a run with a module stamp resumes on the module, any other on
 * v1 — whatever the allowlist says now.
 */
export async function engineForRun(input: {
  resume: boolean;
  domain: string;
  runId: string;
  /** Does `agent_module_runs` hold a stamp for this run? */
  isModuleRun: (runId: string) => Promise<boolean>;
  enabled?: boolean;
  domains?: readonly string[];
}): Promise<'module' | 'v1'> {
  if (!(input.enabled ?? config.agentGraphModule)) return 'v1';
  if (input.resume) return (await input.isModuleRun(input.runId)) ? 'module' : 'v1';
  return moduleEnabledFor(input.domain, { enabled: input.enabled, domains: input.domains }) ? 'module' : 'v1';
}
