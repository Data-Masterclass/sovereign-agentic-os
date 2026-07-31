/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { completeWithEscalation } from '@/lib/assistant/escalate';
import { listPillars } from '@/lib/strategy/pillars';
import { resolveManual, type ManualScope } from '@/lib/knowledge/manual';
import { getDomainKnowledge, listWorkflows, getWorkflow } from '@/lib/knowledge/store';
import { listDatasets, getDataset } from '@/lib/data/store';
import { metricSqlReady } from '@/lib/data/metrics';
import {
  suggestMetricsMessages,
  parseCandidates,
  groundingOf,
  type SuggestContext,
  type SuggestDataset,
  type SuggestOmSection,
  type SuggestPillar,
  type SuggestWorkflow,
  type SuggestResult,
} from './suggest.ts';

export type { SuggestResult } from './suggest.ts';

/**
 * Server-side context assembly + run for "suggest metrics" — the ONE place the route
 * and the MCP tool share, so both assemble the SAME already-governed context and run
 * the SAME validated model call under the caller (MCP parity by construction).
 *
 * Everything is read UNDER the caller's identity through the existing governed libs:
 * `listPillars(user)` (canView-filtered), the three Operating-Model scopes via
 * `resolveManual` (only where `canView`), `listWorkflows(user)` + `getWorkflow` for
 * the visible processes' steps + HARD rules, and `listDatasets(user)` + `getDataset`
 * for the datasets the caller can see with their real columns/measures. Nothing is
 * fabricated: {@link parseCandidates} then drops any candidate whose dataset isn't in
 * this visible set or whose columns aren't real.
 */

const OM_SCOPES: ManualScope[] = ['company', 'domain', 'my'];

/** Gather the viewable Operating-Model sections across the three scopes. A section id
 *  seen at a MORE SPECIFIC scope (my > domain > company) wins, so the caller's own OM
 *  refines the shared one; empty-content sections are skipped (nothing to ground). */
function gatherOmSections(user: CurrentUser): SuggestOmSection[] {
  const byId = new Map<string, SuggestOmSection>();
  // company first, then domain, then my → later (more specific) overwrites earlier.
  for (const scope of OM_SCOPES) {
    const res = resolveManual(scope, user);
    if (!res.canView) continue;
    const dk = getDomainKnowledge(res.key);
    for (const s of dk.sections) {
      const content = (s.content ?? '').trim();
      if (!content) continue;
      byId.set(s.id, { id: s.id, title: s.title, content });
    }
  }
  return [...byId.values()];
}

/** The visible workflows (business processes) with their steps, HARD rules + actors. */
function gatherWorkflows(user: CurrentUser): SuggestWorkflow[] {
  const groups = listWorkflows(user);
  const summaries = [...groups.mine, ...groups.domain, ...groups.marketplace];
  const out: SuggestWorkflow[] = [];
  for (const sum of summaries) {
    try {
      const { workflow } = getWorkflow(sum.id, user);
      out.push({
        id: workflow.id,
        title: workflow.title,
        steps: workflow.steps.map((st) => ({ title: st.title, actor: st.actor })),
        hardRules: workflow.rules.filter((r) => r.hard).map((r) => r.text),
        actors: workflow.actors.map((a) => a.name),
      });
    } catch {
      /* a workflow that vanished / became unreadable between list and get → skip */
    }
  }
  return out;
}

/** The visible datasets with the columns + measures a metric may reference. */
function gatherDatasets(user: CurrentUser): SuggestDataset[] {
  const groups = listDatasets(user);
  const summaries = [...groups.mine, ...groups.domain, ...groups.marketplace];
  const out: SuggestDataset[] = [];
  for (const sum of summaries) {
    try {
      const d = getDataset(sum.id, user);
      out.push({
        id: d.id,
        name: d.name,
        tier: d.tier,
        description: (d.description ?? '').trim(),
        columns: d.columns.map((c) => ({ name: c.name, description: c.description })),
        measures: d.measures.map((m) => ({ name: m.name, type: m.type })),
        deliverable: metricSqlReady(d).ok,
      });
    } catch {
      /* dataset unreadable between list + get → skip (fail-closed) */
    }
  }
  return out;
}

/** Assemble the FULL governed suggest-context under the caller. */
export async function assembleSuggestContext(user: CurrentUser, goal?: string): Promise<SuggestContext> {
  const pillars = await listPillars(user);
  const suggestPillars: SuggestPillar[] = pillars.map((p) => ({ id: p.id, name: p.name, description: p.description }));
  return {
    goal: goal?.trim() || undefined,
    pillars: suggestPillars,
    omSections: gatherOmSections(user),
    workflows: gatherWorkflows(user),
    datasets: gatherDatasets(user),
  };
}

/**
 * Assemble context, run the model through the ONE governed assistant STANDARD-FIRST
 * (Cost routing), and validate the JSON into real candidates. Throws the assistant's
 * honest 503/402 (no model / cost cap) and the {@link SuggestError} 502 (unusable
 * output) — no fake AI.
 *
 * Cost routing: the output is strictly validated ({@link parseCandidates} drops any
 * candidate whose dataset isn't visible or whose columns aren't real), so we run
 * standard first and escalate to reasoning ONLY when the cheap answer yields no usable
 * candidate — the validator is the quality gate. A first-pass standard answer that
 * parses into ≥1 real candidate is as usable as a reasoning one. Admin toggle OFF pins
 * it to reasoning directly (see `completeWithEscalation`).
 */
export async function runSuggest(user: CurrentUser, goal?: string): Promise<SuggestResult> {
  const ctx = await assembleSuggestContext(user, goal);
  // No datasets visible → nothing a metric could ground on. Answer honestly (empty +
  // grounding) WITHOUT spending a model call.
  if (ctx.datasets.length === 0) return { candidates: [], grounding: groundingOf(ctx) };

  const { content } = await completeWithEscalation(suggestMetricsMessages(ctx), {
    user: { id: user.id, domains: user.domains },
    // Usable iff the reply parses into at least one REAL candidate (visible dataset +
    // real columns). Unparseable JSON or an all-dropped/empty set → escalate once.
    validate: (raw) => {
      try {
        return parseCandidates(raw, ctx).candidates.length > 0;
      } catch {
        return false; // SuggestError (unparseable) → not usable → escalate
      }
    },
  });
  // Re-run the SAME validated parse on the answer that actually stood (standard or the
  // escalated reasoning reply) to produce the final result / honest 502.
  return parseCandidates(content, ctx);
}
