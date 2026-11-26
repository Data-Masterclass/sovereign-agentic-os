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
 *     with its reason and status. The body of a failure is never echoed (it can carry request data); of a 403
 *     only the vendor's error CODE is kept (`code=<Identifier>`, a strict identifier pattern) plus whether
 *     its message speaks of a missing permission (`permission`), so a caller can tell "your sign-in lacks a
 *     scope" from "a mailbox policy refused it" without the text.
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

/** The vendor's error code a 403 carried (`ErrorAccessDenied`, `Authorization_RequestDenied`, …), or null. */
export function failureErrorCode(f: { detail: string }): string | null {
  const m = / code=([A-Za-z_.]{1,64})(?: |$)/.exec(f.detail);
  return m ? m[1] : null;
}

/** Did the vendor's 403 message speak of a missing permission, scope or consent? (The text itself is never kept.) */
export function failureMentionsPermission(f: { detail: string }): boolean {
  return / permission$/.test(f.detail) || / permission /.test(f.detail);
}

const ERROR_CODE = /^[A-Za-z_.]{1,64}$/;
const PERMISSION_WORDING = /\b(scopes?|permissions?|consent|privileges?|insufficient)\b/i;

/** JSON.parse as a result: `parsed: false` is the parse failure, for the caller to name. */
function parseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false };
  }
}

/**
 * Of a 403 body, the error code and a permission flag only (Graph / OData `{ error: { code, message } }`).
 * A body that is not that shape adds nothing: the status alone is then the whole answer.
 */
async function forbiddenDetail(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return ' code-unreadable'; // the 403 stands; its body broke off, and the detail says so
  }
  const parsed = parseJson(text.slice(0, 8192));
  if (!parsed.parsed || !parsed.value || typeof parsed.value !== 'object') return ' code-unknown';
  const err = (parsed.value as { error?: { code?: unknown; message?: unknown } }).error;
  const code = typeof err?.code === 'string' && ERROR_CODE.test(err.code) ? ` code=${err.code}` : ' code-unknown';
  const perm = typeof err?.message === 'string' && PERMISSION_WORDING.test(err.message) ? ' permission' : '';
  return `${code}${perm}`;
}

/** The Retry-After seconds a 429 carried, from its detail; null when the service did not say. */
export function failureRetryAfter(f: { detail: string }): number | null {
  const m = /^HTTP 429 retry-after=(\d+)/.exec(f.detail);
  return m ? Number(m[1]) : null;
}

export async function saasRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; bearer: string | null; timeoutMs?: number; maxBytes?: number },
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
      headers: { ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), accept: 'application/json', ...(init.headers ?? {}) },
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
    // A 429 carries the service's Retry-After (seconds), so the caller can say honestly when to try again.
    const retryAfter = res.status === 429 ? Number.parseInt(res.headers.get('retry-after') ?? '', 10) : Number.NaN;
    const extra = res.status === 403 ? await forbiddenDetail(res) : '';
    const detail = Number.isFinite(retryAfter) && retryAfter >= 0 ? `HTTP ${res.status} retry-after=${retryAfter}` : `HTTP ${res.status}${extra}`;
    return { ok: false, reason: REASON[res.status] ?? 'unreachable', detail, at: at() };
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
