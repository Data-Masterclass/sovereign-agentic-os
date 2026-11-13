/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The agent ENGINE flag — which executor runs an agent system
 * USER STORY: As a platform operator I want to switch the Agents tab between the hand-rolled
 *             walker and the LangGraph engine with one env var (AGENTS_ENGINE) while the engine
 *             rebuild is in progress, and I want a mistyped value to fall back to the known-good
 *             walker rather than to an engine that may not exist yet.
 * ARCHITECTURE:
 *   - Pure: a closed union + one parser. No env access here — `core/kernel/config.ts` reads
 *     AGENTS_ENGINE once and passes the raw string in, so the parse is unit-testable.
 *   - The platform DEFAULT lives here (kernel); the per-system choice (the `runtime` key of
 *     system.yaml) is resolved by the owning tab in `tabs/agents/lib/engine/select.ts`. The
 *     kernel never imports a tab, so the union is declared here and consumed there.
 *   - `walker` = `tabs/agents/lib/build/agentic-graph.ts` (today's deterministic IR walk);
 *     `langgraph` = the real StateGraph engine (Phase A1 of the engine rebuild plan). The default
 *     flips to `langgraph` only in the deletion phase (A5), after the parity tests pass.
 */

export type AgentsEngine = 'walker' | 'langgraph';

export const AGENTS_ENGINES: readonly AgentsEngine[] = ['walker', 'langgraph'];

/** The platform default until Phase A5 flips it (see docs/superpowers/plans/2026-11-13-engine-rebuild.md). */
export const DEFAULT_AGENTS_ENGINE: AgentsEngine = 'walker';

export function isAgentsEngine(v: unknown): v is AgentsEngine {
  return typeof v === 'string' && (AGENTS_ENGINES as readonly string[]).includes(v);
}

/**
 * Parse the AGENTS_ENGINE env value. Case-insensitive, whitespace-trimmed; anything that is not
 * a known engine (including unset/empty) yields {@link DEFAULT_AGENTS_ENGINE}. Falling back to
 * the walker is the SAFE direction: it is the engine every shipped system already runs on.
 */
export function parseAgentsEngine(raw: string | undefined): AgentsEngine {
  const v = (raw ?? '').trim().toLowerCase();
  return isAgentsEngine(v) ? v : DEFAULT_AGENTS_ENGINE;
}
