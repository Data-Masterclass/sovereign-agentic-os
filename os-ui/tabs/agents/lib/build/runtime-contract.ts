/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A system's OPA principal, and what one run of it cost
 * USER STORY: As an operator I want every governed call and every trace of a system to carry the
 *             same principal (`os-<id>`), and I want a run's cost to be either a real number or
 *             nothing — never a fabricated zero.
 * ARCHITECTURE:
 *   - A5 emptied this file of what gave it its name. It used to carry the HTTP contract between
 *     os-ui and the shared Python `agent-runtime` service: `/reload` (POST the compiled IR —
 *     the IR as a WIRE FORMAT), `/run` (one synchronous invocation) and the governed-tool
 *     callback the runtime made for every tool call. The runtime is retired: the engine runs
 *     in-process and calls `handleRpc(user, …)` directly, so there is no wire and no callback.
 *   - What is left are the two pure helpers those types grew up around, both used far beyond the
 *     old runtime ({@link principalFor} in os-tools, the Build adapters, grant rehydration and
 *     Monitoring; {@link runCostUsd} in the run-summary trace and the price book's tests). The
 *     file keeps its path because a dozen modules import it and a rename buys nothing.
 */

/** Scope a system (and optionally a node) to its OPA principal: `os-<id>[:node]`. */
export function principalFor(systemId: string, node?: string): string {
  return node ? `os-${systemId}:${node}` : `os-${systemId}`;
}

/** Price per 1M tokens for one LiteLLM model_name (EUR on STACKIT; see
 *  lib/platform-admin/model-prices.effectiveModelPrices — admin-saved over the
 *  env MODEL_PRICES_JSON seed). */
export type ModelPrice = { inputPerM: number; outputPerM: number };

/**
 * Price a run's AGGREGATE usage. A run is two-tier (plan on the reasoning model,
 * execute on the exec model) but reports ONE merged usage with no per-model split,
 * so we price honestly only when EVERY tier's model resolves
 * to the same explicit price. Anything else — an unpriced model, or tiers with
 * different prices — returns undefined (the Monitor tile shows "—"; unpriced is
 * never 0, never fabricated).
 */
export function runCostUsd(
  usage: { input: number; output: number } | undefined,
  models: readonly string[],
  prices: Readonly<Record<string, ModelPrice>>,
): number | undefined {
  if (!usage || models.length === 0) return undefined;
  const resolved = models.map((m) => prices[m]);
  const first = resolved[0];
  if (!first) return undefined;
  for (const p of resolved) {
    if (!p || p.inputPerM !== first.inputPerM || p.outputPerM !== first.outputPerM) return undefined;
  }
  return (usage.input * first.inputPerM + usage.output * first.outputPerM) / 1_000_000;
}
