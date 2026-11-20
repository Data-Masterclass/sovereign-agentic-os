/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The headers that link a gateway call to the caller's trace
 * USER STORY: As an engineer I can trust that every gateway call names itself by a call id, and
 *             nests under the caller's span only when the ids are real W3C ids.
 * ARCHITECTURE:
 *   - Unit test of the pure header builder (core/runtime/gateway-trace.ts). The proof against the
 *     real LiteLLM and Langfuse images is tracing.e2e.test.ts via scripts/tests/litellm-langfuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayTraceHeaders, traceparentFor } from './gateway-trace';

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const S = '00f067aa0ba902b7';

test('traceparent: W3C form for W3C ids, nothing for anything else', () => {
  assert.equal(traceparentFor(T, S), `00-${T}-${S}-01`);
  assert.equal(traceparentFor('run_8c1f0f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', S), null, 'an OS run id is not a W3C trace id');
  assert.equal(traceparentFor(T, '9c1f0f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'), null, 'a UUID is not a W3C span id');
  assert.equal(traceparentFor(T, undefined), null);
  assert.equal(traceparentFor('0'.repeat(32), S), null, 'all-zero ids are invalid');
  assert.equal(traceparentFor(T.toUpperCase(), S), null, 'W3C ids are lower-case hex');
});

test('gateway headers: the call id is always sent and returned; traceparent only with W3C ids', () => {
  const nested = gatewayTraceHeaders({ traceId: T, parentObservationId: S, callId: 'c-1' });
  assert.deepEqual(nested, { headers: { 'x-litellm-call-id': 'c-1', traceparent: `00-${T}-${S}-01` }, callId: 'c-1' });
  const legacyIds = gatewayTraceHeaders({ traceId: 'run_x', parentObservationId: 'gen-uuid' });
  assert.equal(legacyIds.headers.traceparent, undefined);
  assert.equal(legacyIds.headers['x-litellm-call-id'], legacyIds.callId);
  const none = gatewayTraceHeaders(undefined);
  assert.match(none.callId, /^[0-9a-f-]{36}$/);
  assert.notEqual(none.callId, gatewayTraceHeaders(undefined).callId, 'a fresh id per call');
});
