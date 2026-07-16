/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { layoutSystem, type Block, type LaidEdge } from '../canvas-layout.ts';
import type { System } from '../system-schema.ts';

/**
 * Pure `System → standalone SVG string` render of the multi-agent graph — the SAME
 * `layoutSystem` the on-screen canvas grid uses, emitted as a self-contained SVG
 * document (concrete hex colours, no CSS vars, no React Flow runtime). This is what
 * the Evaluate-PDF button rasterises to a PNG for its first page, so the printed
 * graph matches the builder's node/edge structure.
 *
 * Mirror of `lib/knowledge/swimlane-svg.ts`: framework-free + deterministic so it is
 * trivially unit-testable; the component only does the SVG→PNG rasterisation (a
 * browser-only step) on top of this.
 */

// House palette — mirrors GraphCanvas' gold (supervise/entry) + teal (handoff).
const GOLD = '#c8a24a';
const TEAL = '#1f8f88';
const INK = '#1a1a1a';
const FAINT = '#9a9a9a';
const BG = '#ffffff';
const NODE_BG = '#ffffff';

/** Escape the five XML entities so ids/roles can't break the SVG. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Truncate a label to fit a node box (no wrapping — one clean line). */
function fit(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Render the system graph as a standalone SVG string. `labelOf` maps an agent id to
 * its display name (short name when set) so the printed graph reads like the Run view.
 * Returns the markup plus intrinsic width/height so the caller can rasterise at scale.
 */
export function renderSystemGraphSvg(
  system: System,
  opts: { labelOf?: (id: string) => string } = {},
): { svg: string; width: number; height: number } {
  const labelOf = opts.labelOf ?? ((id: string) => id);
  const layout = layoutSystem(system);
  const W = Math.max(layout.width, 320);
  const H = Math.max(layout.height, 140);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
  );
  parts.push(
    '<defs>' +
      '<marker id="gph-arrow-sup" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      `<path d="M0,0 L10,5 L0,10 z" fill="${GOLD}"/></marker>` +
      '<marker id="gph-arrow-ho" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      `<path d="M0,0 L10,5 L0,10 z" fill="${TEAL}"/></marker>` +
      '</defs>',
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`);

  // Edges first (under the nodes): supervise = gold solid, handoff = teal dashed.
  for (const e of layout.edges as LaidEdge[]) {
    const supervise = e.type === 'supervise';
    const stroke = supervise ? GOLD : TEAL;
    parts.push(
      `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${stroke}" ` +
        `stroke-width="1.6" opacity="0.85"${supervise ? '' : ' stroke-dasharray="6 4"'} ` +
        `marker-end="url(#${supervise ? 'gph-arrow-sup' : 'gph-arrow-ho'})"/>`,
    );
  }

  // Node blocks.
  for (const b of layout.blocks as Block[]) {
    const accent = b.entrypoint || b.supervisor ? GOLD : TEAL;
    const title = fit(labelOf(b.id), 20);
    const role = b.role ? fit(b.role, 26) : '';
    const meta = `${b.tools} tool${b.tools === 1 ? '' : 's'}${b.model ? ` · ${fit(b.model, 14)}` : ' · auto model'}`;

    parts.push(`<g transform="translate(${b.x},${b.y})">`);
    parts.push(
      `<rect width="${b.w}" height="${b.h}" rx="10" fill="${NODE_BG}" stroke="${accent}" ` +
        `stroke-width="${b.entrypoint ? 2 : 1.3}"/>`,
    );
    parts.push(`<rect x="0" y="0" width="4" height="${b.h}" rx="2" fill="${accent}"/>`);
    parts.push(`<text x="14" y="22" font-size="13" font-weight="600" fill="${INK}">${esc(title)}</text>`);
    if (b.entrypoint) {
      parts.push(
        `<text x="${b.w - 12}" y="20" text-anchor="end" font-size="8.5" font-weight="700" ` +
          `letter-spacing="0.8" fill="${GOLD}">START</text>`,
      );
    } else if (b.supervisor) {
      parts.push(
        `<text x="${b.w - 12}" y="20" text-anchor="end" font-size="8" font-weight="700" ` +
          `letter-spacing="0.6" fill="${GOLD}">SUPERVISOR</text>`,
      );
    }
    if (role) parts.push(`<text x="14" y="42" font-size="11" fill="${accent}">${esc(role)}</text>`);
    parts.push(`<text x="14" y="${b.h - 12}" font-size="10" fill="${FAINT}">${esc(meta)}</text>`);
    parts.push('</g>');
  }

  parts.push('</svg>');
  return { svg: parts.join(''), width: W, height: H };
}
