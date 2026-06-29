/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System } from './system-schema.ts';

/**
 * Pure layout for the hand-rolled SVG system canvas (no heavy graph dep,
 * air-gap-clean). It places the entrypoint/supervisor on a top row and the
 * remaining agents on rows below, and resolves each edge to block-anchored
 * coordinates. Deterministic + side-effect-free so it is unit-testable and the
 * canvas component stays a thin renderer over `system.yaml`.
 */

export type Block = {
  id: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  entrypoint: boolean;
  supervisor: boolean;
  disabled: boolean;
  tools: number;
  model: string | null;
};

export type LaidEdge = {
  from: string;
  to: string;
  type: 'supervise' | 'handoff';
  when?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Layout = { blocks: Block[]; edges: LaidEdge[]; width: number; height: number };

const BLOCK_W = 180;
const BLOCK_H = 84;
const GAP_X = 48;
const GAP_Y = 80;
const PAD = 32;

export function layoutSystem(system: System, opts: { disabledAgents?: string[] } = {}): Layout {
  const disabled = new Set(opts.disabledAgents ?? []);

  // Row 0: the entrypoint + any other supervisors. Row 1+: the rest, chunked.
  const supervisors = system.agents.filter((a) => a.id === system.entrypoint || (a.members?.length ?? 0) > 0);
  const supIds = new Set(supervisors.map((a) => a.id));
  const others = system.agents.filter((a) => !supIds.has(a.id));

  const rows: typeof system.agents[] = [];
  if (supervisors.length) rows.push(supervisors);
  const PER_ROW = 3;
  for (let i = 0; i < others.length; i += PER_ROW) rows.push(others.slice(i, i + PER_ROW));
  if (rows.length === 0) rows.push(system.agents);

  const maxCols = Math.max(1, ...rows.map((r) => r.length));
  const width = PAD * 2 + maxCols * BLOCK_W + (maxCols - 1) * GAP_X;
  const height = PAD * 2 + rows.length * BLOCK_H + (rows.length - 1) * GAP_Y;

  const pos = new Map<string, Block>();
  rows.forEach((row, r) => {
    const rowWidth = row.length * BLOCK_W + (row.length - 1) * GAP_X;
    const startX = (width - rowWidth) / 2;
    row.forEach((a, c) => {
      pos.set(a.id, {
        id: a.id,
        role: a.role,
        x: startX + c * (BLOCK_W + GAP_X),
        y: PAD + r * (BLOCK_H + GAP_Y),
        w: BLOCK_W,
        h: BLOCK_H,
        entrypoint: a.id === system.entrypoint,
        supervisor: (a.members?.length ?? 0) > 0,
        disabled: disabled.has(a.id),
        tools: (a.tools ?? system.grants.tools).length,
        model: a.model ?? null,
      });
    });
  });

  const blocks = system.agents.map((a) => pos.get(a.id)!).filter(Boolean);

  const link = (fromId: string, toId: string, type: 'supervise' | 'handoff', when?: string): LaidEdge | null => {
    const from = pos.get(fromId);
    const to = pos.get(toId);
    if (!from || !to) return null; // dangling edges are a compile error; skip in the view
    return {
      from: fromId,
      to: toId,
      type,
      when,
      x1: from.x + from.w / 2,
      y1: from.y + from.h,
      x2: to.x + to.w / 2,
      y2: to.y,
    };
  };

  const edges: LaidEdge[] = [];
  const supervisePairs = new Set<string>();
  for (const e of system.edges) {
    const laid = link(e.from, e.to, e.type, e.when);
    if (!laid) continue;
    if (e.type === 'supervise') supervisePairs.add(`${e.from}->${e.to}`);
    edges.push(laid);
  }

  // The router fans out to a supervisor's members regardless of an explicit
  // `supervise` return edge (the compiler derives conditional edges from
  // `members`). Draw those routes too — deduped — so a member added by the
  // agent-system helper (membership, no edge) still shows a connecting line.
  for (const a of system.agents) {
    for (const m of a.members ?? []) {
      if (supervisePairs.has(`${a.id}->${m}`)) continue;
      const laid = link(a.id, m, 'supervise');
      if (laid) {
        supervisePairs.add(`${a.id}->${m}`);
        edges.push(laid);
      }
    }
  }

  return { blocks, edges, width, height };
}
