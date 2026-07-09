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
 *     inputBudget = contextWindow − reservedOutput
 *
 * and `reservedOutput` is also what the harness caps `max_tokens` at on the request.
 *
 * OPEN-SOURCE RULE: these are helm/env DEFAULTS, not hardcoded magic. A platform
 * admin overrides any model live via the `MODEL_CONTEXT_WINDOWS` env var — a JSON
 * map of `model_name → { contextWindow, reservedOutput }` — without a rebuild. An
 * unknown model falls back to a deliberately CONSERVATIVE default so a mystery
 * model degrades safely (small budget) rather than blowing the window.
 */

export type ModelContext = {
  /** Total token window the model accepts (input + output). */
  contextWindow: number;
  /** Tokens held back for the model's OWN output (the `max_tokens` cap). */
  reservedOutput: number;
};

/**
 * Built-in defaults for the sovereign-* models. `model_name` here is the LiteLLM
 * alias the gateway routes on (the same ids `lib/models/roles.ts` resolves to).
 *   • sovereign-reasoning (Qwen) — a ~200k-window reasoning model.
 *   • sovereign-default / gpt-oss(-20b) — the lighter execution model (~128k).
 *   • sovereign-embed — an embedding model; n/a for chat budgeting, listed so a
 *     lookup returns a sane (tiny) shape rather than the unknown fallback.
 */
export const DEFAULT_MODEL_CONTEXTS: Record<string, ModelContext> = {
  'sovereign-reasoning': { contextWindow: 200_000, reservedOutput: 8_000 },
  'sovereign-default': { contextWindow: 128_000, reservedOutput: 4_000 },
  'gpt-oss': { contextWindow: 128_000, reservedOutput: 4_000 },
  'gpt-oss-20b': { contextWindow: 128_000, reservedOutput: 4_000 },
  'sovereign-embed': { contextWindow: 8_192, reservedOutput: 0 },
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
 * The INPUT token budget for a model — the ceiling the context assembler must
 * never exceed. `contextWindow − reservedOutput`, floored at a small positive
 * value so a misconfigured tiny window still yields a usable (if minimal) budget.
 */
export function inputBudget(
  modelName: string,
  overrides?: Record<string, ModelContext>,
): number {
  const { contextWindow, reservedOutput } = modelContext(modelName, overrides ?? parseOverrides(process.env.MODEL_CONTEXT_WINDOWS));
  return Math.max(512, contextWindow - reservedOutput);
}
