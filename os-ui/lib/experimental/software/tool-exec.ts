/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ScaffoldFile } from './model.ts';
import { parseOpenApi } from './metadata.ts';

/**
 * App tool EXECUTION honesty (the /api/apps/[id]/tool route). Two paths:
 *
 *   • LIVE — the app's runner pod is actually running: the tool call is proxied
 *     to the app's real in-cluster Service per its committed OpenAPI
 *     (operationId → method + path), and the result is labelled `source:'live-app'`.
 *   • DEMO — no live runner: deterministic seed data so the "agent calls the
 *     app" flow stays demonstrable, but ALWAYS labelled `source:'demo-seed'`
 *     with a visible note (the old route returned hardcoded renewals fixtures
 *     for EVERY app, unlabelled, as if the app had answered).
 *
 * Pure helpers (no server imports) so the labelling + operation resolution are
 * unit-testable; the actual proxy fetch lives in the route.
 */

export type ToolOperation = { method: string; path: string };

/** operationId → REST operation, from the app's committed OpenAPI spec. */
export function resolveToolOperation(files: ScaffoldFile[], tool: string): ToolOperation | null {
  const spec = parseOpenApi(files);
  if (!spec) return null;
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if ((op as { operationId?: string })?.operationId?.trim() === tool) {
        return { method: method.toUpperCase(), path };
      }
    }
  }
  return null;
}

/** Substitute `{param}` path templates from the call args (extra args stay for query/body). */
export function fillPathParams(path: string, args: Record<string, unknown> = {}): string {
  return path.replace(/\{([^}]+)\}/g, (_, k: string) => encodeURIComponent(String(args[k] ?? '')));
}

export const DEMO_SEED_NOTE =
  'Demo data — the app runner is not live, so this result is an illustrative seed, ' +
  'not a response from the deployed app.';

// Neutral demo rows (match the generic `records` starter, not any real domain).
const SEED_ROWS = [
  { id: 'r1', name: 'Sample record A', category: 'demo', amount: 4800, due_on: '2026-09-30', status: 'active' },
  { id: 'r2', name: 'Sample record B', category: 'demo', amount: 1200, due_on: '2026-07-15', status: 'active' },
];

/**
 * HONESTLY-LABELLED demo result for a tool when the app runner is not live.
 * Generic over the tool-name convention (list_, get_, add_, export_ prefixes) so
 * it works for any app's tool surface — and every shape carries the label + note.
 */
export function seedToolResult(tool: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const label = { source: 'demo-seed' as const, note: DEMO_SEED_NOTE };
  if (tool.startsWith('list_')) return { ...label, items: SEED_ROWS };
  if (tool.startsWith('get_')) return { ...label, item: SEED_ROWS.find((r) => r.id === String(args.id)) ?? null };
  if (tool.startsWith('add_') || tool.startsWith('create_')) {
    return { ...label, added: { id: `r${Date.now().toString(36)}`, ...args } };
  }
  if (tool.startsWith('export_')) return { ...label, file: 'demo-export.csv', rows: SEED_ROWS.length };
  return { ...label, ok: true };
}
