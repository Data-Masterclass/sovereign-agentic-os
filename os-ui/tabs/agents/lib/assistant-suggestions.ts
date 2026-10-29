/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The AGENT-SYSTEM STAGE-ASSISTANT SUGGESTION model — the pure, client-safe shapes and
 * the defensive `normalizeAssistantReply` the per-stage Agents assistant returns when a
 * user chats with the governed assistant route
 * (`app/api/agents/systems/[id]/assistant/route.ts`, chat mode).
 *
 * This mirrors `lib/software/assistant-suggestions.ts`: the assistant only SUGGESTS —
 * it never mutates a system. Applying a suggestion is a LOCAL, user-confirmed transform
 * the client commits through the SAME governed path (the system.yaml write / the
 * grants + governance flow). Keeping the normaliser here (pure, no React / no server
 * imports) means the UI and the unit tests share one source of truth, and a malformed
 * model field degrades to "no suggestion of that kind" rather than throwing.
 *
 * Per-stage suggestion surface (the Agents 5-phase builder Define·Design·Build·Run·Evaluate):
 *   • Define   → `improvedDescription`, `suggestedOutputs[]` (kind/name/folder)
 *   • Grant    → `suggestedGrants[]` ({kind, id, access})
 *   • Design   → `proposedTeam` (ProposedAgent[]), `suggestedInstructions[]` (per agent)
 *   • Build/Run→ prose only (no suggestions)
 *   • Evaluate → `suggestedInstructions[]` (per agent)
 */

import type { ProposedAgent } from '@tabs/agents/lib/assistant';
import type { OutputKind } from '@tabs/agents/lib/system-schema';

/**
 * The context kinds a Grant-stage suggestion may reference — the SAME grantable kinds the
 * agent-system grants picker offers (`grants/available` route). Kept as a literal here so
 * this module has no server import; the route validates ids against the caller's real
 * DLS-scoped grantable set, so a hallucinated id never survives.
 */
export type AgentGrantKind =
  | 'data' | 'knowledge' | 'files' | 'connections' | 'metric'
  | 'operating-manual';
export const AGENT_GRANT_KINDS: AgentGrantKind[] = [
  'data', 'knowledge', 'files', 'connections', 'metric',
  'operating-manual',
];


/** The three plain access levels a Grant suggestion may propose (clamped on apply). */
export type SuggestedGrantAccess = 'read-only' | 'read-propose' | 'read-write';

/** A single context grant the assistant proposes: which kind + id, at what access. */
export type SuggestedAgentGrant = {
  kind: AgentGrantKind;
  id: string;
  /** The access the assistant proposes; the host clamps it to the cap on apply. */
  access?: SuggestedGrantAccess;
  /** A short, human reason shown on the card. */
  reason?: string;
};

/** A declared OUTPUT the assistant proposes (mirrors {@link import('./system-schema.ts').DeclaredOutput}). */
export type SuggestedOutput = {
  kind: OutputKind;
  name: string;
  folder: { path: string; scope: 'personal' | 'domain' };
};

/** An instruction (AGENT.md body) the assistant drafts for a focused/named agent. */
export type SuggestedInstruction = {
  /** The exact agent id this instruction is for. */
  agentId: string;
  /** The drafted instruction / role guidance (markdown). */
  instruction: string;
};

/** The structured suggestions an Agents stage reply may carry (all optional). */
export type AgentStageSuggestions = {
  /** Define: a sharpened system-description sentence the user can accept. */
  improvedDescription?: string;
  /** Define: declared outputs (where the team's results are stored) to add. */
  suggestedOutputs?: SuggestedOutput[];
  /** Grant: context grants the assistant proposes (from the DLS-scoped grantable set). */
  suggestedGrants?: SuggestedAgentGrant[];
  /** Design: a whole proposed team (the ProposedAgent[] the scaffolder validates). */
  proposedTeam?: ProposedAgent[];
  /** Design / Evaluate: per-agent instruction drafts. */
  suggestedInstructions?: SuggestedInstruction[];
};

/** An Agents stage-assistant reply: markdown prose plus optional structured suggestions. */
export type AgentStageAssistantReply = {
  message: string;
  suggestions: AgentStageSuggestions;
};

const OUTPUT_KINDS: OutputKind[] = ['files', 'data', 'knowledge'];
const ACCESS_VALUES: SuggestedGrantAccess[] = ['read-only', 'read-propose', 'read-write'];

/** kebab-case slug (mirrors assistant.ts) so a proposed-team id is compile-safe on apply. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

/**
 * Defensively normalise a raw parsed model reply (arbitrary JSON) into an
 * {@link AgentStageAssistantReply}. Everything is optional and shape-guarded so a
 * malformed field degrades to "no suggestion of that kind" rather than throwing.
 *
 * @param raw   the parsed model JSON (from the tolerant `parseJsonReply`)
 * @param kinds the grantable kinds the caller may reference (defaults to all); a grant
 *              whose kind is outside this set is dropped. The ROUTE additionally filters
 *              proposed ids against the caller's real grantable feed, so this is only the
 *              shape gate — never the authority gate.
 */
export function normalizeAgentAssistantReply(
  raw: unknown,
  kinds: readonly AgentGrantKind[] = AGENT_GRANT_KINDS,
): AgentStageAssistantReply {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const message = str(rec.message).trim();

  const suggestions: AgentStageSuggestions = {};

  const improved = str(rec.improvedDescription).trim();
  if (improved) suggestions.improvedDescription = improved;

  // --- Define: declared outputs -------------------------------------------
  if (Array.isArray(rec.suggestedOutputs)) {
    const outputs = rec.suggestedOutputs
      .map((o): SuggestedOutput | null => {
        if (!o || typeof o !== 'object') return null;
        const r = o as Record<string, unknown>;
        const kind = r.kind as OutputKind;
        const name = str(r.name).trim();
        if (!OUTPUT_KINDS.includes(kind) || !name) return null;
        const f = (r.folder && typeof r.folder === 'object' ? r.folder : {}) as Record<string, unknown>;
        const path = str(f.path).trim() || '/';
        const scope = f.scope === 'domain' ? 'domain' : 'personal';
        return { kind, name, folder: { path, scope } };
      })
      .filter((o): o is SuggestedOutput => o !== null);
    if (outputs.length) suggestions.suggestedOutputs = outputs;
  }

  // --- Grant: context grants ----------------------------------------------
  if (Array.isArray(rec.suggestedGrants)) {
    const kindSet = new Set(kinds);
    const grants = rec.suggestedGrants
      .map((g): SuggestedAgentGrant | null => {
        if (!g || typeof g !== 'object') return null;
        const o = g as Record<string, unknown>;
        const kind = o.kind as AgentGrantKind;
        const id = str(o.id).trim();
        if (!kindSet.has(kind) || !id) return null;
        const access = ACCESS_VALUES.includes(str(o.access) as SuggestedGrantAccess)
          ? (str(o.access) as SuggestedGrantAccess)
          : undefined;
        return { kind, id, access, reason: str(o.reason).trim() || undefined };
      })
      .filter((g): g is SuggestedAgentGrant => g !== null);
    if (grants.length) suggestions.suggestedGrants = grants;
  }

  // --- Design: a proposed team --------------------------------------------
  if (Array.isArray(rec.proposedTeam)) {
    const taken = new Set<string>();
    const team = rec.proposedTeam
      .map((a): ProposedAgent | null => {
        if (!a || typeof a !== 'object') return null;
        const o = a as Record<string, unknown>;
        const role = str(o.role).trim();
        const instruction = str(o.instruction).trim();
        // A step with neither a role nor an instruction carries no meaning — drop it.
        if (!role && !instruction) return null;
        const base = slugify(str(o.id) || role || instruction).slice(0, 40) || 'agent';
        let id = base;
        let i = 2;
        while (taken.has(id)) id = `${base}-${i++}`;
        taken.add(id);
        return {
          id,
          role: role || 'Performs its step and hands off to the next agent',
          instruction: instruction || role,
        };
      })
      .filter((a): a is ProposedAgent => a !== null);
    if (team.length) suggestions.proposedTeam = team;
  }

  // --- Design / Evaluate: per-agent instruction drafts --------------------
  if (Array.isArray(rec.suggestedInstructions)) {
    const seen = new Set<string>();
    const instr = rec.suggestedInstructions
      .map((s): SuggestedInstruction | null => {
        if (!s || typeof s !== 'object') return null;
        const o = s as Record<string, unknown>;
        const agentId = str(o.agentId).trim();
        const instruction = str(o.instruction).trim();
        if (!agentId || !instruction || seen.has(agentId)) return null;
        seen.add(agentId);
        return { agentId, instruction };
      })
      .filter((s): s is SuggestedInstruction => s !== null);
    if (instr.length) suggestions.suggestedInstructions = instr;
  }

  return { message, suggestions };
}
