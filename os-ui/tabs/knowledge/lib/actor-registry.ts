/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    Pure queries over a workflow's actor registry
 * USER STORY: As a process owner I must see which steps an actor is used by before I rename or
 *             delete it, and be told when a step names an actor the registry no longer holds.
 * ARCHITECTURE:
 *   - Pure + dependency-free (schema types only), so both the inspectors and the tests use the
 *     SAME answers: no component re-derives "who uses this actor" from its own loop.
 *   - A step referencing an unknown actor is a VALIDATION WARNING. The registry is the source of
 *     truth (`schema.ts` → `resolveActorRegistry`); nothing here ever adds an entry back.
 *   - Imports only this tab. No `server-only`, no IO — it runs in the browser too.
 */
import { actorKey, type Actor, type Workflow, type WorkflowStep } from '@tabs/knowledge/lib/schema';

/** A step that names an actor the registry does not hold. */
export type ActorWarning = {
  stepId: string;
  stepTitle: string;
  actorCategory: string;
  actorName: string;
  message: string;
};

/** The registry entry a step points at, or `undefined` when the step's actor is unknown. */
export function actorForStep(workflow: Workflow, step: WorkflowStep): Actor | undefined {
  if (!step.actor_name.trim()) return undefined;
  const key = actorKey(step.actor, step.actor_name);
  return workflow.actors.find((a) => actorKey(a.category, a.name) === key);
}

/** The steps that use an actor, in workflow order. */
export function stepsUsingActor(workflow: Workflow, actor: Actor): WorkflowStep[] {
  const key = actorKey(actor.category, actor.name);
  return workflow.steps.filter((s) => s.actor_name.trim() && actorKey(s.actor, s.actor_name) === key);
}

/** Find a registry actor by id. */
export function findActorById(workflow: Workflow, actorId: string): Actor | undefined {
  return workflow.actors.find((a) => a.id === actorId);
}

/**
 * Every step whose actor is not in the registry. A step with no actor name at all is
 * NOT a warning — it is simply unassigned, which the inspector shows as "Choose an
 * actor…". Warnings are reported, never repaired: repairing them silently is exactly
 * the resurrection bug this module exists to prevent.
 */
export function actorWarnings(workflow: Workflow): ActorWarning[] {
  const out: ActorWarning[] = [];
  for (const step of workflow.steps) {
    const name = step.actor_name.trim();
    if (!name) continue;
    if (actorForStep(workflow, step)) continue;
    out.push({
      stepId: step.id,
      stepTitle: step.title,
      actorCategory: step.actor,
      actorName: name,
      message: `This step names “${name}” (${step.actor}), which is not in the actor registry. Pick a registry actor for the step, or add the actor back.`,
    });
  }
  return out;
}
