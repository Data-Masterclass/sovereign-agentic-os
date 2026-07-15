/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ComponentRef, SolutionEdge, InterplayRelation, Tab } from './model.ts';

/**
 * Pure layout for the hand-rolled SVG interplay canvas (clone of the agent
 * canvas-layout — no heavy graph dep, air-gap clean). It arranges a bet's
 * solution blueprint into three horizontal TYPE BANDS and resolves each
 * interplay edge to block-anchored coordinates. Deterministic + side-effect-free
 * so it is unit-testable and the canvas component stays a thin renderer over the
 * store's `getSolution`.
 *
 *   band 0 — Anchor    : the one anchor-workflow ref (knowledge/workflow)
 *   band 1 — Components : agent / software / ml / dashboard leaves
 *   band 2 — Context    : data / metric / knowledge / files / connection assets
 *
 * A saved `positions[refId]` overrides the computed slot (canvas drag persists),
 * otherwise the band packing decides. Edges reference ComponentRef.id (never the
 * artifactId) — the same ids the store's edges carry.
 */

/** Which band a node sits in, derived from its solution role + tab. */
export type Band = 'anchor' | 'components' | 'context';

export type Node = {
  id: string;
  artifactId: string;
  tab: Tab;
  band: Band;
  anchor: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LaidEdge = {
  id: string;
  from: string;
  to: string;
  relation: InterplayRelation;
  note?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type InterplayLayout = {
  nodes: Node[];
  edges: LaidEdge[];
  width: number;
  height: number;
  /** y-centre of each band's row of boxes — the canvas draws band labels here. */
  bands: { band: Band; label: string; y: number }[];
};

const BLOCK_W = 172;
const BLOCK_H = 72;
const GAP_X = 44;
const GAP_Y = 96;
const PAD = 32;
const PER_ROW = 4;

const COMPONENT_TABS: Tab[] = ['agent', 'software', 'ml', 'dashboard'];
const BAND_LABEL: Record<Band, string> = {
  anchor: 'Anchor workflow',
  components: 'Components',
  context: 'Context',
};

/** A node's band: the anchor ref is always band 0; leaf tabs are components; the rest is context. */
export function bandFor(ref: ComponentRef, anchorId?: string): Band {
  if (anchorId && ref.id === anchorId) return 'anchor';
  return COMPONENT_TABS.includes(ref.tab) ? 'components' : 'context';
}

export function layoutInterplay(input: {
  anchorId?: string;
  nodes: ComponentRef[];
  edges: SolutionEdge[];
  positions?: Record<string, { x: number; y: number }>;
}): InterplayLayout {
  const anchorId = input.anchorId;
  const positions = input.positions ?? {};

  // Partition the refs into the three bands (order preserved within a band).
  const banded: Record<Band, ComponentRef[]> = { anchor: [], components: [], context: [] };
  for (const ref of input.nodes) banded[bandFor(ref, anchorId)].push(ref);

  const order: Band[] = ['anchor', 'components', 'context'];
  // Only the bands that actually hold nodes take a row (an empty band collapses).
  const activeBands = order.filter((b) => banded[b].length > 0);

  const widest = Math.max(1, ...activeBands.map((b) => Math.min(banded[b].length, PER_ROW)));
  const width = PAD * 2 + widest * BLOCK_W + (widest - 1) * GAP_X;

  const pos = new Map<string, Node>();
  const bandRows: { band: Band; label: string; y: number }[] = [];
  let y = PAD;

  for (const band of activeBands) {
    const refs = banded[band];
    // Chunk a crowded band across multiple rows so it never overflows the width.
    for (let i = 0; i < refs.length; i += PER_ROW) {
      const row = refs.slice(i, i + PER_ROW);
      const rowWidth = row.length * BLOCK_W + (row.length - 1) * GAP_X;
      const startX = (width - rowWidth) / 2;
      if (i === 0) bandRows.push({ band, label: BAND_LABEL[band], y: y + BLOCK_H / 2 });
      row.forEach((ref, c) => {
        const saved = positions[ref.id];
        pos.set(ref.id, {
          id: ref.id,
          artifactId: ref.artifactId,
          tab: ref.tab,
          band,
          anchor: band === 'anchor',
          x: saved ? saved.x : startX + c * (BLOCK_W + GAP_X),
          y: saved ? saved.y : y,
          w: BLOCK_W,
          h: BLOCK_H,
        });
      });
      y += BLOCK_H + GAP_Y;
    }
  }

  const nodes = input.nodes.map((r) => pos.get(r.id)!).filter(Boolean);

  // A node dragged past the packed height still fits inside the canvas.
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0);
  const height = Math.max(PAD * 2 + maxY - PAD, PAD + BLOCK_H);

  const edges: LaidEdge[] = [];
  for (const e of input.edges) {
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue; // an edge to a removed ref is skipped in the view
    // Anchor from the source's bottom-centre to the target's top-centre when the
    // target sits below, otherwise the reverse — so up-edges read cleanly too.
    const goingDown = to.y >= from.y;
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      relation: e.relation,
      note: e.note,
      x1: from.x + from.w / 2,
      y1: goingDown ? from.y + from.h : from.y,
      x2: to.x + to.w / 2,
      y2: goingDown ? to.y : to.y + to.h,
    });
  }

  return { nodes, edges, width, height, bands: bandRows };
}
