/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Capture every OPA write and read inside one async call into a document tree.
 * USER STORY: As an operator I want the os-data bundle compiled by the very code that used to push
 *             to OPA, so the bundle holds exactly what the pushes held.
 * ARCHITECTURE:
 *   - Node's AsyncLocalStorage, scoped to the callback, published on `OPA_CAPTURE_KEY` where
 *     `opa-publish.ts` reads it (that module stays free of `node:` imports for client bundles).
 *   - Server-only: imported by the bundle compiler.
 */
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OPA_CAPTURE_KEY } from '@core/policy/opa-publish';

type Tree = Record<string, unknown>;

function als(): AsyncLocalStorage<{ tree: Tree }> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<{ tree: Tree }> | undefined>;
  return (g[OPA_CAPTURE_KEY] ??= new AsyncLocalStorage<{ tree: Tree }>());
}

/**
 * Run `fn` with every `publishOpa` / `readOpaData` call inside it applied to a copy of `base`
 * instead of OPA, and return the resulting document tree. A policy write inside a capture is
 * refused: the data bundle carries data only.
 */
export async function captureOpaWrites<T>(base: Tree, fn: () => Promise<T>): Promise<{ result: T; tree: Tree }> {
  const ctx = { tree: structuredClone(base) };
  const result = await als().run(ctx, fn);
  return { result, tree: ctx.tree };
}
