/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';

/**
 * The Home **domain assistant** — the "ask anything" front door
 * (home-golden-path.md §"Ask-anything"). Two-mode:
 *
 *   1. ANSWER — explain a path / point the viewer at the right tab.
 *   2. SCAFFOLD — turn "build/create a <type> …" into a real Personal DRAFT via
 *      the SAME governed create flow the owning tab uses (`createArtifact`),
 *      owned by the asker, in their domain (RLS). It then deep-links them into
 *      that tab to finish — it never finishes for them.
 *
 * Governance invariants (enforced, not advisory):
 *   • promote/certify stay HUMAN — a "promote/certify/publish" prompt is REFUSED
 *     and routed to the governed flow; the assistant never promotes.
 *   • a scaffold can only ever create a *Personal* draft owned by the asker; it
 *     cannot broaden visibility or skip the human gate (createArtifact enforces
 *     Personal + owner = caller regardless of prompt).
 *   • every turn is Langfuse-traced (lib/agent-governed `trace`) so the ask box
 *     is auditable in Monitoring like any other governed action.
 */

import type { CurrentUser } from '@/lib/core/auth';
import { createArtifact } from '@/lib/core/artifacts';
import { trace } from '@/lib/infra/agent-governed';
import { classifyAsk, type AskIntent } from './intents.ts';
import { TYPE_LABELS } from '@/lib/core/artifact-model';

export type AskResult = {
  mode: 'answer' | 'scaffold' | 'human-gate';
  text: string;
  /** Where to go to continue (the owning tab's governed flow). */
  deepLink?: string;
  /** When a draft was scaffolded, its id + name (Personal, owned by the asker). */
  draft?: { id: string; name: string; type: string };
  /** The Langfuse trace id for this turn (auditable in Monitoring). */
  traceId: string;
};

const ASK_PRINCIPAL = 'home-assistant';

export async function ask(user: CurrentUser, prompt: string): Promise<AskResult> {
  const intent: AskIntent = classifyAsk(prompt);

  if (intent.kind === 'scaffold') {
    // Governed create — Personal draft, owner = the asker (RLS enforced inside).
    const draft = await createArtifact(user, {
      type: intent.type,
      name: intent.name,
      description: `Scaffolded from the Home assistant: “${prompt.trim().slice(0, 160)}”. Personal draft — promote when ready (a human still approves).`,
      tags: ['home-assistant', 'draft'],
    });
    const tab = deepLinkForType(intent.type);
    const rec = await trace({
      principal: ASK_PRINCIPAL,
      tool: 'generate',
      input: { by: user.id, role: user.role, prompt: prompt.trim().slice(0, 240), intent: 'scaffold', type: intent.type },
      output: { draftId: draft.id, visibility: draft.visibility },
      decision: 'allow',
    });
    return {
      mode: 'scaffold',
      text: `Done — I scaffolded a Personal ${TYPE_LABELS[intent.type] ?? intent.type} draft, “${draft.name}”, owned by you. Open it to finish and document it; a Builder/Admin promotes it when it's ready.`,
      deepLink: tab,
      draft: { id: draft.id, name: draft.name, type: draft.type },
      traceId: rec.id,
    };
  }

  if (intent.kind === 'human-gate') {
    const rec = await trace({
      principal: ASK_PRINCIPAL,
      tool: 'generate',
      input: { by: user.id, role: user.role, prompt: prompt.trim().slice(0, 240), intent: 'human-gate' },
      output: { refused: true, reason: 'promote/certify stays human' },
      decision: 'requires_approval',
    });
    return { mode: 'human-gate', text: intent.reason, deepLink: intent.tab, traceId: rec.id };
  }

  // Answer mode — a short, honest pointer (deterministic; no live LLM in the gate).
  const text = answerFor(prompt);
  const rec = await trace({
    principal: ASK_PRINCIPAL,
    tool: 'generate',
    input: { by: user.id, role: user.role, prompt: prompt.trim().slice(0, 240), intent: 'answer' },
    output: { answered: true },
    decision: 'allow',
  });
  return { mode: 'answer', text, traceId: rec.id };
}

function deepLinkForType(type: string): string {
  const map: Record<string, string> = {
    dataset: '/data',
    transformation: '/data',
    metric: '/metrics',
    dashboard: '/dashboards',
    agent: '/agents',
    knowledge: '/knowledge',
    connection: '/connections',
    file: '/unstructured',
  };
  return map[type] ?? '/data';
}

function answerFor(prompt: string): string {
  const p = (prompt ?? '').toLowerCase();
  if (/dashboard/.test(p)) return 'Dashboards turn governed metrics into charts your team and agents both trust. Open Dashboards to build one, or ask me to “build a dashboard of …” and I’ll scaffold a draft.';
  if (/agent/.test(p)) return 'Agents combine your data, knowledge and governed tools. Open Agents to create one, or ask me to “create an agent that …” to scaffold a draft.';
  if (/data|csv|table/.test(p)) return 'The Data path turns a raw file into a governed, documented product. Open Data to load one, or ask me to “build a dataset of …”.';
  if (/metric|kpi/.test(p)) return 'Metrics are the KPIs everyone agrees on, defined once in the semantic layer. Open Metrics, or ask me to “define a metric for …”.';
  return 'I can answer questions about the golden paths or scaffold a governed draft for you. Try “build a dashboard of churn by region” or “create an agent that drafts renewal emails”. Promoting and certifying always stay a human decision.';
}
