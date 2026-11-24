/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one door to STACKIT KMS — encrypt / decrypt of a connection-credential data key
 * USER STORY: As an admin who keeps the master key in STACKIT KMS I want a KMS that is down, slow or
 *             refusing my token to show up as exactly that — never as a wrong key or a silent success.
 * ARCHITECTURE:
 *   - POST <url> with `Authorization: Bearer <token>` and `{ data: <base64> }`; the answer's `data`.
 *     The URL is built and validated by the `stackit` key provider (core/infra/key-providers.ts:
 *     https://….stackit.cloud only) from the same routes the official, Apache-2.0 stackit-sdk-go
 *     `services/kms/v1api` client calls. No SDK dependency.
 *   - Returns `Fetched<string>` (core/adapters/_contract.ts): 401 unauthorized, 403 forbidden,
 *     404 not_found, 400 invalid, a 10 s timeout, anything else unreachable. Never throws for an
 *     expected failure; never logs the token or the data.
 *   - `fetch` is injectable (tests run against a mock KMS); the default is the global fetch. os-ui and
 *     the worker reach it over the chart's direct-HTTPS egress (networkPolicies.directHttpsEgress).
 */
import type { Fetched, FetchedFailure } from '../_contract';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
export type KmsRequest = { url: string; token: string; data: string };
export type KmsCall = (req: KmsRequest) => Promise<Fetched<string>>;

export const KMS_TIMEOUT_MS = 10_000;

const at = () => new Date().toISOString();
const failed = (reason: FetchedFailure, detail: string): Fetched<string> => ({ ok: false, reason, detail, at: at() });

export function stackitKmsCall(fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>): KmsCall {
  return async ({ url, token, data }) => {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(KMS_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return failed(timedOut ? 'timeout' : 'unreachable', timedOut ? `no answer within ${KMS_TIMEOUT_MS / 1000} s` : `unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const byStatus: Record<number, FetchedFailure> = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
    if (res.status < 200 || res.status >= 300) return failed(byStatus[res.status] ?? 'unreachable', `answered ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      return failed('invalid', `answer is not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    const out = (body as { data?: unknown })?.data;
    if (typeof out !== 'string') return failed('invalid', 'no data in the answer');
    return { ok: true, value: out, at: at() };
  };
}
