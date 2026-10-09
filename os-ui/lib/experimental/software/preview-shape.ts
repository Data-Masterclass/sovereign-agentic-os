/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * PREVIEW SHAPE detection for the in-browser Instant Preview (pure, unit-tested).
 *
 * The esbuild-wasm instant preview can only bundle Vite-style SPAs (an
 * `src/main.tsx`-family entry over React + the vendored OS SDK/UI). Apps from
 * the legacy Next.js scaffold (`app/layout.tsx` + `app/page.tsx`, next/*
 * imports, a server build) can NOT be bundled honestly in the browser — so
 * instead of an opaque "No SPA entry point found" error, the preview detects
 * the app's actual shape and explains itself.
 */

export type PreviewShape =
  | { kind: 'vite'; entry: string }
  | { kind: 'nextjs' }
  | { kind: 'unknown' };

/** The SPA entry candidates, in boot order (matches the vite-os scaffold). */
export const VITE_ENTRY_CANDIDATES = ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts'] as const;

/** Normalise a path to no leading slash for comparison. */
function norm(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Detect the app's preview shape from its file paths:
 *   • vite    — a known SPA entry exists (returns which one).
 *   • nextjs  — no SPA entry, but the Next.js scaffold layout is present
 *               (`app/layout.tsx` / `app/page.tsx` / a `pages/` router).
 *   • unknown — neither; the caller reports what it expected, honestly.
 */
export function detectPreviewShape(paths: string[]): PreviewShape {
  const set = new Set(paths.map(norm));
  for (const c of VITE_ENTRY_CANDIDATES) {
    if (set.has(c)) return { kind: 'vite', entry: `/${c}` };
  }
  const nextish = ['app/layout.tsx', 'app/page.tsx', 'app/layout.jsx', 'app/page.jsx'];
  if (nextish.some((p) => set.has(p)) || [...set].some((p) => p.startsWith('pages/'))) {
    return { kind: 'nextjs' };
  }
  return { kind: 'unknown' };
}

/** The honest, human explanation for a shape the instant preview cannot bundle. */
export function unsupportedShapeMessage(shape: PreviewShape): string | null {
  if (shape.kind === 'vite') return null;
  if (shape.kind === 'nextjs') {
    return (
      'Instant preview supports Vite-style apps (src/main.tsx). This app uses the legacy ' +
      'Next.js scaffold (app/layout.tsx + app/page.tsx), which needs a server build — ' +
      'use the deployed preview instead.'
    );
  }
  return (
    'Instant preview supports Vite-style apps and expects an entry at src/main.tsx ' +
    '(or src/index.tsx). No such entry exists in this app’s files — use the deployed preview instead.'
  );
}
