/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { layoutSwimlanes } from './swimlane-layout.ts';
import type { Workflow, WorkflowStep } from './schema.ts';

/**
 * Pure `Workflow → standalone SVG string` render of the swimlane — the SAME
 * `layoutSwimlanes` the on-screen `SwimlaneCanvas` uses, but emitted as a
 * self-contained SVG document (concrete hex colours, no CSS vars, no runtime).
 * This is what the Export-PDF button rasterises to a PNG for page 1, so the
 * printed flow matches the interactive canvas — including the dashed external
 * (Customer / Partner) lanes.
 *
 * Framework-free + deterministic so it is trivially unit-testable; the component
 * only does the SVG→PNG rasterisation (a browser-only step) on top of this.
 */

// Concrete palette — mirrors SwimlaneCanvas' ACTOR_FILL. CSS vars can't be read
// by a rasteriser, so the house teal / navy / gold + the two external tones are
// inlined here. External lanes stay dashed + muted (outside the organisation).
const ACTOR_FILL: Record<string, string> = {
  Human: '#1f8f88', // teal
  Software: '#0f406d', // navy
  Agent: '#c8a24a', // gold
  Customer: '#5b7a99', // muted slate-blue (external)
  Partner: '#8a6f9e', // muted mauve (external)
};
const EXTERNAL = new Set(['Customer', 'Partner']);

const INK = '#1a1a1a';
const FAINT = '#9a9a9a';
const BG = '#ffffff';

/** Escape the five XML entities so titles/labels can't break the SVG. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Wrap a step title onto up to 3 lines by whole words — a plain clone of
// SwimlaneCanvas.wrapTitle so the printed box reads the same as the screen.
const TITLE_CHARS_PER_LINE = 24;
const TITLE_MAX_LINES = 3;
function wrapTitle(title: string): string[] {
  const words = title.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= TITLE_CHARS_PER_LINE) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w.length > TITLE_CHARS_PER_LINE ? w.slice(0, TITLE_CHARS_PER_LINE - 1) + '…' : w;
    }
    if (lines.length === TITLE_MAX_LINES) break;
  }
  if (lines.length < TITLE_MAX_LINES && line) lines.push(line);
  const drawn = lines.join(' ').replace(/…$/, '').split(/\s+/).length;
  if (drawn < words.length && lines.length > 0 && !lines[lines.length - 1].endsWith('…')) {
    lines[lines.length - 1] = lines[lines.length - 1] + '…';
  }
  return lines.length ? lines : [''];
}

/**
 * Render the workflow swimlane as a standalone SVG string. `gapFor` reports how
 * many of a step's links point at a missing entity (same injection the canvas
 * uses) so the printed box can carry the ⚠ gap marker. Returns the markup plus
 * the intrinsic width/height so the caller can rasterise at a chosen scale.
 */
export function renderSwimlaneSvg(
  workflow: Workflow,
  opts: { gapFor?: (step: WorkflowStep) => number } = {},
): { svg: string; width: number; height: number } {
  const layout = layoutSwimlanes(workflow, { gapFor: opts.gapFor });
  const W = Math.max(layout.width, 320);
  const H = Math.max(layout.height, 120);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
  );
  parts.push(
    '<defs><marker id="swim-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      `<path d="M0,0 L10,5 L0,10 z" fill="${FAINT}"/></marker></defs>`,
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`);

  // Lane backgrounds + labels — external lanes get a dashed outline + caption.
  for (const lane of layout.lanes) {
    const fill = ACTOR_FILL[lane.actor] ?? ACTOR_FILL.Agent;
    const ext = EXTERNAL.has(lane.actor);
    parts.push(
      `<rect x="${lane.x + 4}" y="4" width="${lane.width - 8}" height="${H - 8}" rx="8" ` +
        `fill="${fill}" fill-opacity="${ext ? 0.035 : 0.05}" stroke="${fill}" ` +
        `stroke-opacity="${ext ? 0.45 : 0.18}"${ext ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
    const cx = lane.x + lane.width / 2;
    parts.push(
      `<text x="${cx}" y="22" text-anchor="middle" font-size="10" font-weight="600" ` +
        `letter-spacing="1.2" fill="${fill}" fill-opacity="0.85">${esc(lane.actor.toUpperCase())}</text>`,
    );
    if (ext) {
      parts.push(
        `<text x="${cx}" y="33" text-anchor="middle" font-size="8" font-weight="600" ` +
          `letter-spacing="0.8" fill="${fill}" fill-opacity="0.7">EXTERNAL</text>`,
      );
    }
  }

  // Sequential connectors.
  for (const e of layout.edges) {
    parts.push(
      `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${FAINT}" ` +
        'stroke-width="1.5" opacity="0.6" marker-end="url(#swim-arrow)"/>',
    );
  }

  // Step blocks.
  for (const b of layout.blocks) {
    const fill = ACTOR_FILL[b.actor] ?? ACTOR_FILL.Agent;
    const titleLines = wrapTitle(b.title);
    const TITLE_TOP = 20;
    const TITLE_LINE_H = 16;
    const actorY = TITLE_TOP + titleLines.length * TITLE_LINE_H + 2;
    const metaY = actorY + 18;
    const actorLine = b.actorName ? `${b.actor}: ${b.actorName}` : b.actor;
    const actorDisplay = actorLine.length > 26 ? `${actorLine.slice(0, 26)}…` : actorLine;
    const meta =
      (b.inputs > 0 ? `${b.inputs}in ` : '') +
      (b.outputs > 0 ? `${b.outputs}out ` : '') +
      (b.links > 0 ? `· ${b.links} link${b.links === 1 ? '' : 's'}` : '');

    parts.push(`<g transform="translate(${b.x},${b.y})">`);
    parts.push(`<rect width="${b.w}" height="${b.h}" rx="9" fill="${BG}" stroke="${fill}" stroke-width="1.4"/>`);
    parts.push(`<rect x="0" y="0" width="4" height="${b.h}" rx="2" fill="${fill}"/>`);
    const tspans = titleLines
      .map((ln, i) => `<tspan x="14" dy="${i === 0 ? 0 : TITLE_LINE_H}">${esc(ln)}</tspan>`)
      .join('');
    parts.push(`<text x="14" y="${TITLE_TOP}" font-size="13" font-weight="600" fill="${INK}">${tspans}</text>`);
    parts.push(`<text x="14" y="${actorY}" font-size="11" font-weight="500" fill="${fill}">${esc(actorDisplay)}</text>`);
    if (meta) parts.push(`<text x="14" y="${metaY}" font-size="10.5" fill="${FAINT}">${esc(meta)}</text>`);
    if (b.hasHardRule) parts.push(`<text x="${b.w - 12}" y="${TITLE_TOP}" text-anchor="end" font-size="11">🔒</text>`);
    if (b.hasTacit) parts.push(`<text x="${b.w - 12}" y="${actorY}" text-anchor="end" font-size="11">✎</text>`);
    if (b.gaps > 0)
      parts.push(
        `<text x="${b.w - 12}" y="${metaY}" text-anchor="end" font-size="11" font-weight="600" fill="#c0392b">⚠ ${b.gaps}</text>`,
      );
    parts.push('</g>');
  }

  parts.push('</svg>');
  return { svg: parts.join(''), width: W, height: H };
}
