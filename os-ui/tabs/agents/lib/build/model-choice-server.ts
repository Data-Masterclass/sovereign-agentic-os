/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Build step that decides `model: auto` (one strong-model call) and stores the decision
 * USER STORY: As a builder, every Build (the Agents tab button and the MCP `build_agent_system`) decides my Auto
 *             agents' models afresh and shows the choice and reason in the Build report.
 * ARCHITECTURE:
 *   - Runs BEFORE the Build's adapters, on the STORED definition: `decideAutoModels` (`model-choice.ts`) with the
 *     live gateway caller (strong role, the shared agent key — the system's own key may not allow strong, and may not
 *     exist yet), then `setAutoModelDecisions` (`store.ts`) writes the result into system.yaml. The Build then
 *     compiles and keys the definition WITH the decisions, so the key allows exactly the roles the agents use.
 *   - The Build report gets one `models` row: each Auto agent's choice and reason, and a warning for any agent that
 *     fell back to Strong.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { liteLlmCaller } from '@core/runtime/runtime';
import { roleModel } from '@core/models/roles';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { setAutoModelDecisions } from '@tabs/agents/lib/store';
import { agentsToDecide, autoAgents, decideAutoModels } from '@tabs/agents/lib/build/model-choice';
import { modelChoiceLabel } from '@tabs/agents/lib/agent-model';
import type { BuildRow } from '@tabs/agents/lib/build/adapter';

/**
 * Decide and store the Auto agents' models for a Build. Returns the stored yaml to build (unchanged when no agent is
 * on Auto) and the Build-report row (null when no agent is on Auto).
 */
export async function resolveAutoModelsForBuild(
  input: { systemId: string; user: CurrentUser; yaml: string },
  deps: { llm?: LlmCall } = {},
): Promise<{ yaml: string; row: BuildRow | null }> {
  const sys = parseSystem(input.yaml);
  const auto = autoAgents(sys);
  if (auto.length === 0) return { yaml: input.yaml, row: null };
  const kept = (ids: Set<string>) => auto.filter((a) => !ids.has(a.id) && a.model_resolved).map((a) => `${a.id} → ${modelChoiceLabel(a.model_resolved!)} (unchanged)`);
  if (agentsToDecide(sys).length === 0) {
    // Nothing an Auto decision rests on changed since it was made: no call, the decisions stand.
    return { yaml: input.yaml, row: { tool: 'models', applied: true, verified: true, status: 'ok', detail: `Auto model choice: ${kept(new Set()).join('; ')}`, change: 'unchanged' } };
  }
  const llm = deps.llm ?? liteLlmCaller({ userId: input.user.id, domain: sys.system.domain, tab: 'agents' });
  const { decisions, warnings } = await decideAutoModels(sys, { llm, strongModel: roleModel('reasoning') });
  const yaml = setAutoModelDecisions(input.systemId, input.user, decisions);
  const chosen = [...decisions.map((d) => `${d.id} → ${modelChoiceLabel(d.tier)} (${d.reason})`), ...kept(new Set(decisions.map((d) => d.id)))].join('; ');
  return {
    yaml,
    row: {
      tool: 'models',
      applied: true,
      verified: true,
      // A fallback to Strong is not a failure of the Build, but it must stand out.
      status: decisions.some((d) => d.fallback) ? 'warn' : 'ok',
      detail: `Auto model choice: ${chosen}${warnings.length ? ` — Warning: ${warnings.join(' ')}` : ''}`,
      change: 'updated',
    },
  };
}
