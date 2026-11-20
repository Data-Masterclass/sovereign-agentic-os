/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Script the model stub and read its request counter
 * USER STORY: As a journey I want to know exactly how many model calls reached the upstream, so
 *             "N GENERATIONs in Langfuse" can be compared with N, the real number of calls.
 * ARCHITECTURE:
 *   - Talks to tests/e2e/kind/model-stub/stub.py through the chart's `mock-model` Service.
 */
import { baseUrl } from '../endpoints.mjs';
import { request } from '../http.mjs';

const url = async (p) => `${await baseUrl('stub')}${p}`;
export const reset = async () => (await request('model-stub', 'reset', await url('/__stub/reset'), { method: 'POST', body: {} })).data;
export const loadScript = async (steps) => (await request('model-stub', 'script', await url('/__stub/script'), { method: 'POST', body: { steps } })).data;
export const stats = async () => (await request('model-stub', 'stats', await url('/__stub/stats'))).data;
export const requests = async () => (await request('model-stub', 'requests', await url('/__stub/requests'))).data.requests;
/** Number of chat completions that reached the stub (and were answered from the script). */
export async function chatCount() {
  return (await requests()).filter((r) => r.path.endsWith('/chat/completions') && !r.error).length;
}
