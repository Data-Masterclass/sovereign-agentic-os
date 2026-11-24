/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one door for the account connectors' calls to vendor APIs (Microsoft Graph, Google Drive)
 * USER STORY: As a user I want a refused sign-in, a missing file or an unreachable Microsoft or Google API
 *             to show up as exactly that, with its reason, never as an empty result.
 * ARCHITECTURE:
 *   - GLUE-1: only `core/adapters/**` calls `fetch`; the account tools (`tabs/connections/lib/account-tools.ts`)
 *     and the OAuth subject probe go through `saasRequest`. The bearer token is passed in per call and only
 *     sent to the vendor; it is never logged or returned.
 *   - Returns the `Fetched` contract: an HTTP 401/403/404/408/409 or a transport failure is `ok:false`
 *     with its reason and status; the body of a failure is never read or echoed (it can carry request data).
 *   - A response larger than `maxBytes` is refused (`invalid`, status 413) instead of buffered.
 *   - `fetchImpl` is injectable so the callers unit-test against a fake vendor.
 */
import type { Fetched, FetchedFailure } from '@core/adapters/_contract';

export type SaasResponse = { status: number; contentType: string; bytes: Buffer };
export type SaasFailure = { status: number };
export type SaasFetch = typeof fetch;

const REASON: Record<number, FetchedFailure> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 408: 'timeout', 409: 'conflict', 413: 'invalid' };

/** The HTTP status a failed `saasRequest` carried (0 = no answer), from its detail. */
export function failureStatus(f: { detail: string }): number {
  const m = /^HTTP (\d{3})/.exec(f.detail);
  return m ? Number(m[1]) : 0;
}

export async function saasRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; bearer: string; timeoutMs?: number; maxBytes?: number },
  fetchImpl?: SaasFetch,
): Promise<Fetched<SaasResponse>> {
  const at = () => new Date().toISOString();
  const f = fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${init.bearer}`, accept: 'application/json', ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'unreachable', detail: aborted ? 'HTTP 000 timed out' : `HTTP 000 ${(e as Error)?.message ?? 'unreachable'}`, at: at() };
  }
  if (!res.ok) {
    clearTimeout(timer);
    return { ok: false, reason: REASON[res.status] ?? 'unreachable', detail: `HTTP ${res.status}`, at: at() };
  }
  const max = init.maxBytes ?? 32 * 1024 * 1024;
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    clearTimeout(timer);
    return { ok: false, reason: 'invalid', detail: `HTTP 413 the response is ${declared} bytes, over the ${max}-byte limit`, at: at() };
  }
  try {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > max) return { ok: false, reason: 'invalid', detail: `HTTP 413 the response is over the ${max}-byte limit`, at: at() };
    return { ok: true, value: { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes }, at: at() };
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: `HTTP 000 the response broke off (${(e as Error)?.message ?? 'read failed'})`, at: at() };
  } finally {
    clearTimeout(timer);
  }
}
