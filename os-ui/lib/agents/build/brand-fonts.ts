/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { jsPDF } from 'jspdf';
import { MARCELLUS, RUBIK_REGULAR, RUBIK_SEMIBOLD, OSWALD_MEDIUM, FRAUNCES } from './brand-fonts-data.ts';

/**
 * Register the datamasterclass brand faces into a jsPDF document so the Agents
 * Run/Evaluate PDFs read like the printed guides (docs/assets/guide.css) rather
 * than default Helvetica. jsPDF needs a TTF via addFileToVFS + addFont; the base64
 * payloads are static single-weight instances of the repo's woff2 subsets
 * (Marcellus 400 · Rubik 400/600 · Oswald 500 · Fraunces 600).
 *
 * Registered font families (use with doc.setFont(family, style)):
 *   'Marcellus' normal  — section headings (serif)
 *   'Rubik'     normal  — body / tables
 *   'Rubik'     bold    — emphasis (a genuine 600 face, not synthesised)
 *   'Oswald'    normal  — condensed uppercase eyebrows / labels
 *   'Fraunces'  normal  — cover display title
 *
 * Idempotent per-doc, and fail-soft: if embedding throws for any reason the
 * caller falls back to core fonts (the FALLBACK map) and the palette/layout/logo
 * still carry the brand.
 */

export const BRAND = {
  ink: [34, 29, 23] as [number, number, number], // #221D17 warm near-black body
  inkStrong: [20, 17, 12] as [number, number, number], // #14110C headings
  muted: [111, 101, 90] as [number, number, number], // #6F655A secondary
  gold: [200, 162, 74] as [number, number, number], // #C8A24A rules / accents
  goldText: [138, 101, 22] as [number, number, number], // #8A6516 accent text
  goldDeep: [160, 122, 44] as [number, number, number], // #A07A2C
  hair: [233, 226, 213] as [number, number, number], // #E9E2D5 hairline
  zebra: [251, 249, 244] as [number, number, number], // #FBF9F4 table zebra
  soft: [250, 245, 233] as [number, number, number], // #FAF5E9 callout wash
  coverBg: [12, 11, 13] as [number, number, number], // #0C0B0D near-black cover
  coverFg: [243, 236, 221] as [number, number, number], // #F3ECDD cream on cover
  coverMut: [182, 170, 146] as [number, number, number], // #B6AA92
  coverGold: [231, 205, 134] as [number, number, number], // #E7CD86
  green: [42, 110, 78] as [number, number, number],
  red: [150, 52, 44] as [number, number, number],
};

/** Font family names as registered; `Fonts.serif` etc. keep call-sites readable. */
export const Fonts = {
  serif: 'Marcellus', // headings
  body: 'Rubik', // body + tables
  cond: 'Oswald', // eyebrows / labels
  display: 'Fraunces', // cover title
} as const;

/** Core-font fallback (used only if TTF embedding fails) so text still renders. */
export const Fallback = {
  serif: 'times',
  body: 'helvetica',
  cond: 'helvetica',
  display: 'times',
} as const;

let warned = false;

/**
 * Embed + register the brand faces. Returns true when the real fonts are active,
 * false when it fell back to core fonts (the painter then uses `Fallback`).
 */
export function registerBrandFonts(doc: jsPDF): boolean {
  try {
    const add = (file: string, b64: string, family: string, style: string) => {
      doc.addFileToVFS(file, b64);
      doc.addFont(file, family, style);
    };
    add('Marcellus.ttf', MARCELLUS, Fonts.serif, 'normal');
    add('Rubik-Regular.ttf', RUBIK_REGULAR, Fonts.body, 'normal');
    add('Rubik-SemiBold.ttf', RUBIK_SEMIBOLD, Fonts.body, 'bold');
    add('Oswald-Medium.ttf', OSWALD_MEDIUM, Fonts.cond, 'normal');
    add('Fraunces-SemiBold.ttf', FRAUNCES, Fonts.display, 'normal');
    // Prove the registration took — throws/returns nothing if a family is missing.
    doc.setFont(Fonts.serif, 'normal');
    doc.setFont(Fonts.body, 'bold');
    return true;
  } catch (err) {
    if (!warned && typeof console !== 'undefined') {
      warned = true;
      console.warn('[agent-pdf] brand fonts could not embed; using core fonts', err);
    }
    return false;
  }
}
