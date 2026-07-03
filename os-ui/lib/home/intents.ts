/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Ask-anything **intent parser** (home-golden-path.md §"Ask-anything").
 *
 * PURE + deterministic (air-gapped — no live LLM in the validation gate, mirror
 * of lib/agents/assistant.ts). It classifies a free-text prompt into one of
 * three governed intents:
 *
 *   • `scaffold` — "build / create / scaffold a <type> …" → the assistant will
 *     create a Personal DRAFT through the SAME governed create flow the tab uses
 *     (RLS: owned by the asker, in their domain). Two-mode #2.
 *   • `human-gate` — "promote / certify / publish / share …" → REFUSED to be
 *     done by the assistant; promote/certify stay HUMAN. We return the governed
 *     path to do it (the owning tab + the approval), never the action itself.
 *   • `answer` — everything else → an explanatory answer (mode #1).
 *
 * CRITICAL safety property: the prompt is treated as DATA, never as authority.
 * A scaffold can only ever produce a *Personal* draft owned by the asker; it can
 * never broaden visibility or skip the human promote/certify gate.
 */

import type { ArtifactType } from '../artifact-model.ts';

export type AskIntent =
  | { kind: 'scaffold'; type: ArtifactType; name: string }
  | { kind: 'human-gate'; reason: string; tab: string }
  | { kind: 'answer' };

/** Words that name a creatable artifact type, mapped to the registry type. */
const TYPE_WORDS: { re: RegExp; type: ArtifactType }[] = [
  { re: /\bdashboards?\b/i, type: 'dashboard' },
  { re: /\bmetrics?|kpis?\b/i, type: 'metric' },
  { re: /\bagents?\b/i, type: 'agent' },
  { re: /\bknowledge|docs?\b/i, type: 'knowledge' },
  { re: /\bconnections?\b/i, type: 'connection' },
  { re: /\b(datasets?|data products?|tables?)\b/i, type: 'dataset' },
  { re: /\btransformations?|dbt models?\b/i, type: 'transformation' },
];

/** Verbs that, in this two-mode design, MUST stay a human decision. */
const HUMAN_GATE_RE = /\b(?:promote\w*|certif\w*|publish\w*|share to (?:the )?marketplace|go ?live|make (?:it )?(?:shared|certified|public))\b/i;

/** Verbs that ask the assistant to scaffold a governed draft. */
const SCAFFOLD_RE = /\b(build|create|scaffold|make me|set up|draft|start|new|generate)\b/i;

/** Trim a scaffold prompt into a short, sensible draft name. */
export function deriveName(prompt: string, type: ArtifactType): string {
  // Prefer the phrase after "of/for/called/named/about", else the whole prompt.
  const m = /\b(?:called|named|of|for|about|that|to)\s+(.+)$/i.exec(prompt.trim());
  const raw = (m ? m[1] : prompt)
    .replace(/\b(a|an|the|please|me|governed|new)\b/gi, ' ')
    .replace(/[^\w %&/+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = raw.length > 0 ? raw : `${type} draft`;
  // Title-ish, capped.
  const capped = name.length > 60 ? name.slice(0, 60).trim() + '…' : name;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

const TAB_FOR_TYPE: Record<ArtifactType, string> = {
  dataset: '/data',
  transformation: '/data',
  metric: '/metrics',
  dashboard: '/dashboards',
  agent: '/agents',
  knowledge: '/knowledge',
  connection: '/connections',
  file: '/unstructured',
  skill: '/agents',
};

export function classifyAsk(prompt: string): AskIntent {
  const text = (prompt ?? '').trim();
  if (!text) return { kind: 'answer' };

  const typeHit = TYPE_WORDS.find((t) => t.re.test(text));

  // Human-gated verbs win over everything: never let the box promote/certify.
  if (HUMAN_GATE_RE.test(text)) {
    const tab = typeHit ? TAB_FOR_TYPE[typeHit.type] : '/governance';
    return {
      kind: 'human-gate',
      reason:
        'Promoting and certifying stay a human decision. I can take you to the governed flow, but a Builder/Admin makes the call.',
      tab,
    };
  }

  // Scaffold: a create verb AND a recognised artifact type.
  if (SCAFFOLD_RE.test(text) && typeHit) {
    return { kind: 'scaffold', type: typeHit.type, name: deriveName(text, typeHit.type) };
  }

  return { kind: 'answer' };
}

export { TAB_FOR_TYPE };
