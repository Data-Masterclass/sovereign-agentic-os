/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type DomainKnowledge } from './schema.ts';

/**
 * Pure UNIT chunking for the knowledge context layer. We chunk by UNIT — a step,
 * a rule, a tacit note, a domain-card section — NOT arbitrary windows, so each
 * retrieved item is a coherent, citable thing with provenance. Deterministic +
 * side-effect-free so the index pipeline and tests share it.
 *
 * Every unit carries the metadata envelope the retrieval + governance layers need
 * (`domain, workflow_id, step_id, type, actor, owner, version, visibility`) plus
 * the rerank signals (`trust, freshness, authority`). Summaries are stored AS
 * units with provenance, never as canonical truth.
 */

export type UnitType = 'domain' | 'workflow' | 'rule' | 'tacit';

export type Provenance = {
  domain: string;
  workflowId: string | null;
  stepId: string | null;
  type: UnitType;
  actor: string | null;
  owner: string;
  version: string;
  visibility: string;
  /** 0..1 — source precedence (certified > shared > personal; hard rule > soft). */
  trust: number;
  /** ISO timestamp the unit was last updated (freshness signal). */
  updatedAt: string;
  /** 0..1 — authority of the unit type (hard rule + workflow steps rank high). */
  authority: number;
};

export type KnowledgeUnit = {
  id: string;
  title: string;
  text: string;
  provenance: Provenance;
};

export type IndexInputs = {
  workflow: Workflow;
  owner: string;
  /** The sibling tacit.md (workflow-level tacit doc), if any. */
  tacit?: string;
  updatedAt?: string;
};

function visibilityTrust(visibility: string): number {
  if (visibility === 'Marketplace') return 1.0;
  if (visibility === 'Shared') return 0.7;
  return 0.4; // Personal
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Chunk a workflow (steps + rules + tacit) into citable units with provenance. */
export function chunkWorkflow(input: IndexInputs): KnowledgeUnit[] {
  const { workflow, owner } = input;
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const baseTrust = visibilityTrust(workflow.visibility);
  const units: KnowledgeUnit[] = [];

  const prov = (over: Partial<Provenance> & Pick<Provenance, 'type' | 'authority' | 'trust'>): Provenance => ({
    domain: workflow.domain,
    workflowId: workflow.id,
    stepId: null,
    actor: null,
    owner,
    version: workflow.version,
    visibility: workflow.visibility,
    updatedAt,
    ...over,
  });

  // 1) One unit per STEP (the structured, machine-readable step).
  workflow.steps.forEach((s, i) => {
    // Include BOTH the label and the entity ref/FQN so a step is retrievable by
    // either the human name ("Customer Applications") or the id ("sales.gold...").
    const linkText = s.links.map((l) => `${l.type}:${l.label ? `${l.label} (${l.ref})` : l.ref}`).join(', ');
    const text = [
      `Step ${i + 1}: ${s.title}`,
      `Actor: ${s.actor}${s.actor_name ? ` (${s.actor_name})` : ''}`,
      s.inputs.length ? `Inputs: ${s.inputs.join(', ')}` : '',
      s.outputs.length ? `Outputs: ${s.outputs.join(', ')}` : '',
      linkText ? `Links: ${linkText}` : '',
    ].filter(Boolean).join('\n');
    units.push({
      id: `${workflow.id}:step:${s.id}`,
      title: `${workflow.title} — ${s.title}`,
      text,
      provenance: prov({ type: 'workflow', stepId: s.id, actor: s.actor, trust: baseTrust, authority: 0.8 }),
    });

    // Per-step inline tacit note.
    if (s.tacit.trim()) {
      units.push({
        id: `${workflow.id}:tacit:${s.id}`,
        title: `${workflow.title} — tacit (${s.title})`,
        text: s.tacit.trim(),
        provenance: prov({ type: 'tacit', stepId: s.id, actor: s.actor, trust: clamp01(baseTrust - 0.05), authority: 0.5 }),
      });
    }

    // Step-level rules.
    for (const r of s.rules) {
      units.push({
        id: `${workflow.id}:rule:${r.id}`,
        title: `${workflow.title} — ${r.hard ? 'hard' : 'soft'} rule (${s.title})`,
        text: r.text,
        provenance: prov({
          type: 'rule',
          stepId: s.id,
          trust: clamp01(baseTrust + (r.hard ? 0.2 : 0)),
          authority: r.hard ? 1.0 : 0.6,
        }),
      });
    }
  });

  // 2) Workflow-level rules.
  for (const r of workflow.rules) {
    units.push({
      id: `${workflow.id}:rule:${r.id}`,
      title: `${workflow.title} — ${r.hard ? 'hard' : 'soft'} rule`,
      text: r.text,
      provenance: prov({
        type: 'rule',
        stepId: r.scope === 'step' ? r.step_id ?? null : null,
        trust: clamp01(baseTrust + (r.hard ? 0.2 : 0)),
        authority: r.hard ? 1.0 : 0.6,
      }),
    });
  }

  // 3) Workflow-level tacit doc (sibling tacit.md) — split by markdown heading.
  if (input.tacit && input.tacit.trim()) {
    const sections = splitTacit(input.tacit);
    sections.forEach((sec, i) => {
      units.push({
        id: `${workflow.id}:tacit:doc:${i}`,
        title: `${workflow.title} — tacit${sec.heading ? ` (${sec.heading})` : ''}`,
        text: sec.text,
        provenance: prov({ type: 'tacit', trust: clamp01(baseTrust - 0.05), authority: 0.55 }),
      });
    });
  }

  return units;
}

/** Chunk the general domain knowledge (the pinned domain card) into units. */
export function chunkDomain(dk: DomainKnowledge, owner = 'domain'): KnowledgeUnit[] {
  return dk.sections
    .filter((s) => s.content.trim())
    .map((s) => ({
      id: `domain:${dk.domain}:${s.id}`,
      title: `${dk.domain} — ${s.title}`,
      text: s.content.trim(),
      provenance: {
        domain: dk.domain,
        workflowId: null,
        stepId: null,
        type: 'domain' as UnitType,
        actor: null,
        owner,
        version: '1',
        visibility: 'Shared',
        updatedAt: dk.updatedAt,
        trust: 0.8,
        authority: 0.7,
      },
    }));
}

/** Split a tacit markdown doc into heading-delimited sections (pure). */
export function splitTacit(md: string): { heading: string; text: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: { heading: string; text: string }[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out.length ? out : [{ heading: '', text: md.trim() }];
}
