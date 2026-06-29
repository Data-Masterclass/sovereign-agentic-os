/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Model routing — by activity (LOCKED). The workspace default table maps each
 * activity to a LiteLLM tier, inherited by systems/agents with per-agent
 * overrides. Targets (stack-decisions Model strategy):
 *
 *   • light     → self-hosted Ministral 3 (Apache-2.0, in-box) — chat, coding,
 *                 tool-selection, light analysis.
 *   • reasoning → self-hosted Magistral Small 24B (`sovereign-reasoning`,
 *                 Apache-2.0, in-box, core-capped, zero per-token) — the SOVEREIGN
 *                 default for planning/deep reasoning. STACKIT Qwen is the explicit
 *                 fast alternative (`sovereign-reasoning-fast`) AND the fallback.
 *   • vision    → STACKIT Qwen3-VL — the rare vision/video need + failover.
 *
 * PURE module: editing the table writes LiteLLM routing config (the LiteLLM build
 * adapter), but no endpoint is ever hardcoded in the UI — a per-agent model is a
 * LiteLLM `model_name` picked live from `/model/info`; these tier defaults are the
 * install baseline only.
 */

export type Activity = 'planning' | 'coding' | 'text-writing' | 'tool-selection' | 'vision' | 'video';
export type Tier = 'light' | 'reasoning' | 'vision';

export const ACTIVITIES: Activity[] = ['planning', 'coding', 'text-writing', 'tool-selection', 'vision', 'video'];

/** Tier → default LiteLLM model_name (the install default; overridable). */
export const TIER_MODELS: Record<Tier, string> = {
  light: 'ministral-3',
  reasoning: 'sovereign-reasoning',   // self-hosted Magistral 24B (local default)
  vision: 'stackit-qwen3-vl',
};

/**
 * The explicit per-agent "Reasoning target" choice (the picker affordance) — the
 * three LiteLLM model_names that make the reasoning tier selectable, in order:
 * the in-box sovereign default, the fast STACKIT alternative (also the fallback),
 * and the lightest in-box option. These are real LiteLLM model_names (they appear
 * live from /model/info); selecting one writes the agent's per-agent model override.
 */
export type ReasoningTarget = { model: string; label: string; hint: string };
export const REASONING_TARGETS: ReasoningTarget[] = [
  { model: 'sovereign-reasoning', label: 'Local-sovereign · Magistral 24B', hint: 'In-box, zero per-token, slower (latency-tolerant)' },
  { model: 'sovereign-default', label: 'Light · Ministral 3', hint: 'In-box small model, fastest, cheapest' },
];

/** Default activity → tier mapping. Cheap-first: only reasoning/vision escalate. */
const DEFAULT_TIERS: Record<Activity, Tier> = {
  planning: 'reasoning',
  coding: 'light',
  'text-writing': 'light',
  'tool-selection': 'light',
  vision: 'vision',
  video: 'vision',
};

export type Route = { tier: Tier; model: string };
export type RoutingTable = Record<Activity, Route>;

export function defaultRoutingTable(): RoutingTable {
  const table = {} as RoutingTable;
  for (const a of ACTIVITIES) {
    const tier = DEFAULT_TIERS[a];
    table[a] = { tier, model: TIER_MODELS[tier] };
  }
  return table;
}

/**
 * Resolve the model_name for an activity. A per-agent `model` (a LiteLLM
 * model_name) overrides the activity routing; otherwise the table's route wins.
 */
export function resolveModel(activity: Activity, table: RoutingTable, agentModel?: string | null): string {
  if (agentModel) return agentModel;
  return table[activity]?.model ?? TIER_MODELS.light;
}

/** Classify a LiteLLM model_name into its tier (for the routing probe). */
export function tierOf(model: string): Tier {
  const m = model.toLowerCase();
  // Reasoning first: both the local `sovereign-reasoning[-fast]` and the legacy
  // `…-vl-reasoning` alias must classify as reasoning (the latter also matches the
  // vision heuristic below, so order matters).
  if (m.includes('reason')) return 'reasoning';
  if (m.includes('qwen') || m.includes('vl') || m.includes('vision')) return 'vision';
  return 'light';
}

export type RouteProbe = { activity: Activity; model: string; tier: Tier };

/** Route a representative prompt for an activity and report the tier it hit. */
export function routeProbe(activity: Activity, table: RoutingTable): RouteProbe {
  const model = resolveModel(activity, table);
  return { activity, model, tier: table[activity]?.tier ?? tierOf(model) };
}
