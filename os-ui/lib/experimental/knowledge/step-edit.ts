/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type Workflow,
  type WorkflowStep,
  type StepLink,
  type StepRule,
  type ActorType,
  type Actor,
  KnowledgeError,
} from './schema.ts';

/**
 * Pure, immutable `workflow.md` mutations for the hand-rolled SVG swimlane
 * (clone of `lib/agents/canvas-edit.ts`). Editing on the canvas (add step / set
 * actor / link / reorder / remove) produces a NEW {@link Workflow} the caller
 * serializes and commits through the SAME store write the Monaco panel uses —
 * one source of truth, two interchangeable editors (swimlane + markdown), with
 * Mermaid as a derived read-only third surface.
 *
 * Every mutation `structuredClone`s its input (never mutates).
 */

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'step';
}

function requireStep(w: Workflow, id: string): WorkflowStep {
  const s = w.steps.find((x) => x.id === id);
  if (!s) throw new KnowledgeError(`Step '${id}' is not in this workflow`);
  return s;
}

/** Append a new step. The id is derived from the title and made unique. */
export function addStep(
  input: Workflow,
  opts: { title?: string; actor?: ActorType; actorName?: string },
): Workflow {
  const w = structuredClone(input);
  const base = slug(opts.title ?? 'New step');
  let id = base;
  let n = 2;
  while (w.steps.some((s) => s.id === id)) id = `${base}-${n++}`;

  const step: WorkflowStep = {
    id,
    title: opts.title?.trim() || 'New step',
    actor: opts.actor ?? 'Human',
    actor_name: opts.actorName?.trim() ?? '',
    inputs: [],
    outputs: [],
    links: [],
    rules: [],
    tacit: '',
  };
  w.steps.push(step);
  return w;
}

/** Remove a step and any workflow-level rules scoped to it. */
export function removeStep(input: Workflow, id: string): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  w.steps = w.steps.filter((s) => s.id !== id);
  w.rules = w.rules.filter((r) => !(r.scope === 'step' && r.step_id === id));
  return w;
}

/** Move a step one position earlier (-1) or later (+1) in the flat sequence. */
export function moveStep(input: Workflow, id: string, dir: -1 | 1): Workflow {
  const idx = input.steps.findIndex((s) => s.id === id);
  if (idx < 0) throw new KnowledgeError(`Step '${id}' is not in this workflow`);
  const target = idx + dir;
  if (target < 0 || target >= input.steps.length) return input; // no-op at the ends
  const w = structuredClone(input);
  const [moved] = w.steps.splice(idx, 1);
  w.steps.splice(target, 0, moved);
  return w;
}

/** Patch a step's scalar fields (title / actor / actor_name / tacit). */
export function updateStep(
  input: Workflow,
  id: string,
  patch: Partial<Pick<WorkflowStep, 'title' | 'actor' | 'actor_name' | 'tacit'>>,
): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  if (patch.title !== undefined) s.title = patch.title.trim() || s.title;
  if (patch.actor !== undefined) s.actor = patch.actor;
  if (patch.actor_name !== undefined) s.actor_name = patch.actor_name.trim();
  if (patch.tacit !== undefined) s.tacit = patch.tacit;
  return w;
}

/** Replace a step's inputs / outputs lists. */
export function setStepIO(
  input: Workflow,
  id: string,
  io: { inputs?: string[]; outputs?: string[] },
): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  if (io.inputs !== undefined) s.inputs = io.inputs.map((x) => x.trim()).filter(Boolean);
  if (io.outputs !== undefined) s.outputs = io.outputs.map((x) => x.trim()).filter(Boolean);
  return w;
}

/** Add an entity link to a step. */
export function addStepLink(input: Workflow, id: string, link: StepLink): Workflow {
  requireStep(input, id);
  if (!link.ref.trim()) throw new KnowledgeError('A link needs a target entity reference');
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  if (s.links.some((l) => l.type === link.type && l.ref === link.ref)) return w; // idempotent
  s.links.push({ type: link.type, ref: link.ref.trim(), ...(link.label ? { label: link.label.trim() } : {}) });
  return w;
}

/** Remove an entity link from a step (by type + ref). */
export function removeStepLink(input: Workflow, id: string, link: { type: string; ref: string }): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  s.links = s.links.filter((l) => !(l.type === link.type && l.ref === link.ref));
  return w;
}

/** Add a step-level decision rule (soft by default). */
export function addStepRule(input: Workflow, id: string, rule: { text: string; hard?: boolean }): Workflow {
  requireStep(input, id);
  if (!rule.text.trim()) throw new KnowledgeError('A rule needs text');
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  const rid = `sr-${s.rules.length + 1}-${Math.random().toString(36).slice(2, 5)}`;
  const r: StepRule = { id: rid, text: rule.text.trim(), hard: Boolean(rule.hard) };
  s.rules.push(r);
  return w;
}

/** Toggle a step-level rule between soft and hard. */
export function setStepRuleHard(input: Workflow, id: string, ruleId: string, hard: boolean): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  const r = s.rules.find((x) => x.id === ruleId);
  if (r) r.hard = hard;
  return w;
}

/** Remove a step-level rule. */
export function removeStepRule(input: Workflow, id: string, ruleId: string): Workflow {
  requireStep(input, id);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === id)!;
  s.rules = s.rules.filter((r) => r.id !== ruleId);
  return w;
}

// ------------------------------------------------------ actor registry -------

/** Add an actor to the workflow's registry. Deduped by (category, name). */
export function addActor(
  input: Workflow,
  actor: { name: string; category: ActorType; description?: string },
): Workflow {
  const name = actor.name.trim();
  if (!name) throw new KnowledgeError('An actor needs a name');
  const w = structuredClone(input);
  const dup = w.actors.some(
    (a) => a.category === actor.category && a.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (dup) return w; // idempotent
  const next: Actor = {
    id: `actor-${w.actors.length + 1}-${Math.random().toString(36).slice(2, 5)}`,
    name,
    category: actor.category,
  };
  if (actor.description?.trim()) next.description = actor.description.trim();
  w.actors.push(next);
  return w;
}

/** Patch a registry actor (name / category / description) by id. */
export function updateActor(
  input: Workflow,
  actorId: string,
  patch: Partial<Pick<Actor, 'name' | 'category' | 'description'>>,
): Workflow {
  const w = structuredClone(input);
  const a = w.actors.find((x) => x.id === actorId);
  if (!a) throw new KnowledgeError(`Actor '${actorId}' is not in this workflow`);
  if (patch.name !== undefined) a.name = patch.name.trim() || a.name;
  if (patch.category !== undefined) a.category = patch.category;
  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (d) a.description = d;
    else delete a.description;
  }
  return w;
}

/** Remove a registry actor by id. Does not touch steps (their actor_name stays). */
export function removeActor(input: Workflow, actorId: string): Workflow {
  const w = structuredClone(input);
  w.actors = w.actors.filter((a) => a.id !== actorId);
  return w;
}

/** Set a step's actor from a registry entry — sets BOTH category and actor_name. */
export function setStepActorFromRegistry(input: Workflow, stepId: string, actor: Actor): Workflow {
  requireStep(input, stepId);
  const w = structuredClone(input);
  const s = w.steps.find((x) => x.id === stepId)!;
  s.actor = actor.category;
  s.actor_name = actor.name.trim();
  return w;
}
