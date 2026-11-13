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

export type RequestSurface = { surface: string; requestId: string };

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

/** Run `fn` with `surface` as the ambient request surface (and a minted request id unless given). */
export function runWithSurface<T>(surface: string, fn: () => T, requestId?: string): T {
  return als().run({ surface, requestId: requestId ?? newRequestId() }, fn);
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
