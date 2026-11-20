/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read LiteLLM's own spend logs
 * USER STORY: As AT-a I want "the ingest pipeline embedded through LiteLLM with the
 *             opensearch-ingest key" to be LiteLLM's spend record for that key.
 * ARCHITECTURE:
 *   - GET /spend/logs (admin, master key). Each row has request_id (the litellm call id),
 *     api_key (hashed), user, model, startTime and metadata.user_api_key_alias.
 *     Docs: https://docs.litellm.ai/docs/proxy/cost_tracking
 */
import { baseUrl, LOCAL } from '../endpoints.mjs';
import { request } from '../http.mjs';

export async function spendLogs({ startDate, endDate } = {}) {
  const qs = new URLSearchParams();
  if (startDate) qs.set('start_date', startDate);
  if (endDate) qs.set('end_date', endDate);
  const { data } = await request('litellm', 'spend logs', `${await baseUrl('litellm')}/spend/logs?${qs}`, {
    headers: { authorization: `Bearer ${LOCAL.litellmMasterKey}` },
  });
  return Array.isArray(data) ? data : data.data ?? [];
}

export const byKeyAlias = (rows, alias) => rows.filter((r) => r.metadata?.user_api_key_alias === alias);
