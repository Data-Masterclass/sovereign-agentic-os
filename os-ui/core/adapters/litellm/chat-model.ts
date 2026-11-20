/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The LangChain chat model for the LiteLLM gateway — the one door agent modules use
 * USER STORY: As the owner I want every model call of an agent module to go through the gateway
 *             with the run's scoped key and attribution, never the master key, and with exactly one
 *             retry authority, so spend caps and traces are the gateway's own.
 * ARCHITECTURE:
 *   - `ChatOpenAI` (`@langchain/openai`, MIT) with `configuration.baseURL` = the gateway's
 *     OpenAI-compatible `/v1` — the documented way to point it at an OpenAI-compatible server
 *     (https://docs.langchain.com/oss/javascript/integrations/chat/openai).
 *   - Credential: `callerCredential`. An agent-system call (`caller.keyRef`) carries ONLY that
 *     system's own key, resolved once per run segment from the encrypted store
 *     (`resolveRunModelKey`) and passed in as `ownKey`; with none it is refused, never moved onto
 *     the shared agent key. Other calls use the shared agent key; never the master key. Attribution as LiteLLM request metadata (`user`, `metadata.tags`)
 *     and `mask_output`, as the v1 caller sends it (`core/runtime/runtime.ts`).
 *   - `maxRetries: 0`: retries belong to the gateway (`num_retries`) — one retry authority (03 §5.2).
 *     `timeout` just above LiteLLM's router timeout of 120 s (03 Revision 4).
 *     `parallel_tool_calls: false` for a system with any write tool (03 Revision 3).
 *   - `baseURL` / `apiKey` overrides exist for tests that point the same construction at the
 *     WP-02 harness's OpenAI-compatible stub; production passes neither.
 */
import { ChatOpenAI } from '@langchain/openai';
import { config } from '@core/kernel/config';
import { callerCredential, type CallerContext } from '@core/infra/litellm-credential';
import { resolveSystemKey } from '@core/infra/agent-system-keys';
import type { Fetched } from '@core/adapters/_contract';

/** Just above LiteLLM's router `timeout: 120` (seconds). */
export const GATEWAY_MODEL_TIMEOUT_MS = 130_000;

export function gatewayChatModel(input: {
  model: string;
  caller?: CallerContext;
  /** The agent system's own key (from {@link resolveRunModelKey}); required when `caller.keyRef` is set. */
  ownKey?: string;
  writeSystem: boolean;
  baseURL?: string;
  apiKey?: string;
  /**
   * The HTTP client the OpenAI SDK uses (`configuration.fetch`, documented in the SDK's client
   * options) — the run's tracer passes one that sends the call's trace span as `traceparent`.
   */
  fetch?: typeof globalThis.fetch;
}): Fetched<ChatOpenAI> {
  const at = new Date().toISOString();
  const cred = input.caller ? callerCredential(input.caller, input.ownKey) : null;
  const apiKey = input.apiKey ?? cred?.apiKey ?? '';
  if (!apiKey) return { ok: false, reason: 'unauthorized', detail: 'no scoped run credential for the gateway (the master key is never used)', at };
  const model = new ChatOpenAI({
    model: input.model,
    apiKey,
    configuration: { baseURL: input.baseURL ?? `${config.litellmUrl}/v1`, ...(input.fetch ? { fetch: input.fetch } : {}) },
    maxRetries: 0,
    timeout: GATEWAY_MODEL_TIMEOUT_MS,
    modelKwargs: {
      ...(cred?.user ? { user: cred.user } : {}),
      ...(cred ? { metadata: { tags: cred.tags, mask_output: true } } : {}),
      ...(input.writeSystem ? { parallel_tool_calls: false } : {}),
    },
  });
  return { ok: true, value: model, at };
}

/** {@link gatewayChatModel}, or throw its typed reason (for a graph's model factory). */
export function requireGatewayChatModel(input: Parameters<typeof gatewayChatModel>[0]): ChatOpenAI {
  const r = gatewayChatModel(input);
  if (!r.ok) throw new Error(`gateway model ${input.model}: ${r.reason} — ${r.detail}`);
  return r.value;
}

/**
 * The key a native-module run segment uses for its model calls: the agent system's own key,
 * decrypted from the durable store, when the caller carries `keyRef`; `undefined` for any other
 * caller. A system with no usable key throws `SystemKeyUnavailableError` ("press Build") before
 * any model call is made. Read fresh, so a key replaced by a Rebuild or rotation is picked up by
 * the next segment.
 */
export async function resolveRunModelKey(caller: CallerContext): Promise<string | undefined> {
  if (!caller.keyRef) return undefined;
  return (await resolveSystemKey(caller.keyRef.key, { fresh: true })).key;
}
