/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The LiteLLM `/model/new` body for a model an admin registers in
 *             Admin -> Models & Providers, built from LiteLLM's own documented config.
 * USER STORY: As a platform admin I register an external provider (Mistral, EUrouter, any
 *             OpenAI-compatible endpoint) and assign it to a role, and chat, assistants and
 *             agents use it at once — with no code change and no Helm upgrade.
 *             As a platform admin I can pick LiteLLM's native provider (`mistral/…`) so the
 *             gateway prices the calls from its own price map and budgets bind.
 *             As a finance owner, a model registered here carries the token prices I typed, so
 *             LiteLLM books real spend and the key budgets actually stop a runaway.
 * ARCHITECTURE:
 *   PURE: no IO, no secrets store, no network. The route passes the raw key in and sends the
 *   result through the one admin write door (`core/infra/litellm-write.ts`); this module never
 *   logs or keeps it.
 *
 *   Three LiteLLM features, each used as LiteLLM documents it:
 *     • `model_info.access_groups` — the shared agent key (`litellmAgentKey.models`) carries
 *       the group name {@link ADMIN_REGISTERED_ACCESS_GROUP}, so every model registered here is
 *       callable with that key immediately. Before this, a registered alias was outside the
 *       key's model list and every chat and assistant call got `key_model_access_denied` (403)
 *       until an operator edited Helm values. The key-init Job re-asserts the chart list on
 *       every upgrade, so the group name (not the alias) is what must live there.
 *     • the provider prefix of `litellm_params.model` — `openai/<id>` for any OpenAI-compatible
 *       endpoint (api_base required), or a native LiteLLM provider (`mistral/<id>`), where
 *       api_base is optional because LiteLLM knows the provider's endpoint.
 *     • custom pricing, `litellm_params.input_cost_per_token` / `output_cost_per_token` (LiteLLM
 *       "Custom pricing") — without them LiteLLM books an `openai/<custom id>` call at cost 0 and
 *       no budget ever triggers. They go in `litellm_params`, not `model_info`: measured on
 *       1.109.1, `/model/new` keeps them there and drops them from `model_info`.
 */
/**
 * The LiteLLM model access group every admin-registered model joins. It is listed in the chart's
 * `litellmAgentKey.models`, which is how the shared agent key reaches these models.
 */
export const ADMIN_REGISTERED_ACCESS_GROUP = 'os-admin-registered';

/** A LiteLLM provider prefix: lowercase word characters (`mistral`, `together_ai`, `hosted_vllm`). */
const PROVIDER_RE = /^[a-z][a-z0-9_]*$/;

export type ProviderModelInput = {
  alias: string;
  /** The upstream model id, exactly as the provider names it (`mistral-small-latest`, `azure/gpt-5.1`). */
  modelName: string;
  /** The endpoint. Required for an OpenAI-compatible provider; optional for a native one. */
  baseUrl?: string;
  apiKey: string;
  mode: 'chat' | 'embedding';
  /** LiteLLM provider prefix. Empty or `openai` = OpenAI-compatible (the default). */
  litellmProvider?: string;
  /** Token prices per 1M tokens, in the currency of the shipped price book (EUR). */
  inputPerM?: number | null;
  outputPerM?: number | null;
};

export type ProviderModelPayload = {
  model_name: string;
  litellm_params: { model: string; api_key: string; api_base?: string; input_cost_per_token?: number; output_cost_per_token?: number };
  model_info: { mode: 'chat' | 'embedding'; access_groups: string[] };
};

function bad(message: string): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = 400;
  return e;
}

function price(v: number | null | undefined, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${field} must be a number ≥ 0 (per 1M tokens)`);
  return v / 1_000_000;
}

/** The normalised provider prefix, or '' for OpenAI-compatible. Throws 400 on a malformed one. */
export function normaliseProvider(raw: string | undefined): string {
  const p = (raw ?? '').trim().toLowerCase();
  if (!p || p === 'openai' || p === 'openai-compatible') return '';
  if (!PROVIDER_RE.test(p)) throw bad(`"${raw}" is not a LiteLLM provider name (lowercase letters, digits, underscore — e.g. mistral)`);
  return p;
}

/** The `litellm_params.model` string LiteLLM routes on. */
export function litellmModelFor(modelName: string, provider: string): string {
  const name = modelName.trim();
  // OpenAI-compatible: the `openai/` route, the upstream id passed through unchanged after it
  // (`openai/azure/gpt-5.1` sends `azure/gpt-5.1` upstream — EUrouter's own id).
  if (!provider) return name.startsWith('openai/') ? name : `openai/${name}`;
  // An admin who typed the prefix as part of the id gets it once, not twice.
  return name.startsWith(`${provider}/`) ? name : `${provider}/${name}`;
}

/**
 * Build the `/model/new` body. Throws a 400-status Error for an incomplete or malformed input,
 * so the route answers with the reason instead of registering half a model.
 */
export function buildProviderModel(input: ProviderModelInput): ProviderModelPayload {
  const alias = input.alias.trim();
  const modelName = input.modelName.trim();
  const baseUrl = (input.baseUrl ?? '').trim();
  const provider = normaliseProvider(input.litellmProvider);
  if (!alias || !modelName || !input.apiKey) throw bad('An alias, model id and API key are all required');
  if (!provider && !baseUrl) throw bad('An OpenAI-compatible provider needs its base URL (https://…/v1)');
  const inCost = price(input.inputPerM, 'Input price');
  const outCost = price(input.outputPerM, 'Output price');
  const params: ProviderModelPayload['litellm_params'] = { model: litellmModelFor(modelName, provider), api_key: input.apiKey };
  if (baseUrl) params.api_base = baseUrl;
  if (inCost !== undefined) params.input_cost_per_token = inCost;
  if (outCost !== undefined) params.output_cost_per_token = outCost;
  const info: ProviderModelPayload['model_info'] = { mode: input.mode, access_groups: [ADMIN_REGISTERED_ACCESS_GROUP] };
  return { model_name: alias, litellm_params: params, model_info: info };
}
