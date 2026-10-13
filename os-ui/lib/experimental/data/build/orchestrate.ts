/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type BuildRow, type DataAdapter, type DataBuildContext, type DataStage, runAdapter } from './adapter.ts';
import { ADAPTER_SET } from './live.ts';

/**
 * Run a stage's ADAPTER-SET in order, folding each adapter's apply→verify into a
 * ✓/✗ row. Adapters not yet implemented (their tool absent from the map) are
 * SKIPPED — never reported as a passing row — so Build stays honest. The report is
 * ✓ only when at least one adapter ran AND every row passed.
 */
export type DataBuildReport = { ok: boolean; rows: BuildRow[]; skipped: string[] };

export async function orchestrateStage(
  stage: DataStage,
  ctx: DataBuildContext,
  adapters: Record<string, DataAdapter>,
): Promise<DataBuildReport> {
  const wanted = ADAPTER_SET[stage] ?? [];
  const sctx = { ...ctx, stage }; // so a shared adapter (dbt) picks the right model
  const rows: BuildRow[] = [];
  const skipped: string[] = [];
  for (const tool of wanted) {
    const adapter = adapters[tool];
    if (!adapter) { skipped.push(tool); continue; }
    rows.push(await runAdapter(adapter, sctx));
  }
  return { ok: rows.length > 0 && rows.every((r) => r.status === 'ok'), rows, skipped };
}
