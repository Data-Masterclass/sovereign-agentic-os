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
 *   - A key replaced while a segment runs (migration, Rebuild, rotation): `ownKeyRetryFetch`
 *     re-reads the store on a 401 and repeats the call once with the new key, the same rule as
 *     the v1 caller; the old key also keeps working for a grace period (LiteLLM key expiry).
 *   - `maxRetries: 0`: retries belong to the gateway (`num_retries`) — one retry authority (03 §5.2).
 *     `timeout` just above LiteLLM's router timeout of 120 s (03 Revision 4).
 *     `parallel_tool_calls: false` for a system with any write tool (03 Revision 3).
 *   - `baseURL` / `apiKey` overrides exist for tests that point the same construction at the
 *     WP-02 harness's OpenAI-compatible stub; production passes neither.
 */
import { ChatOpenAI } from '@langchain/openai';
import { config } from '@core/kernel/config';
import { viaGateway } from '@core/adapters/litellm/gateway-fetch';
import { callerCredential, type CallerContext } from '@core/infra/litellm-credential';
import { forgetSystemKey, resolveSystemKey, tokenIdOf } from '@core/infra/agent-system-keys';
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
  /** How long to wait for a rotation's new key to be stored before concluding there is none (default 2 s). */
  rotationWaitMs?: number;
}): Fetched<ChatOpenAI> {
  const at = new Date().toISOString();
  const cred = input.caller ? callerCredential(input.caller, input.ownKey) : null;
  const apiKey = input.apiKey ?? cred?.apiKey ?? '';
  if (!apiKey) return { ok: false, reason: 'unauthorized', detail: 'no scoped run credential for the gateway (the master key is never used)', at };
  // An agent system's own key can be replaced while a segment runs (migration, Rebuild, rotation):
  // the same 401 → re-read the store → repeat once that the v1 caller has (`core/runtime/runtime.ts`).
  const systemId = input.caller?.keyRef && input.ownKey && !input.apiKey ? input.caller.keyRef.key : null;
  // Every module model call carries the platform's masking switch as LiteLLM's redaction header.
  const viaMasking = viaGateway(input.fetch);
  const fetchImpl = systemId
    ? ownKeyRetryFetch(systemId, input.ownKey!, viaMasking, input.rotationWaitMs ?? ROTATION_WAIT_MS)
    : viaMasking;
  const model = new ChatOpenAI({
    model: input.model,
    apiKey,
    configuration: { baseURL: input.baseURL ?? `${config.litellmUrl}/v1`, fetch: fetchImpl },
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

const ROTATION_WAIT_MS = 2_000;

/**
 * The HTTP client for one agent system's model calls (`configuration.fetch`, the OpenAI SDK's
 * documented client option). Every request carries the system's CURRENT key. When the gateway
 * answers 401, the key may have been replaced under the running segment: the store is re-read
 * (once more after `waitMs` if it still holds the same key), and if it now holds a different key
 * the request is repeated ONCE with it, and later requests use it. Otherwise the 401 stands. It
 * never moves a call onto any other credential.
 */
export function ownKeyRetryFetch(systemId: string, initialKey: string, base: typeof globalThis.fetch, waitMs: number): typeof globalThis.fetch {
  let current = initialKey;
  const withKey = (init: RequestInit | undefined, key: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${key}`);
    return { ...init, headers };
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = current;
    const res = await base(input, withKey(init, sent));
    if (res.status !== 401) return res;
    forgetSystemKey(systemId);
    let next = await resolveSystemKey(systemId, { fresh: true });
    if (tokenIdOf(next.key) === tokenIdOf(sent)) {
      await new Promise((r) => setTimeout(r, waitMs));
      next = await resolveSystemKey(systemId, { fresh: true });
    }
    if (tokenIdOf(next.key) === tokenIdOf(sent)) return res;
    current = next.key;
    return base(input, withKey(init, current));
  }) as typeof globalThis.fetch;
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
