/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model reference sweep — "what breaks if this model is removed?".
 *
 * Before an admin removes a model from the catalog, the OS lists every place the
 * alias is in use so removal is a two-step informed confirmation, never a silent
 * break. Covered:
 *   • ROLE mapping — the three roles (strong/worker/embedding) mapped to the model
 *     in `os/models.yml` (Platform → Models).
 *   • ASSISTANT pin — an explicit assistant override (the follow-Standard case is
 *     already covered by the Standard role entry).
 *   • AGENTS — none of their own: an agent's `model` is a role (strong · standard · auto), never a catalog
 *     model, so it is covered by the role entry.
 *   • ROUTER fallbacks — this deployment's router_settings define NO static
 *     fallback chains (values.yaml: "No static fallbacks"; a fallback would be a
 *     second admin-registered backend, which is itself a catalog model). There is
 *     nothing to sweep; documented here so the gap is a decision, not an oversight.
 *
 * Pure over in-process state; unit-testable.
 */

import { lastRoleReport } from '@core/models/role-reconcile';
import { ROLE_NAMES } from '@core/models/role-mapping';
import { getAssistantModelId, isAssistantExplicit } from '@tabs/admin/lib/models';

export type ModelReference = { kind: 'role' | 'assistant' | 'agent'; label: string };

const ROLE_LABELS: Record<(typeof ROLE_NAMES)[number], string> = {
  'sovereign-strong': 'Strong',
  'sovereign-worker': 'Worker',
  'sovereign-embedding': 'Embedding',
};

/** Every live usage of a LiteLLM alias across role pins, the assistant, and agents. */
export function modelReferences(alias: string): ModelReference[] {
  const out: ModelReference[] = [];
  if (!alias) return out;

  // The three roles: which catalog model each one is mapped to (`os/models.yml`, as last reconciled).
  const mapping = lastRoleReport()?.mapping;
  if (mapping) {
    for (const role of ROLE_NAMES) {
      if (mapping[role] === alias) out.push({ kind: 'role', label: `${ROLE_LABELS[role]} role (Platform → Models)` });
    }
  }

  if (isAssistantExplicit() && getAssistantModelId() === alias) {
    out.push({ kind: 'assistant', label: 'Assistant model pin' });
  }

  // Agents name no catalog model: each runs on a ROLE (`model: strong | standard | auto`, `agent-model.ts`; an older
  // stored pin is read as the role it stands for), so an agent's use of a catalog model is the role entry above.

  return out;
}
