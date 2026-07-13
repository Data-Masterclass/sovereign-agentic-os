/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type WorkflowStep, type ActorType } from './schema.ts';

/**
 * Pure layout for the hand-rolled SVG workflow swimlane (no heavy graph dep,
 * air-gap clean). Clone of `lib/agents/canvas-layout.ts`: deterministic +
 * side-effect-free so it is unit-testable and the canvas component stays a thin
 * renderer over `workflow.md`.
 *
 * A workflow is FLAT (no nesting). Each step is tagged with an actor
 * (Human / Software / Agent). We render actor-colored vertical LANES (columns),
 * one per actor type that appears, and place steps top-to-bottom in sequence
 * inside their actor's column. Sequential connectors join step i → step i+1
 * vertically. A vertical flow fits the viewport width (one column per actor)
 * and scrolls down as steps accumulate — no horizontal overflow.
 */

export type LaneType = ActorType;

export type Lane = {
  actor: LaneType;
  x: number;
  width: number;
  /** Lane column index (0-based, in display order). */
  index: number;
};

export type StepBlock = {
  id: string;
  title: string;
  actor: ActorType;
  actorName: string;
  /** Sequence index (0-based) in the flat step list. */
  seq: number;
  x: number;
  y: number;
  w: number;
  h: number;
  inputs: number;
  outputs: number;
  links: number;
  /** Number of links that reference a missing entity (a "gap"). */
  gaps: number;
  /** Has at least one hard step-rule (renders a guardrail marker). */
  hasHardRule: boolean;
  hasTacit: boolean;
};

export type StepEdge = {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type SwimlaneLayout = {
  lanes: Lane[];
  blocks: StepBlock[];
  edges: StepEdge[];
  width: number;
  height: number;
};

/** Fixed display order for lanes — only lanes with steps are drawn. */
const LANE_ORDER: ActorType[] = ['Human', 'Software', 'Agent'];

const BLOCK_W = 200;
const BLOCK_H = 82;
const GAP_Y = 44;
const LANE_PAD_X = 16;
const LANE_LABEL_H = 30;
const PAD = 20;

/**
 * Lay out a workflow's steps as actor swimlanes (vertical columns). `gapFor`
 * reports how many of a step's links point at a missing entity (injected so the
 * layout stays pure and the resolver can be mocked).
 */
export function layoutSwimlanes(
  workflow: Workflow,
  opts: { gapFor?: (step: WorkflowStep) => number } = {},
): SwimlaneLayout {
  const gapFor = opts.gapFor ?? (() => 0);

  // Which actor lanes actually appear (in fixed order).
  const present = LANE_ORDER.filter((actor) => workflow.steps.some((s) => s.actor === actor));
  const laneActors = present.length > 0 ? present : (['Human'] as ActorType[]);

  const laneWidth = BLOCK_W + LANE_PAD_X * 2;
  const lanes: Lane[] = laneActors.map((actor, index) => ({
    actor,
    index,
    x: PAD + index * laneWidth,
    width: laneWidth,
  }));
  const laneX = new Map<ActorType, Lane>();
  for (const l of lanes) laneX.set(l.actor, l);

  const stepCount = workflow.steps.length;
  const contentH = LANE_LABEL_H + stepCount * BLOCK_H + Math.max(0, stepCount - 1) * GAP_Y;
  const width = PAD * 2 + lanes.length * laneWidth;
  const height = PAD * 2 + Math.max(contentH, LANE_LABEL_H + BLOCK_H);

  const blockById = new Map<string, StepBlock>();
  const blocks: StepBlock[] = workflow.steps.map((s, seq) => {
    const lane = laneX.get(s.actor) ?? lanes[0];
    const block: StepBlock = {
      id: s.id,
      title: s.title,
      actor: s.actor,
      actorName: s.actor_name,
      seq,
      x: lane.x + LANE_PAD_X,
      y: PAD + LANE_LABEL_H + seq * (BLOCK_H + GAP_Y),
      w: BLOCK_W,
      h: BLOCK_H,
      inputs: s.inputs.length,
      outputs: s.outputs.length,
      links: s.links.length,
      gaps: gapFor(s),
      hasHardRule: s.rules.some((r) => r.hard),
      hasTacit: s.tacit.trim().length > 0,
    };
    blockById.set(s.id, block);
    return block;
  });

  // Sequential connectors: step i → step i+1 (top-to-bottom).
  const edges: StepEdge[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    edges.push({
      from: a.id,
      to: b.id,
      x1: a.x + a.w / 2,
      y1: a.y + a.h,
      x2: b.x + b.w / 2,
      y2: b.y,
    });
  }

  return { lanes, blocks, edges, width, height };
}
