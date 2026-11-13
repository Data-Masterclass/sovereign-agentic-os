/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agentic builder's BUILD TOOL — the compile adapter the loop iterates against
 * USER STORY: As a coding agent building an OS app I want the compiler's real diagnostics back in
 *             the same turn, so I fix the actual errors instead of guessing — which is the one
 *             feedback loop the single-shot builder never had.
 * ARCHITECTURE:
 *   - A THIN adapter over the EXISTING in-process gate (`compile-gate.ts`: tsc via the compiler API
 *     plus an esbuild-wasm bundle pass over the merged tree). Nothing is re-implemented, so the
 *     loop is held to the same gate `commitToApp` enforces before any write — a tree that passes
 *     here passes the commit door.
 *   - MERGE SEMANTICS match the commit door's: a coder turn is a CHANGESET over the app's prior
 *     tree, so the gate always sees the WHOLE repo (`mergeBuilderTree`).
 *   - HONESTY: an ungated shape returns `gated: false` with the gate's own reason. The loop treats
 *     that as `unknown`, never as a pass.
 */
import 'server-only';
import { compileGate, formatGateError } from '@tabs/software/lib/compile-gate';
import type { CompileOutcome } from '@tabs/software/lib/builder/acceptance';
import type { SourceFile } from '@tabs/software/lib/builder/grounding';

/** The build tool's result: the gate verdict plus the corrective text fed back to the coder. */
export type BuilderBuildResult = CompileOutcome & { text: string };

/**
 * Merge a coder changeset over the app's prior tree — last write per path wins, prior order kept
 * for the untouched files. Same rule as `server.ts` `mergeTree`, kept local so the builder does
 * not reach into the commit door's internals.
 */
export function mergeBuilderTree(prior: SourceFile[], incoming: SourceFile[]): SourceFile[] {
  const byPath = new Map(prior.map((f) => [f.path, f]));
  for (const f of incoming) byPath.set(f.path, f);
  return [...byPath.values()];
}

/**
 * Run the compile gate over the merged tree and shape it for the loop. Returns the exact
 * diagnostics (as the gate's own corrective text) so the next coder turn is seeded with compiler
 * output, not a paraphrase.
 */
export async function buildBuilderTree(prior: SourceFile[], incoming: SourceFile[]): Promise<BuilderBuildResult> {
  const tree = mergeBuilderTree(prior, incoming);
  const gate = await compileGate(tree);
  if (!gate.gated) {
    return { gated: false, ok: false, errors: [], note: gate.reason, text: `compile check skipped - ${gate.reason}` };
  }
  if (gate.ok) {
    const note = gate.bundleSkipped;
    return {
      gated: true,
      ok: true,
      errors: [],
      ...(note ? { note } : {}),
      text: note ? `compile check passed (${note})` : 'compile check passed',
    };
  }
  const errors = gate.diagnostics.map(
    (d) => `${d.file}:${d.line}:${d.column} ${d.code > 0 ? `TS${d.code}` : 'bundle'}: ${d.message.split('\n')[0]}`,
  );
  return { gated: true, ok: false, errors, text: formatGateError(gate) };
}
