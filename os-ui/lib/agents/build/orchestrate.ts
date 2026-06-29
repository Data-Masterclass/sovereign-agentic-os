/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { type BuildAdapter, type BuildRow, runAdapter } from './adapter.ts';

/**
 * Build orchestrator. Compiles `system.yaml`, then runs each tool adapter
 * apply→verify and collects the inline ✓/✗ rows. A compile failure (bad/over-broad
 * yaml) short-circuits into a single ✗ langgraph row carrying the exact compiler
 * error — the rest of the build never runs against an invalid graph. The report
 * is `ok` only when EVERY row passed both apply AND verify.
 */

export type BuildReport = { ok: boolean; rows: BuildRow[] };

export async function orchestrateBuild(input: {
  yaml: string;
  systemId?: string;
  adapters: BuildAdapter[];
  probe?: string;
}): Promise<BuildReport> {
  let system;
  let ir;
  try {
    system = parseSystem(input.yaml);
    ir = compile(system);
  } catch (e) {
    return {
      ok: false,
      rows: [
        {
          tool: 'langgraph',
          applied: false,
          verified: false,
          status: 'fail',
          detail: 'system.yaml did not compile',
          error: (e as Error).message,
        },
      ],
    };
  }

  const ctx = { system, ir, systemId: input.systemId, probe: input.probe };
  const rows: BuildRow[] = [];
  for (const adapter of input.adapters) {
    rows.push(await runAdapter(adapter, ctx));
  }
  return { ok: rows.every((r) => r.status === 'ok'), rows };
}
