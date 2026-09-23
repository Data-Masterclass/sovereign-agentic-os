/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from './server';

export type ToolBundle = {
  name: string;
  tools: McpTool[];
  /** Optional store warm-up, called once per request alongside every other
   *  registered bundle's hydrate — so server.ts never names a module directly. */
  hydrate?: () => Promise<void>;
};

const bundles: ToolBundle[] = [];
const registeredNames = new Set<string>();

/** Register a bundle. Safe to call more than once for the same name (e.g.
 *  hot reload) — a bundle registers only once. */
export function registerToolBundle(bundle: ToolBundle): void {
  if (registeredNames.has(bundle.name)) return;
  registeredNames.add(bundle.name);
  bundles.push(bundle);
}

/** Every tool registered so far, across all registered bundles. */
export function getRegisteredTools(): McpTool[] {
  return bundles.flatMap((b) => b.tools);
}

/** Whether a given bundle name has been registered — used to give a clean
 *  "feature not enabled" answer instead of a crash for a disabled tool. */
export function isBundleRegistered(name: string): boolean {
  return registeredNames.has(name);
}

/** Run every registered bundle's store warm-up (if it has one), in parallel. */
export async function hydrateAllBundles(): Promise<void> {
  await Promise.all(bundles.map((b) => b.hydrate?.() ?? Promise.resolve()));
}
