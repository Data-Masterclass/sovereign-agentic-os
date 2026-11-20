/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read Langfuse's own observations (Observations API v2, Langfuse v4)
 * USER STORY: As AT-a/AT-c/AT-d I want "one trace, as the user, with exactly N model generations"
 *             to be Langfuse's record, so a dropped generation or a second root is visible.
 * ARCHITECTURE:
 *   - GET /api/public/v2/observations?traceId=&type=&fields=&limit=&cursor= with Basic auth
 *     (project public:secret key). Follows meta.cursor until absent.
 *     Docs: https://langfuse.com/docs/api-and-data-platform/features/observations-api
 *   - The v2 endpoint exists on Langfuse v4 only. On v3 it is absent and the hop is red (WP-33).
 *     There is deliberately NO fallback to the v1 API: the gate is the v4 record.
 */
import { baseUrl, LOCAL } from '../endpoints.mjs';
import { request, basic } from '../http.mjs';
import { HopError } from '../hop.mjs';

export async function observations({ traceId, userId, type, fields = 'core,basic,usage,metadata', limit = 1000 } = {}) {
  const base = await baseUrl('langfuse');
  const out = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ limit: String(limit), fields });
    if (traceId) qs.set('traceId', traceId);
    if (userId) qs.set('userId', userId);
    if (type) qs.set('type', type);
    if (cursor) qs.set('cursor', cursor);
    const { status, data } = await request('langfuse', 'observations v2', `${base}/api/public/v2/observations?${qs}`, {
      headers: { authorization: basic(LOCAL.langfusePublicKey, LOCAL.langfuseSecretKey) },
      okStatus: [404],
    });
    if (status === 404) throw new HopError({ component: 'langfuse', hop: 'observations v2', reason: 'GET /api/public/v2/observations is absent: this is not Langfuse v4', wp: 'WP-33' });
    const rows = data.data ?? data.observations ?? [];
    out.push(...rows);
    cursor = data.meta?.cursor;
  } while (cursor);
  return out;
}

export const byType = (obs, t) => obs.filter((o) => o.type === t);
export const roots = (obs) => obs.filter((o) => !o.parentObservationId);
