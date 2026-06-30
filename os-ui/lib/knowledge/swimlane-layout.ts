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
 * (Human / Software / Agent). We render actor-colored horizontal LANES, one per
 * actor type that appears, and place steps left-to-right in sequence inside their
 * actor's lane. Sequential connectors join step i → step i+1.
 */

export type LaneType = ActorType;

export type Lane = {
  actor: LaneType;
  y: number;
  height: number;
  /** Lane row index (0-based, in display order). */
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

const BLOCK_W = 168;
const BLOCK_H = 82;
const GAP_X = 56;
const LANE_PAD_Y = 16;
const LANE_LABEL_W = 96;
const PAD = 20;

/**
 * Lay out a workflow's steps as actor swimlanes. `gapFor` reports how many of a
 * step's links point at a missing entity (injected so the layout stays pure and
 * the resolver can be mocked).
 */
export function layoutSwimlanes(
  workflow: Workflow,
  opts: { gapFor?: (step: WorkflowStep) => number } = {},
): SwimlaneLayout {
  const gapFor = opts.gapFor ?? (() => 0);

  // Which actor lanes actually appear (in fixed order).
  const present = LANE_ORDER.filter((actor) => workflow.steps.some((s) => s.actor === actor));
  const laneActors = present.length > 0 ? present : (['Human'] as ActorType[]);

  const laneHeight = BLOCK_H + LANE_PAD_Y * 2;
  const lanes: Lane[] = laneActors.map((actor, index) => ({
    actor,
    index,
    y: PAD + index * laneHeight,
    height: laneHeight,
  }));
  const laneY = new Map<ActorType, Lane>();
  for (const l of lanes) laneY.set(l.actor, l);

  const stepCount = workflow.steps.length;
  const contentW = LANE_LABEL_W + stepCount * BLOCK_W + Math.max(0, stepCount - 1) * GAP_X;
  const width = PAD * 2 + Math.max(contentW, LANE_LABEL_W + BLOCK_W);
  const height = PAD * 2 + lanes.length * laneHeight;

  const blockById = new Map<string, StepBlock>();
  const blocks: StepBlock[] = workflow.steps.map((s, seq) => {
    const lane = laneY.get(s.actor) ?? lanes[0];
    const block: StepBlock = {
      id: s.id,
      title: s.title,
      actor: s.actor,
      actorName: s.actor_name,
      seq,
      x: PAD + LANE_LABEL_W + seq * (BLOCK_W + GAP_X),
      y: lane.y + LANE_PAD_Y,
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

  // Sequential connectors: step i → step i+1.
  const edges: StepEdge[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    edges.push({
      from: a.id,
      to: b.id,
      x1: a.x + a.w,
      y1: a.y + a.h / 2,
      x2: b.x,
      y2: b.y + b.h / 2,
    });
  }

  return { lanes, blocks, edges, width, height };
}
