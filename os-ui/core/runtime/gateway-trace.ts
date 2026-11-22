/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    How a model call tells the gateway which trace its Langfuse generation belongs to
 * USER STORY: As an engineer I open a run's trace in Langfuse and find the gateway's generation for
 *             each model call inside it, with the gateway's usage and cost, and I can match any
 *             generation to the OS observation that made the call by one id.
 * ARCHITECTURE:
 *   - LiteLLM >= 1.109 records the generation through its OpenTelemetry v2 `langfuse_otel`
 *     callback. That callback ignores the legacy body fields `existing_trace_id` and
 *     `parent_observation_id`. It continues a W3C `traceparent` header instead, and it uses the
 *     `x-litellm-call-id` header as the call id it reports
 *     (https://docs.litellm.ai/docs/observability/langfuse_to_otel_v2_migration, "Field changes").
 *   - `traceparent` is `00-<32 hex trace id>-<16 hex parent span id>-01` (W3C Trace Context).
 *     It is sent only when the caller's ids are in that form: a header made from other ids would
 *     point the generation at a trace that does not exist. Without it the gateway starts its own
 *     trace for the call; the call id still links the two.
 *   - The call id is minted here when the caller did not bring one, and returned, so the caller can
 *     record it on its own observation (`litellm_call_id`).
 *   - Pure: no I/O, no config. scripts/tests/litellm-langfuse proves the headers against the real
 *     LiteLLM and Langfuse images.
 */
import { randomUUID } from 'node:crypto';

/** The trace context of a model call, as `LlmRequest.observe` carries it. */
export type GatewayTraceContext = {
  /** The trace the call belongs to. Nests the gateway's generation only when it is 32 hex chars. */
  traceId: string;
  /** The observation that makes the call. Nests the generation only when it is 16 hex chars. */
  parentObservationId?: string;
  /** The id the gateway reports for this call. Minted when absent. */
  callId?: string;
};

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ALL_ZERO = /^0+$/;

/** The W3C `traceparent` for a sampled span, or null when the ids are not W3C ids. */
export function traceparentFor(traceId: string, spanId: string | undefined): string | null {
  if (!spanId || !TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return null;
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return null; // invalid per the W3C spec
  return `00-${traceId}-${spanId}-01`;
}

/** The headers that link one gateway call to the caller's trace, and the call id they carry. */
export function gatewayTraceHeaders(observe: GatewayTraceContext | undefined): { headers: Record<string, string>; callId: string } {
  const callId = observe?.callId || randomUUID();
  const headers: Record<string, string> = { 'x-litellm-call-id': callId };
  const traceparent = observe ? traceparentFor(observe.traceId, observe.parentObservationId) : null;
  if (traceparent) headers.traceparent = traceparent;
  return { headers, callId };
}

/**
 * LiteLLM's documented per-request switch for message redaction: with this header the call's
 * messages and response are replaced by "redacted-by-litellm" before any logging callback
 * (`langfuse_otel` included) runs, whatever the gateway's global `turn_off_message_logging` is.
 * https://docs.litellm.ai/docs/proxy/logging#redact-messages-response-content
 */
export const GATEWAY_REDACTION_HEADER = 'x-litellm-enable-message-redaction';

/** The redaction header when the platform's masking switch is on, otherwise no header at all. */
export function gatewayRedactionHeaders(on: boolean): Record<string, string> {
  return on ? { [GATEWAY_REDACTION_HEADER]: 'true' } : {};
}
