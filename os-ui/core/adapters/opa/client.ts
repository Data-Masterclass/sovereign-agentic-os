/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OPA REST adapter for runtime state writes and reads.
 * USER STORY: As an operator I want an OPA that is down or refusing a write to show up as exactly
 *             that, with its reason, so a lost grant is never reported as published.
 * ARCHITECTURE:
 *   - OPA's documented REST API (https://www.openpolicyagent.org/docs/rest-api): Data API
 *     `PUT/DELETE/GET /v1/data/{path}` (an undefined document is 200 `{}` with no `result`),
 *     Policy API `PUT/GET /v1/policies/{id}`, Health API `GET /health`.
 *   - Returns the `Fetched` contract; never throws. Callers go through `core/policy/opa-publish.ts`.
 */
import { config } from '@core/kernel/config';
import type { Fetched, FetchedFailure } from '@core/adapters/_contract';

const now = () => new Date().toISOString();
const fail = (reason: FetchedFailure, detail: string): Fetched<never> => ({ ok: false, reason, detail, at: now() });

function reasonFor(status: number): FetchedFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  return 'invalid';
}

async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Fetched<Response>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.opaUrl}${path}`, { ...init, signal: ctrl.signal, cache: 'no-store' });
    return { ok: true, value: res, at: now() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return fail(aborted ? 'timeout' : 'unreachable', `OPA ${aborted ? 'timed out' : 'unreachable'} at ${config.opaUrl}${path}`);
  } finally {
    clearTimeout(timer);
  }
}

async function expectOk(r: Fetched<Response>, what: string, absentOk = false): Promise<Fetched<number>> {
  if (!r.ok) return r;
  const res = r.value;
  if (res.ok || (absentOk && res.status === 404)) return { ok: true, value: res.status, at: r.at };
  const body = (await res.text().catch((err) => `(body unreadable: ${String(err)})`)).slice(0, 200);
  return fail(reasonFor(res.status), `${what}: OPA ${res.status}${body ? ` ${body}` : ''}`);
}

export async function opaPutData(path: string, value: unknown, timeoutMs: number): Promise<Fetched<number>> {
  const r = await request(`/v1/data/${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }, timeoutMs);
  return expectOk(r, `PUT data/${path}`);
}

/** DELETE a data document; an already-absent document (404) counts as done. */
export async function opaDeleteData(path: string, timeoutMs: number): Promise<Fetched<number>> {
  return expectOk(await request(`/v1/data/${path}`, { method: 'DELETE' }, timeoutMs), `DELETE data/${path}`, true);
}

export async function opaPutPolicy(id: string, rego: string, timeoutMs: number): Promise<Fetched<number>> {
  const r = await request(`/v1/policies/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: rego }, timeoutMs);
  return expectOk(r, `PUT policy ${id}`);
}

export async function opaGetPolicy(id: string, timeoutMs: number): Promise<Fetched<number>> {
  return expectOk(await request(`/v1/policies/${encodeURIComponent(id)}`, { method: 'GET' }, timeoutMs), `GET policy ${id}`);
}

/** Read a data document: `defined:false` = OPA answered and the document does not exist. */
export async function opaGetData(path: string, timeoutMs: number): Promise<Fetched<{ defined: boolean; value?: unknown }>> {
  const r = await request(`/v1/data/${path}`, { method: 'GET' }, timeoutMs);
  if (!r.ok) return r;
  if (!r.value.ok) return fail(reasonFor(r.value.status), `GET data/${path}: OPA ${r.value.status}`);
  let body: { result?: unknown };
  try {
    body = (await r.value.json()) as { result?: unknown };
  } catch (err) {
    return fail('invalid', `GET data/${path}: unreadable JSON (${String(err)})`);
  }
  return { ok: true, value: 'result' in body ? { defined: true, value: body.result } : { defined: false }, at: r.at };
}

/** OPA's Health API: ok only when `GET /health` answers 200. */
export async function opaHealth(timeoutMs: number): Promise<Fetched<number>> {
  return expectOk(await request('/health', { method: 'GET' }, timeoutMs), 'GET /health');
}
