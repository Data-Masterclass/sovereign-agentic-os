/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MODEL-CONTEXT REGISTRY — the single source of truth for "how big is this model's
 * context window, and how much of it must we reserve for the answer".
 *
 * The agent harness (`lib/assistant/*`, the multi-node graph) uses this to budget
 * the assembled input so a request NEVER exceeds the model window (the root cause
 * of the LiteLLM 400 ContextWindowExceededError). The input budget for a model is
 *
 *     inputBudget = contextWindow − reservedOutput − safetyHeadroom
 *
 * where `reservedOutput` is ALSO what the harness caps `max_tokens` at on the same
 * request. Because the request sends `input + max_tokens`, the budget MUST leave
 * room for BOTH — `input(≤ inputBudget) + reservedOutput` must stay under the window
 * with slack. The `safetyHeadroom` provides that slack, and also absorbs the fact
 * that our `estimateTokens` (≈4 chars/token, content-only) UNDER-counts the real
 * tokenizer (it ignores tool_calls JSON + message envelope + the tools schema). An
 * earlier `contextWindow − reservedOutput` budget double-spent the reserve — input
 * filled to `window − reservedOutput`, then `+ reservedOutput` on the wire hit the
 * window exactly and the tokenizer drift tipped it over → the 400.
 *
 * OPEN-SOURCE RULE: these are helm/env DEFAULTS, not hardcoded magic. A platform
 * admin overrides any model live via the `MODEL_CONTEXT_WINDOWS` env var — a JSON
 * map of `model_name → { contextWindow, reservedOutput }` — without a rebuild. An
 * unknown model falls back to a deliberately CONSERVATIVE default so a mystery
 * model degrades safely (small budget) rather than blowing the window.
 */

import { catalogLimit, catalogLoaded } from '@core/models/model-limits';
import { ROLE_STRONG, ROLE_WORKER, ROLE_EMBEDDING, DEPRECATED_ALIASES, type RoleName } from '@core/models/role-names';

export type ModelContext = {
  /** Total token window the model accepts (input + output). */
  contextWindow: number;
  /** Tokens held back for the model's OWN output (the `max_tokens` cap). */
  reservedOutput: number;
  /** The most the model can produce (the catalog's `max_output_tokens`, or an override's `maxOutput`) when known: the ceiling for a larger retry. */
  maxOutput?: number;
};

/**
 * Built-in defaults, keyed by the role names the OS sends (and the old names that still resolve to a role).
 * The window is a property of the model the role is mapped to, which the OS does not read here; these are
 * conservative figures that hold for the models the chart seeds. A model with a smaller or larger window
 * is set with the `MODEL_CONTEXT_WINDOWS` env (a JSON map), keyed by the role name.
 *   • sovereign-strong    — a large-window reasoning model (~200k).
 *   • sovereign-worker    — the lighter execution model (~128k).
 *   • sovereign-embedding — an embedding model; n/a for chat budgeting, listed so a lookup returns a sane
 *     (tiny) shape rather than the unknown fallback.
 * OUTPUT: 16 384 for strong, 8 192 for worker (was 8 000 / 4 000). Both roles are REASONING models whose
 * thinking counts against `max_tokens`; on the 2026-11-27 course 108 of 848 strong calls and 56 of 696
 * worker calls ended exactly at the old caps, and 8 of the 10 failed runs stopped with "spent its whole
 * output budget on reasoning" (docs/ops/2026-11-27-course-load-incident.md). These defaults apply whenever
 * the catalog has no `max_output_tokens` for the mapped model — and in the worker, which cannot read the
 * catalog without the admin key. They must NEVER exceed what the chart's SEEDED role models accept, or a
 * fresh install would send a `max_tokens` its model refuses: strong → stackit-qwen3-vl-235b
 * (max_output_tokens 16 384), worker → stackit-gpt-oss-20b (8 192), charts/…/values.yaml. A larger model
 * mapped to a role gets its real cap through `osUI.modelContextWindows` (MODEL_CONTEXT_WINDOWS).
 */
const ROLE_CONTEXTS: Record<RoleName, ModelContext> = {
  [ROLE_STRONG]: { contextWindow: 200_000, reservedOutput: 16_384 },
  [ROLE_WORKER]: { contextWindow: 128_000, reservedOutput: 8_192 },
  [ROLE_EMBEDDING]: { contextWindow: 8_192, reservedOutput: 0 },
};
export const DEFAULT_MODEL_CONTEXTS: Record<string, ModelContext> = {
  ...ROLE_CONTEXTS,
  ...Object.fromEntries(Object.entries(DEPRECATED_ALIASES).map(([old, role]) => [old, ROLE_CONTEXTS[role]])),
};

/**
 * The safe fallback for an unknown model: assume a small, widely-supported window
 * so we UNDER-fill rather than overflow. Better a slightly trimmed context than a
 * 400 from a model whose true window we don't know.
 */
export const UNKNOWN_MODEL_CONTEXT: ModelContext = { contextWindow: 32_000, reservedOutput: 2_000 };

/**
 * Parse the admin/env override map from `MODEL_CONTEXT_WINDOWS` (JSON). Malformed
 * entries are ignored (defaults stand) so a typo can never take the harness down.
 * Exported for tests; the live path reads `process.env` lazily on each lookup so an
 * admin change is picked up without a restart of the module graph.
 */
export function parseOverrides(raw: string | undefined): Record<string, ModelContext> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, ModelContext> = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const cw = (v as Record<string, unknown>).contextWindow;
    const ro = (v as Record<string, unknown>).reservedOutput;
    if (typeof cw !== 'number' || cw <= 0) continue;
    const reserved = typeof ro === 'number' && ro >= 0 ? ro : 0;
    const mo = (v as Record<string, unknown>).maxOutput;
    // A reserve that swallows the whole window is nonsense — clamp it below the window.
    out[name] = { contextWindow: cw, reservedOutput: Math.min(reserved, cw - 1), ...(typeof mo === 'number' && mo > 0 ? { maxOutput: Math.floor(mo) } : {}) };
  }
  return out;
}

/** Fallbacks already logged, so a model without catalog limits is reported once, not on every call. */
const warned = new Set<string>();
/** Tests only. */
export function __resetLimitWarnings(): void {
  warned.clear();
}
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[models] ${text}`);
}

/** Reserved output taken from the catalog: an eighth of the window, never more than the model can produce. */
const CATALOG_OUTPUT_SHARE = 8;

/**
 * Resolve the context shape for a model_name, in this order:
 *   1. the admin/env override (`MODEL_CONTEXT_WINDOWS`, chart `osUI.modelContextWindows`) — explicit, wins;
 *   2. the LiteLLM catalog's limits for the model the name (a role) is mapped to — see `model-limits.ts`;
 *   3. the built-in default, then the conservative unknown fallback. Reaching this step AFTER the
 *      catalog was loaded means the catalog has no value for the model: that is logged (once).
 * `overrides` is injectable for tests; production reads `MODEL_CONTEXT_WINDOWS` from the env.
 */
export function modelContext(
  modelName: string,
  overrides: Record<string, ModelContext> = parseOverrides(process.env.MODEL_CONTEXT_WINDOWS),
): ModelContext {
  const forced = overrides[modelName];
  if (forced) return forced;
  const fallback = DEFAULT_MODEL_CONTEXTS[modelName] ?? UNKNOWN_MODEL_CONTEXT;
  const cat = catalogLimit(modelName);
  if (!cat) {
    if (catalogLoaded()) warnOnce(`${modelName}:entry`, `no entry for ${modelName} in the LiteLLM catalog; using the built-in limits (window ${fallback.contextWindow}, output ${fallback.reservedOutput}).`);
    return fallback;
  }
  if (!cat.contextWindow) warnOnce(`${modelName}:window`, `the LiteLLM catalog has no max_input_tokens for ${cat.target ?? modelName} (${modelName}); using the built-in window ${fallback.contextWindow}.`);
  if (!cat.maxOutput) warnOnce(`${modelName}:output`, `the LiteLLM catalog has no max_output_tokens for ${cat.target ?? modelName} (${modelName}); using the built-in output limit ${fallback.reservedOutput}.`);
  const contextWindow = cat.contextWindow ?? fallback.contextWindow;
  const reservedOutput = cat.maxOutput ? Math.min(cat.maxOutput, Math.max(1, Math.round(contextWindow / CATALOG_OUTPUT_SHARE))) : Math.min(fallback.reservedOutput, contextWindow - 1);
  return { contextWindow, reservedOutput, ...(cat.maxOutput ? { maxOutput: cat.maxOutput } : {}) };
}

/**
 * The largest `max_tokens` a RETRY may use for a model: its max output when KNOWN (catalog or
 * override), else the normal reserve — never a guess above it. An unknown model's real ceiling may be
 * exactly the reserve (the built-in defaults are the seeded models' max output), and a retry above it
 * would be refused with a 400 instead of answering. Used when a reasoning model spent its whole budget
 * thinking (`core/runtime/reasoning-budget.ts`, `core/runtime/complete.ts`).
 */
export function outputCeiling(modelName: string, overrides?: Record<string, ModelContext>): number {
  const c = modelContext(modelName, overrides ?? parseOverrides(process.env.MODEL_CONTEXT_WINDOWS));
  return c.maxOutput ?? c.reservedOutput;
}

/**
 * A safety margin held back ON TOP of `reservedOutput`, so `input + max_tokens`
 * stays strictly under the window even when our token estimate undercounts the real
 * tokenizer. ~4% of the window (min 2000): 8000 for a 200k model, so a full input
 * (184k) + reserved output (8k) = 192k leaves ~8k of real slack under 200k.
 */
export function safetyHeadroom(contextWindow: number): number {
  return Math.max(2_000, Math.round(contextWindow * 0.04));
}

/**
 * The INPUT token budget for a model — the ceiling the context assembler must never
 * exceed. `contextWindow − reservedOutput − safetyHeadroom`, floored at a small
 * positive value so a misconfigured tiny window still yields a usable (if minimal)
 * budget. The headroom guarantees `inputBudget + reservedOutput < contextWindow`.
 */
export function inputBudget(
  modelName: string,
  overrides?: Record<string, ModelContext>,
): number {
  const { contextWindow, reservedOutput } = modelContext(modelName, overrides ?? parseOverrides(process.env.MODEL_CONTEXT_WINDOWS));
  return Math.max(512, contextWindow - reservedOutput - safetyHeadroom(contextWindow));
}
