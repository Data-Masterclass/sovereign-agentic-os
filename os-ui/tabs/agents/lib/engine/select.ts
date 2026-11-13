/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Engine selection — which executor runs THIS agent system
 * USER STORY: As a builder I want one system to be able to opt out of the platform's default
 *             engine (pin the known-good walker) while the LangGraph rebuild is rolled out, and
 *             as an operator I want every run path (route, scheduled run, MCP tool) to make that
 *             decision through the same pure function so none of them can disagree.
 * ARCHITECTURE:
 *   - Pure and tiny: (platform config, system) → engine. No env access, no I/O; the kernel owns
 *     the default (`core/kernel/agents-engine.ts`), this module owns the per-system override.
 *   - The override rides on the EXISTING `runtime` key of system.yaml (no new key, byte-stable
 *     files): `runtime: walker` pins the legacy walker; `runtime: hermes` is not an in-process
 *     engine at all (it keeps the legacy fallback path, reported here as `walker`); the default
 *     `langgraph` follows the platform flag. An explicit `runtime: langgraph` is indistinguishable
 *     from the default because the serializer omits it — so the per-system override is opt-OUT
 *     only (see the plan's deviations log).
 *   - Consumed by app/api/agents/systems/[id]/run/route.ts, build/scheduled.ts and the MCP tool
 *     `run_agent_system`; Phase A1 adds the `langgraph` branch at those three sites.
 */
import type { AgentsEngine } from '@core/kernel/agents-engine';
import type { System } from '@tabs/agents/lib/system-schema';

/** The slice of `config` the selector reads — structural so tests need no real config. */
export type EngineConfig = { agentsEngine: AgentsEngine };

/**
 * Decide the engine for one system. `runtime: walker` and `runtime: hermes` both resolve to
 * the walker (the former is the explicit opt-out, the latter never runs in-process); the
 * default `langgraph` runtime follows the platform flag.
 */
export function selectEngine(cfg: EngineConfig, sys: Pick<System, 'runtime'>): AgentsEngine {
  if (sys.runtime === 'walker' || sys.runtime === 'hermes') return 'walker';
  return cfg.agentsEngine;
}

/** The selection plus the one-line reason — for run reports and the drill-down. */
export function explainEngine(cfg: EngineConfig, sys: Pick<System, 'runtime'>): { engine: AgentsEngine; reason: string } {
  if (sys.runtime === 'walker') return { engine: 'walker', reason: 'system.yaml pins runtime: walker' };
  if (sys.runtime === 'hermes') return { engine: 'walker', reason: 'hermes runtime never runs in-process; legacy path' };
  return { engine: cfg.agentsEngine, reason: `platform default (AGENTS_ENGINE=${cfg.agentsEngine})` };
}
