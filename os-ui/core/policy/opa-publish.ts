/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one way os-ui writes runtime state into OPA.
 * USER STORY: As an operator I want every runtime OPA write (grants, governance principals and
 *             tables, approval holds, knowledge guardrails) to go through one function, so the
 *             reconciler that restores them after an OPA restart writes exactly what the
 *             change paths write, and every failure is reported the same way.
 * ARCHITECTURE:
 *   - Thin wrappers over OPA's documented REST API (https://www.openpolicyagent.org/docs/rest-api):
 *     `PUT/DELETE /v1/data/{path}` (Data API, PUT is an upsert), `PUT /v1/policies/{id}`
 *     (Policy API), `GET /v1/data/{path}` (an undefined document returns `{}` with no `result`)
 *     and `GET /health` (Health API: 200 once the server is ready).
 *   - Never throws. Every call returns `{ ok, status, detail }`; the caller decides whether a
 *     failure is fatal. Nothing is swallowed: an unreachable OPA is `ok:false, status:null`.
 *   - The HTTP itself is the OPA adapter (`core/adapters/opa/client.ts`, `Fetched` contract).
 *   - Kernel module: no tab imports. Interim until WP-11 moves this data into an OPA bundle.
 */
import { opaDeleteData, opaGetData, opaGetPolicy, opaHealth, opaPutData, opaPutPolicy } from '@core/adapters/opa/client';

export type OpaWrite =
  /** Upsert a data document (`PUT /v1/data/{path}`). */
  | { kind: 'data'; path: string; value: unknown }
  /** Remove a data document (`DELETE /v1/data/{path}`; an absent document counts as done). */
  | { kind: 'delete'; path: string }
  /** Create or replace a policy module (`PUT /v1/policies/{id}`). */
  | { kind: 'policy'; id: string; rego: string };

/** `status: null` = OPA was not reached at all (unreachable or timed out). */
export type OpaWriteResult = { ok: boolean; status: number | null; detail: string };

const DEFAULT_TIMEOUT_MS = 5000;

function describe(w: OpaWrite): string {
  return w.kind === 'policy' ? `policy ${w.id}` : `${w.kind === 'delete' ? 'DELETE' : 'PUT'} data/${w.path}`;
}

/** Write one document or policy to OPA. Never throws. */
export async function publishOpa(w: OpaWrite, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<OpaWriteResult> {
  const r =
    w.kind === 'policy' ? await opaPutPolicy(w.id, w.rego, timeoutMs)
    : w.kind === 'delete' ? await opaDeleteData(w.path, timeoutMs)
    : await opaPutData(w.path, w.value, timeoutMs);
  if (r.ok) return { ok: true, status: r.value, detail: describe(w) };
  const reached = r.reason !== 'unreachable' && r.reason !== 'timeout';
  return { ok: false, status: reached ? 0 : null, detail: r.detail };
}

/** Apply writes in order; stops at the first failure and returns it. */
export async function publishOpaAll(writes: OpaWrite[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ ok: boolean; written: number; detail: string }> {
  let written = 0;
  for (const w of writes) {
    const r = await publishOpa(w, timeoutMs);
    if (!r.ok) return { ok: false, written, detail: r.detail };
    written++;
  }
  return { ok: true, written, detail: `${written} write(s)` };
}

/** Read a data document. `defined:false` = OPA answered and the document does not exist. */
export async function readOpaData(path: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ reachable: boolean; defined: boolean; value?: unknown; detail?: string }> {
  const r = await opaGetData(path, timeoutMs);
  if (!r.ok) return { reachable: false, defined: false, detail: r.detail };
  return { reachable: true, ...r.value };
}

/** Is this policy module loaded (Policy API GET)? */
export async function opaPolicyLoaded(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  return (await opaGetPolicy(id, timeoutMs)).ok;
}

/** OPA's Health API: true only when `GET /health` answers 200. */
export async function opaHealthy(timeoutMs = 2500): Promise<boolean> {
  return (await opaHealth(timeoutMs)).ok;
}
