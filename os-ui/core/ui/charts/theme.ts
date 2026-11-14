/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS chart theme bridge — one palette, resolved from the live CSS custom properties
 * USER STORY: As a user I want every chart in the OS to use the same colours as the rest of the
 *             screen, in light and dark theme, so a dashboard never looks like a different product
 *             than the tab around it (D-R1.1).
 * ARCHITECTURE:
 *   - The OS themes itself with CSS custom properties (`--teal`, `--gold`, `--text`, `--border`,
 *     `--panel`); ECharts needs concrete colours, not `var()`. This module is that bridge — kept
 *     deliberately instead of adopting Superset's CSS-template theming, which would mean a second
 *     theme system (plan D7).
 *   - {@link resolveChartColors} is PURE over an injected variable reader, so the palette is unit
 *     tested without a DOM. {@link chartColors} is the browser binding of it.
 *   - Fallbacks are the OS's own brand values, so a chart drawn before the stylesheet applies (or
 *     in a non-DOM context) is calm rather than black-on-black.
 */

/** The themed colours every OS chart draws with. */
export type ChartColors = {
  /** Primary series colour. */
  teal: string;
  /** Second series colour. */
  gold: string;
  /** Axis + label text. */
  ink: string;
  /** Grid + axis lines. */
  line: string;
  /** The surface a chart sits on (pie slice borders). */
  panel: string;
  /** The full categorical series palette, primary first. */
  palette: string[];
};

/** The shape of a CSS-variable map: one `[name, fallback]` pair per themed colour. */
export type ChartCssVars = Record<keyof typeof CHART_CSS_VARS, readonly [string, string]>;

/** The CSS custom properties the bridge reads, with the OS's own brand fallbacks. */
export const CHART_CSS_VARS = {
  teal: ['--teal', '#1f8f88'],
  gold: ['--gold', '#c8a24a'],
  ink: ['--text', '#2b2b2b'],
  line: ['--border', 'rgba(0,0,0,0.08)'],
  panel: ['--panel', '#ffffff'],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * The SANDBOXED APP SHELL's variable names (M-4). A vibe-engineered app renders inside its own
 * shell, which namespaces its design tokens `--sb-*` so an app can never read or be affected by the
 * OS chrome's variables. Same resolver, same palette ORDER, same fallbacks — different names. That
 * is the honest unification: one palette, two namespaces, rather than two palettes.
 */
export const APP_SHELL_CSS_VARS = {
  teal: ['--sb-teal', '#1f8f88'],
  gold: ['--sb-gold', '#c8a24a'],
  ink: ['--sb-text', '#2b2b2b'],
  line: ['--sb-border', 'rgba(0,0,0,0.08)'],
  panel: ['--sb-panel', '#ffffff'],
} as const satisfies ChartCssVars;

/** Series 3..n — fixed, so a five-series chart is the same five colours everywhere. */
export const CHART_EXTRA_PALETTE = ['#7c6cc4', '#c46c8a', '#6ca3c4'] as const;

/** Reads a CSS custom property by name; returns `undefined`/'' when it is not set. */
export type CssVarReader = (name: string) => string | undefined;

/**
 * The OS palette, resolved through `read`. Pure: the same reader always yields the same colours,
 * and an empty/absent value falls back to the brand default rather than to nothing.
 */
export function resolveChartColors(read: CssVarReader, vars: ChartCssVars = CHART_CSS_VARS): ChartColors {
  const pick = (key: keyof typeof CHART_CSS_VARS): string => {
    const [name, fallback] = vars[key];
    const v = (read(name) ?? '').trim();
    return v || fallback;
  };
  const teal = pick('teal');
  const gold = pick('gold');
  return {
    teal,
    gold,
    ink: pick('ink'),
    line: pick('line'),
    panel: pick('panel'),
    palette: [teal, gold, ...CHART_EXTRA_PALETTE],
  };
}

/** Read one themed CSS custom property from the live document (browser only). */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * The live OS palette. Call inside a `useMemo` — it reads computed style. Pass
 * {@link APP_SHELL_CSS_VARS} from inside a sandboxed app shell, which namespaces its tokens.
 */
export function chartColors(vars: ChartCssVars = CHART_CSS_VARS): ChartColors {
  return resolveChartColors(
    (name) => (typeof window === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name)),
    vars,
  );
}
