/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model reference sweep — "what breaks if this model is removed?".
 *
 * Before an admin removes a model from the catalog, the OS lists every place the
 * alias is in use so removal is a two-step informed confirmation, never a silent
 * break. Covered:
 *   • ROLE pins/defaults — the four runtime roles (standard/reasoning/tools/
 *     embeddings) resolved by lib/models/roles.ts (explicit admin pin OR the
 *     deployment default resolving to the alias — both break on removal).
 *   • ASSISTANT pin — an explicit assistant override (the follow-Standard case is
 *     already covered by the Standard role entry).
 *   • AGENT per-node pins — `agents[].model` in each agent system's system.yaml.
 *   • ROUTER fallbacks — this deployment's router_settings define NO static
 *     fallback chains (values.yaml: "No static fallbacks"; a fallback would be a
 *     second admin-registered backend, which is itself a catalog model). There is
 *     nothing to sweep; documented here so the gap is a decision, not an oversight.
 *
 * AGENT STORE ACCESS: lib/agents is owned by a parallel wave, so this module must
 * not add exports there. The store pins its state to the SAME
 * `Symbol.for('soa.agents.store')` global every route bundle shares (see
 * lib/agents/store.ts); we read that map READ-ONLY and parse each system.yaml with
 * the store's own parser. Follow-up: replace with an exported
 * `systemsUsingModel()` from lib/agents once that wave lands.
 *
 * Pure over in-process state; unit-testable. Callers that need the agent sweep to
 * see mirrored systems should `ensureHydrated()` the agent store first.
 */

import { getSettings } from './settings.ts';
import { roleModel, type ModelRole } from '../models/roles.ts';
import { getAssistantModelId, isAssistantExplicit } from './models.ts';
import { parseSystem } from '../agents/system-schema.ts';

export type ModelReference = { kind: 'role' | 'assistant' | 'agent'; label: string };

const ROLE_LABELS: Record<ModelRole, string> = {
  standard: 'Standard',
  reasoning: 'Reasoning',
  tools: 'Tools',
  embeddings: 'Embeddings',
};
const ROLES: ModelRole[] = ['standard', 'reasoning', 'tools', 'embeddings'];

type AgentRecordLike = { id?: string; name?: string; yaml?: string; archived?: boolean };

/** Read-only view of the agent-system store (shared globalThis pin; see header). */
function agentRecords(): AgentRecordLike[] {
  const g = globalThis as unknown as Record<symbol, { store?: Map<string, AgentRecordLike> } | undefined>;
  const s = g[Symbol.for('soa.agents.store')];
  return s?.store instanceof Map ? [...s.store.values()] : [];
}

/** Every live usage of a LiteLLM alias across role pins, the assistant, and agents. */
export function modelReferences(alias: string): ModelReference[] {
  const out: ModelReference[] = [];
  if (!alias) return out;

  const pinned = getSettings().modelRoles;
  for (const role of ROLES) {
    if (roleModel(role) === alias) {
      const explicit = (pinned[role] ?? '').trim() === alias;
      out.push({ kind: 'role', label: `${ROLE_LABELS[role]} role ${explicit ? 'pin' : 'default'}` });
    }
  }

  if (isAssistantExplicit() && getAssistantModelId() === alias) {
    out.push({ kind: 'assistant', label: 'Assistant model pin' });
  }

  for (const rec of agentRecords()) {
    if (rec.archived) continue;
    const yaml = rec.yaml ?? '';
    if (!yaml.includes(alias)) continue; // cheap pre-filter before a full parse
    try {
      const sys = parseSystem(yaml);
      const nodes = sys.agents.filter((a) => a.model === alias).map((a) => a.id);
      if (nodes.length > 0) {
        out.push({ kind: 'agent', label: `Agent system “${rec.name ?? rec.id}” (${nodes.join(', ')})` });
      }
    } catch {
      // unparseable system.yaml — skip, never fabricate a match
    }
  }

  return out;
}
