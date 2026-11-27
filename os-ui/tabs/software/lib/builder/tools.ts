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
 *   - App Builder B (spec section 5): `storyWriteGate` is the in-OS write rule for a v2 app's code: a change for a story
 *     is refused while the story is `draft` or has a pending diff card, and source files for it are refused until its
 *     criteria have tagged tests in the tree (test first). Pure; the MCP push handler and build directive call it.
 */
import 'server-only';
import { compileGate, formatGateError } from '@tabs/software/lib/compile-gate';
import type { CompileOutcome } from '@tabs/software/lib/builder/acceptance';
import type { SourceFile } from '@tabs/software/lib/builder/grounding';
import type { LivingSpec, SpecProposal, StoryId } from '@tabs/software/lib/app-builder-contracts';
import { isTestPath, untaggedCriteria } from '@tabs/software/lib/builder/criteria-tests';

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

/** Why a code write for `storyIds` is refused, or null when it may proceed (App Builder B, spec section 5). */
export function storyWriteGate(
  spec: Pick<LivingSpec, 'stories'>,
  proposals: SpecProposal[] | undefined,
  storyIds: string[],
  opts: { incoming?: SourceFile[]; tree?: SourceFile[] } = {},
): string | null {
  if (storyIds.length === 0) return 'name the story this change is for (story: "US-n"); code changes only for an agreed story';
  const pending = (proposals ?? []).filter((p) => p.status === 'pending' && !p.posthoc);
  for (const id of storyIds) {
    const story = spec.stories.find((s) => s.id === id);
    if (!story) return `there is no story ${String(id).slice(0, 20)} in this app`;
    if (story.state !== 'agreed') return `${id} is still a draft: agree the story (approve its diff card or set it to agreed in the Stories view) before its code changes`;
    const card = pending.find((p) => p.targetId === id || p.change.writes.some((w) => w.path === story.path));
    if (card) return `${id} has a pending diff card (${card.id}); approve or reject it before its code changes`;
  }
  const incoming = opts.incoming ?? [];
  const writesSource = incoming.some((f) => !isTestPath(f.path));
  if (writesSource) {
    const merged = mergeBuilderTree(opts.tree ?? [], incoming);
    for (const id of storyIds as StoryId[]) {
      const story = spec.stories.find((s) => s.id === id)!;
      const missing = untaggedCriteria(story, merged);
      if (missing.length > 0) return `test first: ${missing.slice(0, 5).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no tagged test yet; commit the tests (tests/criteria/${id}.test.ts, from build_software) before the code`;
    }
  }
  return null;
}
