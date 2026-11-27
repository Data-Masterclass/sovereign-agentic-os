/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { withServerCode } from '@core/kernel/server-message';
import {
  type Workflow,
  type WorkflowStep,
  type StepLink,
  type StepRule,
  type ActorType,
  type Actor,
  actorKey,
  normalizeActorPrompt,
  KnowledgeError,
} from '@tabs/knowledge/lib/schema';

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
  if (!s) throw withServerCode(new KnowledgeError(`Step '${id}' is not in this workflow`), 'workflows.stepNotFound', { step: id });
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
  if (idx < 0) throw withServerCode(new KnowledgeError(`Step '${id}' is not in this workflow`), 'workflows.stepNotFound', { step: id });
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
  if (!link.ref.trim()) throw withServerCode(new KnowledgeError('A link needs a target entity reference'), 'workflows.linkTargetRequired');
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
  if (!rule.text.trim()) throw withServerCode(new KnowledgeError('A rule needs text'), 'workflows.ruleTextRequired');
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
  actor: { name: string; category: ActorType; description?: string; prompt?: string },
): Workflow {
  const name = actor.name.trim();
  if (!name) throw withServerCode(new KnowledgeError('An actor needs a name'), 'workflows.actorNameRequired');
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
  // An Agent actor's long prompt — the head of the AGENT.md the scaffold writes. Normalised
  // and capped here too, so an over-long paste fails at the mutation, where the user can
  // still see (and shorten) their draft, rather than at the next parse.
  if (actor.prompt?.trim()) next.prompt = normalizeActorPrompt(name, actor.prompt);
  w.actors.push(next);
  return w;
}

/**
 * Patch a registry actor (name / category / description) by id.
 *
 * A name or category change TRAVELS: every step that referenced the old
 * (category, name) pair is rewritten in the same returned workflow, so one commit
 * leaves the registry and the steps agreeing. Steps reference an actor by that pair,
 * so a registry-only rename used to leave every step pointing at a name nobody
 * declared — a warning at best, a silent mismatch at worst.
 */
export function updateActor(
  input: Workflow,
  actorId: string,
  patch: Partial<Pick<Actor, 'name' | 'category' | 'description' | 'prompt'>>,
): Workflow {
  const w = structuredClone(input);
  const a = w.actors.find((x) => x.id === actorId);
  if (!a) throw withServerCode(new KnowledgeError(`Actor '${actorId}' is not in this workflow`), 'workflows.actorNotFound', { actor: actorId });
  const oldKey = actorKey(a.category, a.name);
  if (patch.name !== undefined) a.name = patch.name.trim() || a.name;
  if (patch.category !== undefined) a.category = patch.category;
  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (d) a.description = d;
    else delete a.description;
  }
  // The long agent prompt. An empty string DELETES it (same shape as description), while an
  // omitted key leaves it alone — the inspector saves name/category/description/prompt together.
  if (patch.prompt !== undefined) {
    const p = normalizeActorPrompt(a.name, patch.prompt);
    if (p) a.prompt = p;
    else delete a.prompt;
  }
  const dup = w.actors.find((x) => x.id !== a.id && actorKey(x.category, x.name) === actorKey(a.category, a.name));
  if (dup) throw withServerCode(new KnowledgeError(`Another actor is already named '${a.name}' (${a.category})`), 'workflows.actorNameTaken', { name: a.name, category: a.category });
  for (const s of w.steps) {
    if (!s.actor_name.trim()) continue;
    if (actorKey(s.actor, s.actor_name) !== oldKey) continue;
    s.actor = a.category;
    s.actor_name = a.name;
  }
  return w;
}

/**
 * Remove a registry actor by id.
 *
 * What happens to the steps that use it is the CALLER's decision, because there is no
 * safe default — the UI asks:
 *   - `{ reassignTo: <actorId> }` — point every referencing step at that registry actor;
 *   - `{ clearSteps: true }`      — clear their actor name (the step becomes unassigned);
 *   - neither                     — registry-only removal. The steps keep the name, and
 *                                   `actorWarnings()` reports each one. The actor does NOT
 *                                   come back on the next load.
 */
export function removeActor(
  input: Workflow,
  actorId: string,
  opts: { reassignTo?: string; clearSteps?: boolean } = {},
): Workflow {
  const w = structuredClone(input);
  const gone = w.actors.find((a) => a.id === actorId);
  if (!gone) return w; // idempotent — nothing addressed by that id
  const target = opts.reassignTo ? w.actors.find((a) => a.id === opts.reassignTo) : undefined;
  if (opts.reassignTo && !target) throw withServerCode(new KnowledgeError(`Actor '${opts.reassignTo}' is not in this workflow`), 'workflows.actorNotFound', { actor: opts.reassignTo });
  if (target && target.id === actorId) throw withServerCode(new KnowledgeError('An actor cannot be reassigned to itself'), 'workflows.actorSelfReassign');

  const goneKey = actorKey(gone.category, gone.name);
  if (target || opts.clearSteps) {
    for (const s of w.steps) {
      if (!s.actor_name.trim()) continue;
      if (actorKey(s.actor, s.actor_name) !== goneKey) continue;
      if (target) { s.actor = target.category; s.actor_name = target.name; }
      else s.actor_name = '';
    }
  }
  // By object identity, not by id: ids are uniquified on load, but a hand-edited file can
  // still carry the same id twice, and "delete one actor" must never remove two.
  w.actors = w.actors.filter((a) => a !== gone);
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
