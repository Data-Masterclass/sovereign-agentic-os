/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LLM provider presets — the starting points of the Models & Providers flow (client-safe).
 * USER STORY: As a platform admin I pick "Azure OpenAI", "Ollama", "Mistral", "STACKIT", an
 *             OpenAI-compatible server, or any other provider LiteLLM supports, and the form asks for
 *             exactly the fields LiteLLM needs for it. STACKIT is one preset, not the rule.
 * ARCHITECTURE:
 *   - A preset is ONLY a LiteLLM provider id, the fields that provider needs, and an optional default
 *     endpoint. Everything after that is LiteLLM's own: `litellm_params.model` is
 *     `<litellm_provider>/<model>` (https://docs.litellm.ai/docs/providers), the credential goes to
 *     LiteLLM's `/credentials` store, the test is LiteLLM's `/health/test_connection`.
 *   - "Any LiteLLM provider" (`litellm`) takes the provider id from LiteLLM's own
 *     `/public/providers/fields` list, so the OS never keeps a copy of LiteLLM's catalogue.
 *   - Pure and dependency-free so the admin page and the server share one definition.
 */

export type PresetId = 'azure' | 'openai-compatible' | 'ollama' | 'mistral' | 'stackit' | 'litellm';

export type Preset = {
  id: PresetId;
  label: string;
  blurb: string;
  /** LiteLLM provider id (the model-string prefix). null = the admin picks one from LiteLLM's list. */
  litellmProvider: string | null;
  /** Pre-filled endpoint, if the provider has a documented one. */
  defaultApiBase?: string;
  /** Host used for the egress check when the endpoint is LiteLLM's built-in default (no api_base sent). */
  defaultHost?: string;
  apiBase: 'required' | 'optional';
  apiVersion: boolean;
  apiKey: 'required' | 'optional' | 'none';
  /** What the "model" field means for this provider. */
  modelHint: string;
};

export const PRESETS: readonly Preset[] = [
  { id: 'azure', label: 'Azure OpenAI', litellmProvider: 'azure', apiBase: 'required', apiVersion: true, apiKey: 'required',
    blurb: 'Your Azure OpenAI resource. The model is your deployment name.', modelHint: 'deployment name (e.g. gpt-4o-prod)' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', litellmProvider: 'openai', apiBase: 'required', apiVersion: false, apiKey: 'optional',
    blurb: 'vLLM, LM Studio, EU Router or any server with an OpenAI /v1 API.', modelHint: 'model id the server serves' },
  { id: 'ollama', label: 'Ollama', litellmProvider: 'ollama_chat', defaultApiBase: 'http://ollama:11434', apiBase: 'required', apiVersion: false, apiKey: 'none',
    blurb: 'A local or in-cluster Ollama server.', modelHint: 'model tag (e.g. llama3.2:1b)' },
  { id: 'mistral', label: 'Mistral AI', litellmProvider: 'mistral', defaultHost: 'api.mistral.ai', apiBase: 'optional', apiVersion: false, apiKey: 'required',
    blurb: 'Mistral La Plateforme (EU), on LiteLLM\'s native adapter, so prices come with it.', modelHint: 'model (e.g. mistral-small-latest)' },
  { id: 'stackit', label: 'STACKIT AI Model Serving', litellmProvider: 'openai', defaultApiBase: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1',
    apiBase: 'required', apiVersion: false, apiKey: 'required',
    blurb: 'STACKIT\'s OpenAI-compatible endpoint (EU).', modelHint: 'model id with its org (e.g. Qwen/Qwen3-VL-235B-A22B-Instruct-FP8)' },
  { id: 'litellm', label: 'Another LiteLLM provider', litellmProvider: null, apiBase: 'required', apiVersion: false, apiKey: 'optional',
    blurb: 'Any provider from LiteLLM\'s own list (Bedrock, Vertex, Anthropic, …).', modelHint: 'model id as LiteLLM documents it for that provider' },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

function bad(message: string): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = 400;
  return e;
}

/** `<litellm_provider>/<model>`, LiteLLM's documented form. An already-prefixed id is kept as typed. */
export function modelString(litellmProvider: string, model: string): string {
  const m = (model ?? '').trim();
  if (!m) throw bad('A model is required');
  if (!litellmProvider) throw bad('A LiteLLM provider is required');
  return m.startsWith(`${litellmProvider}/`) ? m : `${litellmProvider}/${m}`;
}

export type ConnectionInput = { apiBase?: string; apiVersion?: string; apiKey?: string };

/** The `credential_values` LiteLLM stores for this preset. Validates what the preset requires. */
export function credentialValues(p: Preset, input: ConnectionInput): Record<string, string> {
  const apiBase = (input.apiBase ?? '').trim() || p.defaultApiBase || '';
  const apiVersion = (input.apiVersion ?? '').trim();
  const apiKey = input.apiKey ?? '';
  if (p.apiBase === 'required' && !apiBase) throw bad(`${p.label} needs a base URL`);
  if (p.apiVersion && !apiVersion) throw bad(`${p.label} needs an API version (api_version, e.g. 2024-10-21)`);
  if (p.apiKey === 'required' && !apiKey.trim()) throw bad(`${p.label} needs an API key`);
  const out: Record<string, string> = {};
  if (apiBase) out.api_base = apiBase;
  if (apiVersion) out.api_version = apiVersion;
  if (apiKey.trim() && p.apiKey !== 'none') out.api_key = apiKey;
  return out;
}

/** LiteLLM credential names: a short slug (it is also how models reference it). */
export function validCredentialName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name ?? '');
}
