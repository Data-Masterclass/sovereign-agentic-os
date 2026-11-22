/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one `fetch` every model call to the LiteLLM gateway goes through
 * USER STORY: As a platform admin who switched Langfuse masking on, I want no model call - assistant,
 *             embeddings, agent module, run path - to leave a prompt or completion in the gateway's own
 *             Langfuse record, without each caller having to remember it.
 * ARCHITECTURE: a thin wrapper that adds LiteLLM's documented per-request redaction header
 *             (`x-litellm-enable-message-redaction`, core/runtime/gateway-trace.ts) while the platform's
 *             masking switch is ON or UNKNOWN (the unknown switch is the strictest level, see
 *             core/models/roles.ts). The switch is read per call: no restart. A guard test
 *             (`gateway-fetch.test.ts`) fails when a source calls a gateway model endpoint, or builds a
 *             `ChatOpenAI`, without this helper.
 */
import { gatewayMessageRedaction } from '@core/infra/masking-policy';

/**
 * `fetch` with the masking switch applied as request headers. `base` is the underlying fetch
 * (default: `globalThis.fetch`, resolved at call time so a test or a tracer can replace it).
 */
export function viaGateway(base?: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(await gatewayMessageRedaction())) headers.set(k, v);
    // A plain record, as the callers always passed (lower-case names): stand-in fetches read it that way.
    return (base ?? globalThis.fetch)(input, { ...init, headers: Object.fromEntries(headers.entries()) });
  }) as typeof globalThis.fetch;
}

/** The gateway `fetch` of every model call. */
export const gatewayFetch: typeof globalThis.fetch = viaGateway();
