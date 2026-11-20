/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The two LiteLLM facts every model an admin registers in Admin -> Models & Providers
 *             carries: the access group and the custom prices (the flow itself: llm-providers.ts).
 * USER STORY: As a platform admin I register an external provider (Mistral, EUrouter, any
 *             OpenAI-compatible endpoint) and assign it to a role, and chat, assistants and
 *             agents use it at once — with no code change and no Helm upgrade.
 *             As a platform admin I can pick LiteLLM's native provider (`mistral/…`) so the
 *             gateway prices the calls from its own price map and budgets bind.
 *             As a finance owner, a model registered here carries the token prices I typed, so
 *             LiteLLM books real spend and the key budgets actually stop a runaway.
 * ARCHITECTURE:
 *   PURE: no IO, no network. Used by `llm-providers.ts` `registerProviderModel`.
 *
 *   LiteLLM features, each used as LiteLLM documents it:
 *     • `model_info.access_groups` — the shared agent key (`litellmAgentKey.models`) carries
 *       the group name {@link ADMIN_REGISTERED_ACCESS_GROUP}, so every model registered here is
 *       callable with that key immediately. Before this, a registered alias was outside the
 *       key's model list and every chat and assistant call got `key_model_access_denied` (403)
 *       until an operator edited Helm values. The key-init Job re-asserts the chart list on
 *       every upgrade, so the group name (not the alias) is what must live there.
 *     • custom pricing, `litellm_params.input_cost_per_token` / `output_cost_per_token` (LiteLLM
 *       "Custom pricing") — without them LiteLLM books an `openai/<custom id>` call at cost 0 and
 *       no budget ever triggers. They go in `litellm_params`, not `model_info`: measured on
 *       1.109.1, `/model/new` keeps them there and drops them from `model_info`.
 */
/**
 * The LiteLLM model access group every admin-registered model joins. It is listed in the chart's
 * `litellmAgentKey.models` (and appended by the key-init Job from `llmProviders.accessGroup`), which is
 * how the shared agent key reaches these models.
 */
export const ADMIN_REGISTERED_ACCESS_GROUP = 'os-admin-registered';

function bad(message: string): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = 400;
  return e;
}

/** A price per 1M tokens as LiteLLM's per-token cost; undefined when not given. Throws 400 on a bad value. */
export function perTokenCost(v: number | null | undefined, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${field} must be a number ≥ 0 (per 1M tokens)`);
  return v / 1_000_000;
}
