/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The catalog price of each model a turn used, for the per-role cost in the turn trace
 * USER STORY: As an admin I see what each role cost in a turn, priced from the catalog and never from a guess.
 * ARCHITECTURE:
 *   - the role name a turn calls stands for a catalog model through LiteLLM's `model_group_alias`
 *   (Platform → Models); the price is the price book's entry for that catalog model
 *   (`tabs/admin/lib/model-prices.ts`, EUR per 1M tokens). A gateway that cannot be read, or a model with no
 *   price, leaves the cost unknown (`undefined`): there is no default price.
 */
import 'server-only';
import { readRouterAliases } from '@core/infra/litellm-admin';
import { effectiveModelPrices } from '@tabs/admin/lib/model-prices';
import { priceTrace, type ModelTrace, type PricedTrace, type Prices } from '@core/runtime/turn-ledger';

export async function pricesFor(models: string[]): Promise<Prices> {
  const aliases = await readRouterAliases().catch(() => ({ ok: false as const }));
  const book = await effectiveModelPrices();
  const out: Prices = {};
  for (const m of new Set(models)) {
    const target = aliases.ok ? (aliases.data[m] ?? m) : m;
    const p = book[target];
    if (p) out[m] = { inputPerM: p.inputPerM, outputPerM: p.outputPerM };
  }
  return out;
}

export async function pricedTrace(trace: ModelTrace): Promise<PricedTrace> {
  return priceTrace(trace, await pricesFor(trace.calls.map((c) => c.model)));
}
