/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The PURE "refine my app conversationally" build-chat assistant (0.6.134).
 *
 * The sibling `generate.ts` builds an app UP from epics/stories the FIRST time. This module is the
 * EDIT counterpart: the user, looking at their spec, says "make the Orders tab a kanban by status"
 * or "add a KPI tab for total revenue", and the assistant returns the FULL updated AppSpec — applied
 * DIRECTLY (agentic), not proposed. It is the DOM-free, store-free heart of the /spec/assist route:
 *
 *   • `buildAssistPrompt(material, currentSpec, instruction)` — folds the SAME granted context
 *     `generate.ts` uses (datasets + REAL columns, metrics, agents, epics/stories) PLUS the current
 *     spec and the user's instruction into a constrained system+user prompt. It reuses the closed
 *     cookbook grammar from generate.ts so the model can only ever emit a valid, granted-wired spec.
 *   • `parseAssistedSpec(rawText)` — recovers the JSON from a (prose-wrapped) reasoning reply and runs
 *     the STRUCTURAL gate `parseAppSpec`. The SEMANTIC gate (ungranted id / fabricated column) is
 *     `validateAppSpec`, run by the route against the real stores — this module never touches a store.
 *   • `assistRepairInstruction(issues)` — the one-turn repair seed (re-exported from generate.ts's
 *     `repairInstruction` for a single source of truth).
 *
 * DESIGN LAW (see DESIGN.md): SAFE + LOW-VARIANCE. The model is ASKED to stay inside the closed
 * grammar and change ONLY what the instruction requires; whatever it returns is still gated by
 * parseAppSpec + validateAppSpec before it can load into the composer — so a hallucinated id/column
 * can never reach the renderer, and an un-satisfiable instruction is surfaced honestly, not applied.
 */

import { parseAppSpec, type AppSpec, type SpecIssue } from './schema.ts';
import {
  buildGeneratePrompt,
  parseGeneratedSpec,
  repairInstruction,
  type GenerateMaterial,
  type GenerateParse,
} from './generate.ts';

export type { GenerateMaterial, GenerateParse, GenerateDataset, GenerateGrant, GenerateEpic, GenerateStory } from './generate.ts';

/** The prompt the route sends to the model: a system frame + the app-specific user brief. */
export type AssistPrompt = { system: string; user: string };

/**
 * Build the constrained EDIT prompt. It REUSES `buildGeneratePrompt` for the closed-grammar system
 * frame + the granted-material brief (one source of truth for the rules the model must obey), then
 * appends the CURRENT spec and the user's INSTRUCTION with the edit contract: change ONLY what the
 * instruction requires, keep everything else byte-identical, and return the FULL updated AppSpec.
 */
export function buildAssistPrompt(m: GenerateMaterial, currentSpec: AppSpec, instruction: string): AssistPrompt {
  const base = buildGeneratePrompt(m);
  const system = [
    base.system,
    '',
    'YOU ARE NOW EDITING AN EXISTING SPEC — one more rule set applies:',
    'E1. You are given the CURRENT AppSpec and an INSTRUCTION. Apply ONLY the change the instruction',
    '    asks for. Keep every other tab, field and value EXACTLY as it is (do not re-order, re-label',
    '    or drop tabs the instruction does not mention).',
    'E2. Return the FULL updated AppSpec (one JSON object, no prose) — not a diff, not a fragment.',
    'E3. If the instruction cannot be satisfied within these rules (it needs ungranted data, an',
    '    unknown pattern, or a column that does not exist), DO NOT guess and DO NOT change anything:',
    '    return the CURRENT spec UNCHANGED. The route explains the refusal to the user separately.',
  ].join('\n');

  const user = [
    base.user,
    '',
    'CURRENT APP SPEC (edit this — return the full updated object):',
    JSON.stringify(currentSpec),
    '',
    `INSTRUCTION: ${instruction.trim()}`,
    '',
    'Return the full updated JSON AppSpec now.',
  ].join('\n');

  return { system, user };
}

/**
 * Recover the JSON from a (possibly prose-wrapped) model reply and run the STRUCTURAL gate.
 * Delegates to `generate.ts`'s `parseGeneratedSpec` — the recovery + parseAppSpec logic is identical
 * for a generated and an edited spec, so there is one tested path. Never throws.
 */
export function parseAssistedSpec(raw: string): GenerateParse {
  return parseGeneratedSpec(raw);
}

/** The one-turn repair seed — re-exported from generate.ts so both routes share the exact wording. */
export function assistRepairInstruction(issues: SpecIssue[]): string {
  return repairInstruction(issues);
}

/** Re-export the structural parser so a caller can gate a hand-authored spec without a second import. */
export { parseAppSpec };
