/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Request surface context — "which UI route or MCP tool caused this write?"
 * USER STORY: As an engineer reading a domain repo's git log I want every commit to name the
 *             surface that caused it (`ui:<route>` or `mcp:<tool>`) and a request id, so a
 *             change made through the OS MCP and one made in the UI are distinguishable.
 * ARCHITECTURE:
 *   - AsyncLocalStorage (node only). The route wrapper (`core/kernel/route-server.ts`) and the
 *     data MCP tools wrap their handler in `runWithSurface`; the commit hook reads
 *     `currentSurface()` at mutation time. Nothing is threaded through store signatures.
 *   - Never imported by a module reachable from the client bundle (node:async_hooks).
 *   - Absent context ⇒ `null`; callers fall back to a documented default and say so.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type RequestSurface = {
  surface: string;
  requestId: string;
  /**
   * The agent run this scope is inside, when it is inside one. Set by the granted-tool executor
   * around its governed dispatch, so a write a RUN caused can be told from one a person made at
   * the same moment — it becomes the `OS-Run-Id` commit trailer (Part D review L-3).
   */
  runId?: string;
};

const KEY = Symbol.for('soa.request-surface');
function als(): AsyncLocalStorage<RequestSurface> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestSurface> | undefined>;
  if (!g[KEY]) g[KEY] = new AsyncLocalStorage<RequestSurface>();
  return g[KEY]!;
}

/** A fresh request id (`req_` + 16 hex). Minted once per surface scope. */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Run `fn` with `surface` as the ambient request surface (and a minted request id unless given).
 * A nested scope KEEPS the outer scope's run id: the surface changes as a call moves from a route
 * to an MCP tool, but the run it belongs to does not.
 */
export function runWithSurface<T>(surface: string, fn: () => T, requestId?: string): T {
  const outer = currentSurface();
  const next: RequestSurface = { surface, requestId: requestId ?? newRequestId() };
  if (outer?.runId) next.runId = outer.runId;
  return als().run(next, fn);
}

/**
 * Run `fn` inside the CURRENT surface with `runId` attached — what the granted-tool executor wraps
 * its governed dispatch in, so everything the run causes (including the commit a nested MCP write
 * produces) can name the run. Outside any surface it still establishes one, so the run id is never
 * lost just because the caller had no route.
 */
export function runWithRunId<T>(runId: string, fn: () => T): T {
  const outer = currentSurface();
  return als().run({ surface: outer?.surface ?? 'system:agent-run', requestId: outer?.requestId ?? newRequestId(), runId }, fn);
}

/** The ambient surface, or null outside any `runWithSurface` scope. */
export function currentSurface(): RequestSurface | null {
  return als().getStore() ?? null;
}

/** `ui:<route>` for a request URL: the pathname with the `/api/` prefix dropped. */
export function uiSurfaceFor(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://local').pathname;
  } catch {
    pathname = url;
  }
  return `ui:${pathname.replace(/^\/api\//, '').replace(/^\//, '')}`;
}
