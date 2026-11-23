/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       models
 * FEATURE:    Each catalog model is sampled the way its VENDOR recommends — on every chat-model call the OS makes
 * USER STORY: As the owner I want the chat, agent runs, software building and the builder assistant to call each
 *             model with the temperature / top_p its maker publishes, not one number for every model; and a model with
 *             no published recommendation keeps today's 0.2.
 * ARCHITECTURE:
 *   - ONE SOURCE OF TRUTH: the table below, keyed by CATALOG model name (what a role points at in Platform → Models,
 *     `os/models.yml`), each value copied from the vendor's official docs or model card — the URL is on every entry.
 *     A role name is resolved to its catalog model through the held catalog limits (`catalogLimit(role).target`).
 *   - ONE HELPER: `wireSampling(req)` gives the sampling fields of a request. The gateway callers use it — the harness
 *     caller (`runtime.ts`), the assistant caller (`complete.ts`) and the LangChain model of the module engine
 *     (`core/adapters/litellm/chat-model.ts`) — so every caller follows the catalog with no code of its own.
 *   - EXCEPTIONS keep their explicit low temperature (`fixedSampling: true` on the request): small deterministic
 *     utility calls that must return a fixed format. At 0: the delegate presets (structured extraction), the Auto model
 *     choice, the file auto-description + tags, NL→SQL (`/api/data/ask`), the text classifier (`/api/classify`). At 0.2
 *     (their value until now): the JSON-only builder stages (`stage-route`), the team-structure proposal (agents
 *     assistant), the warehouse catalog classifier, the software dummy rows, the expose-assistant JSON, the evaluation
 *     judge. Nothing else may pin a temperature. A model whose vendor fixes the temperature gets none, exception or not.
 *   - NOT covered: the ejected module's offline `run.mjs` (`tabs/agents/lib/module/generate.ts`) runs without the OS and
 *     uses the model's own defaults.
 *   - `omitTemperature`: the vendor fixes the value and asks callers not to send it.
 *   - This is the only OS source file besides the provider presets that names catalog models (the role-call-site
 *     guard allows it): it is data about those models, not a call to one.
 */
import { catalogLimit } from '@core/models/model-limits';
import { ROLE_NAMES } from '@core/models/role-names';

export type ModelSampling = {
  /** The vendor's recommended temperature. */
  temperature?: number;
  /** The vendor fixes the temperature and asks not to send it. */
  omitTemperature?: true;
  /** The vendor's recommended top_p. */
  top_p?: number;
  /** The vendor's recommended presence_penalty (a standard OpenAI-API field LiteLLM forwards). */
  presence_penalty?: number;
  /** Where the values come from (official docs / model card). */
  source: string;
};

/** Today's value for every call, kept for a model whose vendor publishes no recommendation. */
export const DEFAULT_TEMPERATURE = 0.2;

const RECOMMENDED: Readonly<Record<string, ModelSampling>> = {
  // OpenAI gpt-oss-20b — "We recommend sampling with temperature=1.0 and top_p=1.0."
  // https://github.com/openai/gpt-oss (README, "Recommended Sampling Parameters")
  'stackit-gpt-oss-20b': { temperature: 1.0, top_p: 1.0, source: 'https://github.com/openai/gpt-oss#recommended-sampling-parameters' },
  // Qwen3-VL Instruct — "Generation Hyperparameters, Instruct models": top_p=0.8, top_k=20, temperature=0.7,
  // repetition_penalty=1.0, presence_penalty=1.5 (top_k / repetition_penalty are not OpenAI-API fields: not sent;
  // presence_penalty is, and LiteLLM forwards it to an OpenAI-compatible provider).
  // https://github.com/QwenLM/Qwen3-VL (README, "Generation Hyperparameters")
  'stackit-qwen3-vl-235b': { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5, source: 'https://github.com/QwenLM/Qwen3-VL#generation-hyperparameters' },
  // Kimi K3.1 Pro — "kimi-k3.1-pro and kimi-k3 fix temperature at 1.0; other values are rejected. Do not explicitly set
  // this parameter when calling these models." (no top_p guidance)
  // https://platform.kimi.ai/docs/guide/migrating-from-openai-to-kimi
  'lyceum-kimi-k3.1-pro': { omitTemperature: true, source: 'https://platform.kimi.ai/docs/guide/migrating-from-openai-to-kimi' },
  // DeepSeek V4.1 Flash — model card: temperature 1.0, top_p 0.95 or 1.0 ("Evaluations use temperature=1.0, top_p=0.95").
  // https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash
  'lyceum-deepseek-v4.1-flash': { temperature: 1.0, top_p: 0.95, source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash' },
};

/** The vendor recommendation for a catalog model, or for the catalog model a role points at; undefined = none published. */
export function recommendedSampling(model: string): ModelSampling | undefined {
  const direct = RECOMMENDED[model];
  if (direct) return direct;
  const target = catalogLimit(model)?.target;
  return target ? RECOMMENDED[target] : undefined;
}

const ROLES: ReadonlySet<string> = new Set(ROLE_NAMES);
const warnedUnresolved = new Set<string>();

export type WireSampling = { temperature?: number; top_p?: number; presence_penalty?: number };

/**
 * The sampling fields of ONE request to the gateway: the model's vendor recommendation, else temperature 0.2.
 *   - A model whose vendor FIXES the temperature (`omitTemperature`) never gets one — not even from an exception.
 *   - A request marked `fixedSampling` (the listed exceptions) otherwise keeps its own temperature.
 *   - A ROLE whose catalog model cannot be resolved (the catalog has not loaded) gets NO temperature (the provider's
 *     own default, which every vendor accepts) instead of a guess that a vendor might reject; logged once per role.
 * Callers make the catalog current first (`ensureModelLimitsFresh`).
 */
export function wireSampling(req: { model: string; temperature?: number; fixedSampling?: boolean }): WireSampling {
  const rec = recommendedSampling(req.model);
  if (rec?.omitTemperature) return req.fixedSampling ? {} : { ...(rec.top_p !== undefined ? { top_p: rec.top_p } : {}) };
  const unresolvedRole = !rec && ROLES.has(req.model) && !catalogLimit(req.model)?.target;
  if (unresolvedRole) {
    if (!warnedUnresolved.has(req.model)) {
      warnedUnresolved.add(req.model);
      console.warn(`[models] the catalog model behind '${req.model}' is not known yet (the gateway catalog has not loaded): no temperature is sent, the provider's default applies`);
    }
    return {};
  }
  if (req.fixedSampling) return { temperature: req.temperature ?? DEFAULT_TEMPERATURE };
  if (!rec) return { temperature: DEFAULT_TEMPERATURE };
  return {
    temperature: rec.temperature ?? DEFAULT_TEMPERATURE,
    ...(rec.top_p !== undefined ? { top_p: rec.top_p } : {}),
    ...(rec.presence_penalty !== undefined ? { presence_penalty: rec.presence_penalty } : {}),
  };
}
