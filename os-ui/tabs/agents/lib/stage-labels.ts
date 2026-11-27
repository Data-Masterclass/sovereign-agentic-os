/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The agent builder's stage rail (titles, "not done yet" reasons, problems) in the user's language
 * USER STORY: As a German-speaking creator I see the six builder steps and why a step is not ticked yet in German,
 *             while the rail's gating and ✓ rules stay exactly the ones `stages.ts` defines.
 * ARCHITECTURE: Pure. `AGENT_STAGES` (stages.ts) stays the English source of truth — its words are also what the
 *   tests pin. `localizeAgentStages` wraps each stage: the title and every fixed English reason become a key in
 *   the `agents` namespace (`stages.*`), rendered by the caller's translator; any text it does not know (the
 *   empty-grant warning, which `useEmptyGrants` already renders in the user's language) passes through unchanged.
 */
import type { StageDef } from '@core/kernel/stages';
import type { AgentStageCtx, AgentStageId } from '@tabs/agents/lib/stages';

/** The fixed English reasons `AGENT_STAGES` returns, by their key under `stages.status`. */
export const AGENT_STAGE_STATUS_KEYS: Record<string, string> = {
  'no name yet': 'noName',
  'no deliverable described yet': 'noDeliverable',
  'nothing granted yet': 'nothingGranted',
  'nothing granted matches any item': 'nothingMatches',
  'no agent with a start point yet': 'noStartAgent',
  'not built yet': 'notBuilt',
  'the last build failed': 'buildFailed',
  'not run yet': 'notRun',
  'the last run failed': 'runFailed',
  'the last run was interrupted': 'runInterrupted',
  'no run to evaluate yet': 'noRun',
  'the last run did not pass every check': 'checksFailed',
};

/** The catalog key (in `agents`) for a stage's English reason, or null when it is not a fixed one. */
export function stageStatusKey(english: string): string | null {
  const k = AGENT_STAGE_STATUS_KEYS[english];
  return k ? `stages.status.${k}` : null;
}

/** `AGENT_STAGES` with titles and reasons rendered through `tr` (a key in the `agents` namespace → text). */
export function localizeAgentStages(
  stages: StageDef<AgentStageId, AgentStageCtx>[],
  tr: (key: string) => string,
): StageDef<AgentStageId, AgentStageCtx>[] {
  const reason = (text: string): string => {
    const key = stageStatusKey(text);
    return key ? tr(key) : text;
  };
  return stages.map((s) => ({
    ...s,
    title: tr(`stages.titles.${s.id}`),
    ...(s.pending
      ? {
          pending: (c: AgentStageCtx) => {
            const v = s.pending!(c);
            return v ? reason(v) : v;
          },
        }
      : {}),
    ...(s.problem
      ? {
          problem: (c: AgentStageCtx) => {
            const p = s.problem!(c);
            return p ? { ...p, label: reason(p.label) } : null;
          },
        }
      : {}),
  }));
}
