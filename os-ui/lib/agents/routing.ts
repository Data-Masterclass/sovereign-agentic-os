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
 * The live model set behind these fixed aliases is now ALL STACKIT-managed
 * inference (sovereign-default→gpt-oss-20b; sovereign-reasoning/vision/premium→
 * Qwen3-VL-235B; sovereign-embed→Qwen3-VL-Embedding-8B). There is no in-box
 * self-hosted model server anymore, so provenance for every alias is `external`
 * (STACKIT-EU). A per-agent pin MUST be one of these real aliases or Build/run
 * 404s at the gateway.
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
  /** Human display name, e.g. "Qwen3-VL-235B". */
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
  'sovereign-default': { model_name: 'sovereign-default', display: 'gpt-oss-20b', params: '20B', tier: 'light', provenance: 'external' },
  'sovereign-reasoning': { model_name: 'sovereign-reasoning', display: 'Qwen3-VL-235B', params: '235B', tier: 'reasoning', provenance: 'external' },
  'sovereign-reasoning-fast': { model_name: 'sovereign-reasoning-fast', display: 'Qwen3-VL-235B (fast)', params: '235B', tier: 'reasoning', provenance: 'external' },
  'sovereign-vision': { model_name: 'sovereign-vision', display: 'Qwen3-VL-235B', params: '235B', tier: 'vision', provenance: 'external' },
  'sovereign-premium': { model_name: 'sovereign-premium', display: 'Qwen3-VL-235B', params: '235B', tier: 'reasoning', provenance: 'external' },
  'sovereign-embed': { model_name: 'sovereign-embed', display: 'Qwen3-VL-Embedding-8B', params: '8B', tier: 'light', provenance: 'external' },
};

/**
 * Classify a model_name as in-box (internal) or hosted (external). The catalog is
 * authoritative; unknown names default to `external`. There is no in-box model
 * server anymore — every live alias is STACKIT-managed inference — so nothing
 * should render as `internal` unless a future catalog entry explicitly says so.
 */
export function provenanceOf(model: string): Provenance {
  const known = MODEL_CATALOG[model];
  if (known) return known.provenance;
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
 * The per-agent thinking control — LOCKED as a 3-state toggle: Auto / Standard /
 * Reasoning.
 *   • Auto (default)  → no per-agent pin; the workspace activity routing decides
 *                        (cheap-first). This is the recommended default.
 *   • Reasoning       → the platform-admin REASONING role model (default
 *                        `sovereign-reasoning`) for planning / deep thinking.
 *   • Standard        → the platform-admin STANDARD role model (default
 *                        `sovereign-default`) for fast tool-running work.
 * The `model` here is the INSTALL-BASELINE alias; the agent builder overrides it
 * with the live admin-configured role model (the /api/agents/models `roles`
 * payload). The stored `mode` id stays `execution` (unchanged agent-pin
 * semantics) — only the label is "Standard". `model === null` clears the pin
 * (Auto); the others write a real LiteLLM model_name via setAgentModel.
 */
export type ModelMode = 'auto' | 'reasoning' | 'execution';
export const MODEL_MODES: { mode: ModelMode; label: string; model: string | null; hint: string }[] = [
  { mode: 'auto', label: 'Auto', model: null, hint: 'Picks the right model for each task — cheap-first. Recommended.' },
  { mode: 'reasoning', label: 'Reasoning', model: TIER_MODELS.reasoning, hint: 'Deep thinking and planning. Slower, most capable.' },
  { mode: 'execution', label: 'Standard', model: TIER_MODELS.light, hint: 'Fast tool-running and short, direct tasks.' },
];

/** Which toggle state an agent's current `model` pin corresponds to. */
export function modeForModel(model: string | null | undefined): ModelMode {
  if (!model) return 'auto';
  if (model === TIER_MODELS.light) return 'execution';
  // Any pinned reasoning/vision-tier model reads as Reasoning; other light pins
  // (exotic small models chosen via Advanced) read as Execution.
  return tierOf(model) === 'light' ? 'execution' : 'reasoning';
}

/**
 * AUTO per-node model selection — the DETERMINISTIC tier classifier, pure and
 * client-safe (no server deps), so both the graph executor and the Agents builder
 * UI share one source of truth. It answers ONE question for an Auto node: does this
 * agent do READ-ONLY gathering (→ the fast tier) or WRITE/JUDGMENT work (→ reasoning)?
 *
 * Signals, strongest first:
 *   1. Granted tools (primary). Only read/fetch tools → fast. Any write/decide tool,
 *      or ZERO tools (pure synthesis/judgment), → reasoning.
 *   2. Role / name / prompt keywords (secondary tiebreak, only used when tools are
 *      ambiguous — e.g. a mix, or a read-only set whose ROLE clearly says "judge").
 *
 * Returns the coarse need — 'fast' | 'reasoning' — NOT a model_name; the caller maps
 * that to its execModel / reasoningModel so admin role overrides still decide the alias.
 */
export type ModelNeed = 'fast' | 'reasoning';

/**
 * A tool name is READ-ONLY when it only queries/fetches/inspects — never mutates,
 * decides, or approves. We match by verb PREFIX (the OS tool naming is verb-led:
 * `query_data`, `search_knowledge`, `list_*`, `get_*`, `profile_*`, `read_*`,
 * `use_*`), so an unknown read-shaped tool still classifies as read-only.
 */
const READ_TOOL_PREFIXES = ['query_', 'search_', 'list_', 'get_', 'profile_', 'use_', 'read_', 'browse_', 'test_'];

function isReadOnlyTool(name: string): boolean {
  const n = name.toLowerCase();
  return READ_TOOL_PREFIXES.some((p) => n.startsWith(p));
}

/** Keywords that pull a node toward FAST (gather/format work). */
const FAST_KEYWORDS = ['analyst', 'collect', 'fetch', 'gather', 'summariz', 'summaris', 'format', 'extract', 'profile'];
/** Keywords that pull a node toward REASONING (judgment/decision work). */
const REASONING_KEYWORDS = ['evaluate', 'judge', 'score', 'recommend', 'decide', 'plan', 'reason', 'critique', 'assess', 'strateg'];

/** Does any keyword occur in the (lowercased) role/name/prompt text? */
function hasAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Classify a node's model NEED from its granted tool names + role/name/prompt text.
 * Pure and deterministic. Returns the need plus a short human `reason` for the UI /
 * drill-down. `roleText` is any concatenation of the node's id/role/prompt (optional).
 */
export function classifyModelNeed(tools: string[], roleText = ''): { need: ModelNeed; reason: string } {
  const hasReasoningWord = hasAny(roleText, REASONING_KEYWORDS);
  const hasFastWord = hasAny(roleText, FAST_KEYWORDS);

  // ZERO tools → pure synthesis/judgment → reasoning (a keyword can't downgrade it).
  if (tools.length === 0) {
    return { need: 'reasoning', reason: 'no tools: pure synthesis/judgment' };
  }

  const writeTools = tools.filter((t) => !isReadOnlyTool(t));
  const readTools = tools.filter((t) => isReadOnlyTool(t));

  // Any write/decide tool → reasoning (it can change state or commit a decision).
  if (writeTools.length > 0) {
    return { need: 'reasoning', reason: `has write/decide tools: ${writeTools.slice(0, 3).join(', ')}` };
  }

  // Read-only tool set. Default fast, but a clear REASONING role keyword overrides
  // (a read-only "evaluator" still needs judgment); a fast keyword only reinforces.
  if (hasReasoningWord && !hasFastWord) {
    return { need: 'reasoning', reason: `read-only tools but judgment role: ${roleText.trim().split(/\s+/)[0] ?? ''}`.trim() };
  }
  return { need: 'fast', reason: `read-only gatherer: ${readTools.slice(0, 3).join(', ')}` };
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
