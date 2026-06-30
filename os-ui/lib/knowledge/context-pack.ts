/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type KnowledgeUnit } from './chunk.ts';
import { type Scored } from './retrieve-core.ts';

/**
 * Pure context-pack builder — the heart of the context layer. Assembles the
 * smallest, highest-quality working set for the next decision, token-budgeted and
 * ordered (research-grounded):
 *
 *   PINNED (always, small, deterministic):
 *     • the domain card (general knowledge) — base context for every domain agent;
 *     • the active workflow's structured steps;
 *     • the workflow + relevant step HARD rules, VERBATIM.
 *   RETRIEVED (on demand, reranked top-k): tacit notes, soft-rule rationale, other
 *     workflows, prior cases — trimmed lowest-salience-first to fit the budget.
 *
 * Order: hard rules → domain card → workflow steps → retrieved evidence. Models
 * attend unevenly, so high-priority pinned content goes first. Never dumps the
 * knowledge base — pinned stays small; the rest is one retrieval away.
 */

export type PackItem = {
  source: 'pinned' | 'retrieved';
  kind: 'hard-rule' | 'domain' | 'workflow-step' | 'evidence';
  id: string;
  title: string;
  text: string;
  tokens: number;
  /** Provenance citation handle (id) so answers can cite their source. */
  cite: string;
};

export type ContextPack = {
  items: PackItem[];
  pinnedTokens: number;
  retrievedTokens: number;
  totalTokens: number;
  budget: number;
  /** Retrieved items dropped to honour the budget (lowest salience first). */
  dropped: PackItem[];
};

/** Rough token estimate (~4 chars/token) — deterministic, dependency-free. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export type BuildInputs = {
  /** The general-knowledge domain-card units (pinned, summarized upstream if long). */
  domainCard: KnowledgeUnit[];
  /** The active workflow's structured STEP units (pinned). */
  workflowSteps: KnowledgeUnit[];
  /** The active workflow's HARD-rule units (pinned, verbatim). */
  hardRules: KnowledgeUnit[];
  /** Reranked retrieved tail (already top-k, highest score first). */
  retrieved: Scored[];
  /** Total token budget for the pack. */
  budget?: number;
};

function toItem(u: KnowledgeUnit, source: PackItem['source'], kind: PackItem['kind']): PackItem {
  return {
    source,
    kind,
    id: u.id,
    title: u.title,
    text: u.text,
    tokens: estimateTokens(u.text),
    cite: u.id,
  };
}

/**
 * Assemble the pack. Pinned content is ALWAYS included (it is small + essential);
 * if pinned alone exceeds the budget we still keep it (correctness over budget)
 * but report the overage via totalTokens. Retrieved evidence is added in rank
 * order until the budget is hit; the rest is dropped (lowest salience first).
 */
export function buildContextPack(input: BuildInputs): ContextPack {
  const budget = input.budget ?? 2000;

  // Ordered pinned: hard rules first (highest priority), then domain, then steps.
  const pinned: PackItem[] = [
    ...input.hardRules.map((u) => toItem(u, 'pinned', 'hard-rule')),
    ...input.domainCard.map((u) => toItem(u, 'pinned', 'domain')),
    ...input.workflowSteps.map((u) => toItem(u, 'pinned', 'workflow-step')),
  ];
  const pinnedTokens = pinned.reduce((n, it) => n + it.tokens, 0);
  const pinnedIds = new Set(pinned.map((it) => it.id));

  // Retrieved evidence fills the remaining budget in rank order. Skip anything
  // already pinned (no point spending the budget twice on the same unit).
  const remaining = Math.max(0, budget - pinnedTokens);
  const kept: PackItem[] = [];
  const dropped: PackItem[] = [];
  let used = 0;
  for (const s of input.retrieved) {
    if (pinnedIds.has(s.unit.id)) continue;
    const it = toItem(s.unit, 'retrieved', 'evidence');
    if (used + it.tokens <= remaining) {
      kept.push(it);
      used += it.tokens;
    } else {
      dropped.push(it);
    }
  }

  const items = [...pinned, ...kept];
  return {
    items,
    pinnedTokens,
    retrievedTokens: used,
    totalTokens: pinnedTokens + used,
    budget,
    dropped,
  };
}

/** Render the pack to a single prompt string (ordered, with citation tags). */
export function renderContextPack(pack: ContextPack): string {
  const blocks = pack.items.map((it) => {
    const tag =
      it.kind === 'hard-rule' ? 'HARD RULE (enforced)' :
      it.kind === 'domain' ? 'DOMAIN' :
      it.kind === 'workflow-step' ? 'WORKFLOW STEP' : 'EVIDENCE';
    return `### ${tag} — ${it.title} [cite:${it.cite}]\n${it.text}`;
  });
  return blocks.join('\n\n');
}
