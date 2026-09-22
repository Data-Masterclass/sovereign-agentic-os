/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type ActorType } from './schema.ts';

/**
 * Pure ONE-WAY render: Workflow → Mermaid `flowchart` text. Mermaid is a DERIVED,
 * read-only surface (the two editable surfaces are the markdown + the visual
 * swimlane). Deterministic + side-effect-free so it is unit-testable and the
 * preview component stays a thin renderer.
 *
 * Steps become nodes (shaped by actor), sequenced left→right. Actor classes give
 * the diagram the same colour language as the swimlane. We do NOT depend on the
 * mermaid runtime here — this only emits the diagram source; rendering is the
 * component's concern (and may itself be mocked/offline).
 */

/** Node shape per actor — visually distinguishes who does each step. */
function nodeShape(actor: ActorType, label: string): string {
  const safe = label.replace(/"/g, "'");
  switch (actor) {
    case 'Software':
      return `["${safe}"]`; // rectangle
    case 'Agent':
      return `{{"${safe}"}}`; // hexagon
    case 'Customer':
    case 'Partner':
      return `[["${safe}"]]`; // subroutine box — external actor
    case 'Human':
    default:
      return `(["${safe}"])`; // stadium
  }
}

const ACTOR_CLASS: Record<ActorType, string> = {
  Human: 'human',
  Software: 'software',
  Agent: 'agent',
  Customer: 'customer',
  Partner: 'partner',
};

/** Sanitise a step id into a mermaid-safe node id. */
function nodeId(id: string, i: number): string {
  const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(clean) ? clean : `s_${i}_${clean}`;
}

/** Render a workflow as Mermaid flowchart source (left-to-right). */
export function renderMermaid(workflow: Workflow): string {
  const lines: string[] = ['flowchart LR'];

  if (workflow.steps.length === 0) {
    lines.push('  empty["No steps yet"]');
    return lines.join('\n');
  }

  const ids = workflow.steps.map((s, i) => nodeId(s.id, i));

  // Nodes — label includes the actor name when present + a guardrail mark.
  workflow.steps.forEach((s, i) => {
    const hardMark = s.rules.some((r) => r.hard) ? ' 🔒' : '';
    const actorTag = s.actor_name ? `${s.actor}: ${s.actor_name}` : s.actor;
    // Mermaid needs `<br/>` for a line break inside a quoted label; a raw newline
    // inside `["…"]` breaks the parser.
    const label = `${s.title}${hardMark}<br/>(${actorTag})`;
    lines.push(`  ${ids[i]}${nodeShape(s.actor, label)}`);
  });

  // Sequential edges.
  for (let i = 0; i < workflow.steps.length - 1; i++) {
    lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
  }

  // Actor classDefs — same colour language as the swimlane.
  lines.push('  classDef human fill:#1f8f8822,stroke:#1f8f88,color:#0f6e6e;');
  lines.push('  classDef software fill:#0f406d22,stroke:#0f406d,color:#0f406d;');
  lines.push('  classDef agent fill:#c8a24a22,stroke:#c8a24a,color:#8a6516;');
  // External actors — cooler, muted tones + dashed stroke (outside the organisation).
  lines.push('  classDef customer fill:#5b7a9918,stroke:#5b7a99,color:#3f5a73,stroke-dasharray:4 3;');
  lines.push('  classDef partner fill:#8a6f9e18,stroke:#8a6f9e,color:#63507a,stroke-dasharray:4 3;');

  // Assign classes.
  workflow.steps.forEach((s, i) => {
    lines.push(`  class ${ids[i]} ${ACTOR_CLASS[s.actor]};`);
  });

  return lines.join('\n');
}
