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
 *   - Field groups (documented): core, basic (name, userId, isRootObservation …), io (input, output —
 *     returned as RAW STRINGS), metadata, usage, trace_context (tags, release, traceName). Fields of
 *     a group that is not requested are ABSENT, not null, so every reader that needs input/output or
 *     tags must request `io` / `trace_context`; ioText() throws when they are absent instead of
 *     reading an empty string (a vacuous pass).
 *     Docs: https://langfuse.com/docs/api-and-data-platform/features/observations-api
 *   - The v2 endpoint exists on Langfuse v4 only. On v3 it is absent and the hop is red (WP-33).
 *     There is deliberately NO fallback to the v1 API: the gate is the v4 record.
 */
import { baseUrl, LOCAL } from '../endpoints.mjs';
import { request, basic } from '../http.mjs';
import { HopError } from '../hop.mjs';

export async function observations({ traceId, userId, type, fields = 'core,basic,io,metadata,usage,trace_context', limit = 1000 } = {}) {
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
export const roots = (obs) => obs.filter((o) => o.isRootObservation ?? !o.parentObservationId);

/** The raw input/output string of an observation; throws when the `io` group was not returned. */
export function ioText(o, which = 'output') {
  if (!(which in o)) throw new HopError({ component: 'langfuse', hop: 'observations v2', reason: `observation ${o.id} has no \`${which}\` field: the io field group was not returned` });
  const v = o[which];
  return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
}

/** Trace tags; throws when the `trace_context` group was not returned. */
export function tagsOf(o) {
  if (!('tags' in o)) throw new HopError({ component: 'langfuse', hop: 'observations v2', reason: `observation ${o.id} has no \`tags\` field: the trace_context field group was not returned` });
  return o.tags ?? [];
}
