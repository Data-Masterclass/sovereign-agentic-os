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

import { ROLE_STRONG, ROLE_WORKER, ROLE_EMBEDDING, DEPRECATED_ALIASES, type RoleName } from '@core/models/role-names';

export type ModelContext = {
  /** Total token window the model accepts (input + output). */
  contextWindow: number;
  /** Tokens held back for the model's OWN output (the `max_tokens` cap). */
  reservedOutput: number;
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
 */
const ROLE_CONTEXTS: Record<RoleName, ModelContext> = {
  [ROLE_STRONG]: { contextWindow: 200_000, reservedOutput: 8_000 },
  [ROLE_WORKER]: { contextWindow: 128_000, reservedOutput: 4_000 },
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
    // A reserve that swallows the whole window is nonsense — clamp it below the window.
    out[name] = { contextWindow: cw, reservedOutput: Math.min(reserved, cw - 1) };
  }
  return out;
}

/**
 * Resolve the context shape for a model_name: an admin/env override wins, else a
 * built-in default, else the conservative unknown fallback. `overrides` is
 * injectable for tests; production reads `MODEL_CONTEXT_WINDOWS` from the env.
 */
export function modelContext(
  modelName: string,
  overrides: Record<string, ModelContext> = parseOverrides(process.env.MODEL_CONTEXT_WINDOWS),
): ModelContext {
  return overrides[modelName] ?? DEFAULT_MODEL_CONTEXTS[modelName] ?? UNKNOWN_MODEL_CONTEXT;
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
