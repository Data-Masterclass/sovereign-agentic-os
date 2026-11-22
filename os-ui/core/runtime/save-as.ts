/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    "Save as" — an answer becomes a KPI, dashboard, knowledge note or agent, behind a confirm card
 * USER STORY: As a user I want to keep a good answer as a real artifact, with one click, and still be
 *             asked before anything is created.
 * ARCHITECTURE:
 *   - A FIXED table from kind to the one existing create tool (the same tool the UI and MCP use). The
 *     browser names a kind, never a tool.
 *   - The turn is the normal Home chat turn restricted to that single tool (`onlyTools`), behind the
 *     same user-confirm gate: the model fills in the arguments, the user sees them on the card and
 *     confirms. Knowledge and workflows are separate tools: a knowledge note is `save_knowledge_note`.
 *   - A kind whose tool the user is not offered (role) or this build does not have is unavailable —
 *     never replaced by a different tool.
 */

export type SaveAsKind = 'kpi' | 'dashboard' | 'knowledge' | 'agent';

export const SAVE_AS: Readonly<Record<SaveAsKind, { tool: string; label: string; what: string }>> = {
  kpi: { tool: 'define_metric', label: 'KPI', what: 'a KPI (a governed metric definition)' },
  dashboard: { tool: 'create_dashboard', label: 'Dashboard', what: 'a dashboard' },
  knowledge: { tool: 'save_knowledge_note', label: 'Knowledge note', what: 'a knowledge note in My knowledge' },
  agent: { tool: 'create_agent_system', label: 'Agent', what: 'an agent system' },
};

export function isSaveAsKind(v: unknown): v is SaveAsKind {
  return typeof v === 'string' && Object.hasOwn(SAVE_AS, v);
}

export type SaveAsPlan = { ok: true; kind: SaveAsKind; tool: string; instruction: string } | { ok: false; reason: string };

/** The instruction for the save-as turn, or why this kind is not available to this user. */
export function saveAsPlan(kind: SaveAsKind, offeredTools: readonly string[]): SaveAsPlan {
  if (!isSaveAsKind(kind)) return { ok: false, reason: 'Unknown kind.' };
  const { tool, what, label } = SAVE_AS[kind];
  if (!offeredTools.includes(tool)) {
    return { ok: false, reason: `${label} is not available to you here (the tool is not offered for your role, or not installed).` };
  }
  return {
    ok: true,
    kind,
    tool,
    instruction:
      `Save your previous answer as ${what}. Call the tool \`${tool}\` now, once, with sensible arguments ` +
      'taken from the conversation (a clear name; only facts that are in the conversation). ' +
      'Do not call any other tool. The user will review the arguments and confirm before anything is created.',
  };
}
