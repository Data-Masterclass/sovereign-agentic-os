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
 *   - Kernel module: no tab imports.
 *   - WP-11 (bundles). Two more modes, so every change path stays exactly as it is:
 *       • CAPTURE (`captureOpaWrites`, used by the os-data bundle compiler): inside the callback,
 *         writes land in an in-memory document tree and reads come from it. The compiler runs the
 *         SAME restore sources the push path runs, so the bundle carries exactly what the pushes
 *         would have written (proved against two real OPAs in tests/opa/bundle-parity.int.test.ts).
 *       • BUNDLE MODE (`OS_OPA_DATA_BUNDLE=1`): a write under a root the os-data bundle owns is
 *         NOT sent to OPA (OPA itself refuses it: "path … is owned by bundle"); it asks the bundle
 *         to recompile instead, and the change reaches OPA on its next poll. Paths outside the
 *         roots (promotion releases, knowledge guardrails, the canary) are still written.
 */
import { config } from '@core/kernel/config';
import { opaDeleteData, opaGetData, opaGetPolicy, opaHealth, opaPutData, opaPutPolicy } from '@core/adapters/opa/client';

/**
 * The data roots the `os-data` bundle owns (its `.manifest` `roots`). Every document os-ui used to
 * push under these paths now arrives by bundle. `governance/releases` (a promotion's transient
 * one-reader exemption, WP-36 moves it to approved writes) stays outside on purpose.
 */
export const OS_DATA_ROOTS = ['grants', 'seed_grants', 'requires_approval', 'governance/tables', 'governance/principals', 'os_data'] as const;

/** The OPA path segments of `path` (OPA splits on `/` and URL-decodes each segment). */
export function opaPathSegments(path: string): string[] {
  return path.split('/').filter(Boolean).map((seg) => decodeURIComponent(seg));
}

/** Is `path` under one of the `os-data` bundle's roots? */
export function ownedByOsDataBundle(path: string): boolean {
  const segs = opaPathSegments(path);
  return OS_DATA_ROOTS.some((root) => {
    const r = root.split('/');
    return r.every((x, i) => segs[i] === x);
  });
}

type Tree = Record<string, unknown>;
/**
 * The active capture, if any. The AsyncLocalStorage lives in `opa-capture.ts` (server-only), which
 * publishes it on this symbol, so this module stays importable from code that a client bundle
 * reaches (no `node:` import here).
 */
export const OPA_CAPTURE_KEY = Symbol.for('soa.policy.opa-capture');
const capture = {
  getStore(): { tree: Tree } | undefined {
    const als = (globalThis as unknown as Record<symbol, { getStore(): { tree: Tree } | undefined } | undefined>)[OPA_CAPTURE_KEY];
    return als?.getStore();
  },
};

function isObj(v: unknown): v is Tree {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function treeSet(tree: Tree, segs: string[], value: unknown): void {
  let node = tree;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node[seg])) node[seg] = {};
    node = node[seg] as Tree;
  }
  node[segs[segs.length - 1]] = structuredClone(value);
}

function treeDelete(tree: Tree, segs: string[]): void {
  let node: unknown = tree;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node)) return;
    node = node[seg];
  }
  if (isObj(node)) delete node[segs[segs.length - 1]];
}

function treeGet(tree: Tree, segs: string[]): { defined: boolean; value?: unknown } {
  let node: unknown = tree;
  for (const seg of segs) {
    if (!isObj(node) || !(seg in node)) return { defined: false };
    node = node[seg];
  }
  return { defined: true, value: structuredClone(node) };
}

type BundledWriteListener = (path: string) => void;
const listeners = new Set<BundledWriteListener>();
/** The os-data bundle registers here to recompile when a bundled document changes. */
/** Does THIS process serve the os-data bundle (os-ui with `startOsDataBundle`)? In bundle mode a
 *  write under a bundle root only reaches OPA through that recompile — a process with no listener
 *  (the agent-runs worker) would drop it, so callers that promise "immediate" must check this. */
export function bundledWritesServedHere(): boolean {
  return listeners.size > 0;
}

export function onBundledWrite(fn: BundledWriteListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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
  const cap = capture.getStore();
  if (cap) {
    if (w.kind === 'policy') return { ok: false, status: null, detail: `policy ${w.id}: a data bundle carries no policy modules` };
    const segs = opaPathSegments(w.path);
    if (w.kind === 'delete') treeDelete(cap.tree, segs);
    else treeSet(cap.tree, segs, w.value);
    return { ok: true, status: 200, detail: `${describe(w)} (bundle)` };
  }
  if (w.kind !== 'policy' && config.opaDataBundle && ownedByOsDataBundle(w.path)) {
    for (const l of listeners) l(w.path);
    return { ok: true, status: 202, detail: `${describe(w)} → os-data bundle recompile` };
  }
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
  const cap = capture.getStore();
  if (cap) return { reachable: true, ...treeGet(cap.tree, opaPathSegments(path)) };
  const r = await opaGetData(path, timeoutMs);
  if (!r.ok) return { reachable: false, defined: false, detail: r.detail };
  return { reachable: true, ...r.value };
}

/** Is this policy module loaded (Policy API GET)? */
export async function opaPolicyLoaded(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  return (await opaGetPolicy(id, timeoutMs)).ok;
}

/** OPA's Health API with `?bundles`: true only once every configured bundle is activated. */
export async function opaBundlesActive(timeoutMs = 2500): Promise<boolean> {
  return (await opaHealth(timeoutMs, true)).ok;
}

/** OPA's Health API: true only when `GET /health` answers 200. */
export async function opaHealthy(timeoutMs = 2500): Promise<boolean> {
  return (await opaHealth(timeoutMs)).ok;
}
