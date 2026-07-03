/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Model routing — by activity (LOCKED). The workspace default table maps each
 * activity to a LiteLLM tier, inherited by systems/agents with per-agent
 * overrides. The tier model_names are the REAL sovereign gateway aliases (verified
 * against the live LiteLLM proxy_config.model_list — see values.stackit-managed.yaml):
 *
 *   • light     → `sovereign-default` — chat, coding, tool-selection, light work.
 *   • reasoning → `sovereign-reasoning` — planning / deep reasoning. `sovereign-
 *                 reasoning-fast` is the explicit fast alternative AND fallback.
 *   • vision    → `sovereign-vision` — the rare vision/video need + failover.
 *
 * ALL of these are sovereign (in-box / STACKIT-EU) → provenance `internal`. There
 * is NO `ministral-*` or `stackit-*` model_name on the live gateway — a per-agent
 * pin MUST be one of these real aliases or Build/run 404s at the gateway.
 *
 * PURE module: editing the table writes LiteLLM routing config (the LiteLLM build
 * adapter), but no endpoint is ever hardcoded in the UI — a per-agent model is a
 * LiteLLM `model_name` picked live from `/model/info`; these tier defaults are the
 * install baseline only.
 */

export type Activity = 'planning' | 'coding' | 'text-writing' | 'tool-selection' | 'vision' | 'video';
export type Tier = 'light' | 'reasoning' | 'vision';

export const ACTIVITIES: Activity[] = ['planning', 'coding', 'text-writing', 'tool-selection', 'vision', 'video'];

/** Tier → default LiteLLM model_name (a REAL live gateway alias; overridable). */
export const TIER_MODELS: Record<Tier, string> = {
  light: 'sovereign-default',
  reasoning: 'sovereign-reasoning',
  vision: 'sovereign-vision',
};

/**
 * Provenance = where a model actually runs. `internal` = in-box on the sovereign
 * cluster (no data leaves; zero per-token); `external` = a hosted API (e.g.
 * STACKIT) that the gateway calls out to. The per-agent picker shows this as a
 * badge so a non-technical builder can see, at a glance, whether their agent's
 * thinking stays in-house.
 */
export type Provenance = 'internal' | 'external';

/** One catalog row: the real LiteLLM model_name + human-facing metadata. */
export type ModelInfo = {
  model_name: string;
  /** Human display name, e.g. "Magistral Small 24B". */
  display: string;
  /** Parameter size for context, e.g. "24B" (optional). */
  params?: string;
  tier: Tier;
  provenance: Provenance;
};

/**
 * The single source of truth for how a LiteLLM `model_name` is presented. Replaces
 * the old `REASONING_TARGETS` (which wrote a phantom `sovereign-default`). The
 * models API enriches its live `/model/info` list against this catalog; anything
 * not listed falls back to prefix heuristics ({@link provenanceOf} / {@link tierOf}).
 */
export const MODEL_CATALOG: Record<string, ModelInfo> = {
  'sovereign-default': { model_name: 'sovereign-default', display: 'Sovereign Default', tier: 'light', provenance: 'internal' },
  'sovereign-reasoning': { model_name: 'sovereign-reasoning', display: 'Sovereign Reasoning', tier: 'reasoning', provenance: 'internal' },
  'sovereign-reasoning-fast': { model_name: 'sovereign-reasoning-fast', display: 'Sovereign Reasoning (fast)', tier: 'reasoning', provenance: 'internal' },
  'sovereign-vision': { model_name: 'sovereign-vision', display: 'Sovereign Vision', tier: 'vision', provenance: 'internal' },
  'sovereign-premium': { model_name: 'sovereign-premium', display: 'Sovereign Premium', tier: 'reasoning', provenance: 'internal' },
};

/** Classify a model_name as in-box (internal) or hosted (external). */
export function provenanceOf(model: string): Provenance {
  const known = MODEL_CATALOG[model];
  if (known) return known.provenance;
  const m = model.toLowerCase();
  if (m.startsWith('stackit') || m.includes('stackit')) return 'external';
  if (m.startsWith('ministral') || m.startsWith('sovereign') || m.startsWith('magistral')) return 'internal';
  // Unknown provider: assume hosted (safer to over-warn than to imply in-box).
  return 'external';
}

/** Resolve display metadata for any model_name (catalog first, heuristics after). */
export function modelInfo(model: string): ModelInfo {
  return (
    MODEL_CATALOG[model] ?? {
      model_name: model,
      display: model,
      tier: tierOf(model),
      provenance: provenanceOf(model),
    }
  );
}

/**
 * The per-agent thinking control — LOCKED as a 3-state toggle.
 *   • Auto (default)  → no per-agent pin; the workspace activity routing decides
 *                        (cheap-first). This is the recommended default.
 *   • Reasoning       → pin the in-box Magistral 24B for planning / deep thinking.
 *   • Execution       → pin the in-box Ministral 3 for fast tool-running work.
 * `model === null` clears the pin (Auto); the others write a real LiteLLM
 * model_name via setAgentModel.
 */
export type ModelMode = 'auto' | 'reasoning' | 'execution';
export const MODEL_MODES: { mode: ModelMode; label: string; model: string | null; hint: string }[] = [
  { mode: 'auto', label: 'Auto', model: null, hint: 'Picks the right model for each task — cheap-first. Recommended.' },
  { mode: 'reasoning', label: 'Reasoning', model: TIER_MODELS.reasoning, hint: 'Deep thinking and planning. Slower, most capable.' },
  { mode: 'execution', label: 'Execution', model: TIER_MODELS.light, hint: 'Fast tool-running and short, direct tasks.' },
];

/** Which toggle state an agent's current `model` pin corresponds to. */
export function modeForModel(model: string | null | undefined): ModelMode {
  if (!model) return 'auto';
  if (model === TIER_MODELS.light) return 'execution';
  // Any pinned reasoning/vision-tier model reads as Reasoning; other light pins
  // (exotic small models chosen via Advanced) read as Execution.
  return tierOf(model) === 'light' ? 'execution' : 'reasoning';
}

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
