/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ScaffoldFile } from './model.ts';

/**
 * AUTO-REGISTER epic story pages into the sovereign-app section registry.
 *
 * A `sovereign-app`'s UI is driven by `src/template/sections.tsx` (the `SECTIONS`
 * array the shell renders as nav + routing). Historically the build agent had to
 * hand-EDIT that central file for every story — and did so unreliably, so a story
 * whose page was written but never registered was invisible ("builds fine, no
 * feature shows"). This module makes registration DETERMINISTIC: it regenerates
 * `sections.tsx` from the committed page files, so any page under
 * `src/epics/<epic>/<story>/<Name>.tsx` is wired in automatically.
 *
 * PURE + side-effect free (runs under `node --test`). `ensureSectionsRegistered`
 * is the commit-path hook; `generateSectionsContent` is the pure generator.
 */

const SECTIONS_PATH = 'src/template/sections.tsx';
const SHELL_PATH = 'src/template/shell.tsx';

/** A story page discovered in the tree: its epic, story, component file + alias. */
type PageEntry = { epic: string; story: string; file: string; comp: string };

// A small rotating icon set so sections are visually distinct (Overview keeps ◇).
const ICONS = ['▤', '⚡', '◈', '▦', '◧', '❖', '⬢', '✦', '◑', '▣'];

/** Title-case a kebab/snake folder name: `live-dossier` → `Live Dossier`. */
function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || slug;
}

/**
 * The story pages in a tree: exactly `src/epics/<epic>/<story>/<PascalCase>.tsx`
 * (depth 4), excluding the epic-wide `general/` folder and non-page files. One
 * page per story folder (the first PascalCase file, path-sorted) — deterministic.
 */
export function discoverPages(files: ScaffoldFile[]): PageEntry[] {
  const re = /^src\/epics\/([^/]+)\/([^/]+)\/([A-Z][A-Za-z0-9]*)\.tsx$/;
  const byFolder = new Map<string, PageEntry>();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const m = re.exec(f.path);
    if (!m) continue;
    const [, epic, story, comp] = m;
    if (story === 'general') continue; // epic-wide shared code, not a page
    const key = `${epic}/${story}`;
    if (!byFolder.has(key)) byFolder.set(key, { epic, story, file: f.path, comp });
  }
  return [...byFolder.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The desired `sections.tsx` content for a sovereign-app tree, or null when it
 * does not apply (not a sovereign-app, or no template sections file present).
 * When there are no epic pages yet, the scaffold's Overview + Workspace default is
 * kept (returns null → caller leaves the file untouched).
 */
export function generateSectionsContent(files: ScaffoldFile[]): string | null {
  const paths = new Set(files.map((f) => f.path));
  // Only a sovereign-app has this template shell + registry shape.
  if (!paths.has(SECTIONS_PATH) || !paths.has(SHELL_PATH)) return null;

  const pages = discoverPages(files);
  if (pages.length === 0) return null; // nothing built yet — keep the scaffold default

  const seenIds = new Set<string>(['overview', 'admin']);
  const uniqueId = (base: string): string => {
    let id = base || 'section';
    let n = 2;
    while (seenIds.has(id)) id = `${base}-${n++}`;
    seenIds.add(id);
    return id;
  };

  const imports: string[] = ["import Overview from './pages/Overview.tsx';"];
  const entries: string[] = ["  { id: 'overview', label: 'Overview', icon: '◇', page: Overview },"];
  pages.forEach((p, i) => {
    const alias = `S${i}`;
    // Import path is relative to src/template/ → epics live at ../epics/…
    imports.push(`import ${alias} from '../${p.file.replace(/^src\//, '')}';`);
    const id = uniqueId(p.story);
    const label = humanize(p.story);
    const icon = ICONS[i % ICONS.length];
    entries.push(`  { id: '${id}', label: ${JSON.stringify(label)}, icon: '${icon}', page: ${alias} },`);
  });

  return [
    "import type { ComponentType } from 'react';",
    ...imports,
    '',
    '/**',
    ' * The app’s left-nav SECTIONS — the single registry the shell reads for nav + routing.',
    ' * AUTO-GENERATED on every commit from the story pages under src/epics/<epic>/<story>/.',
    ' * Do NOT hand-edit: just add a page component under a story folder and it is registered',
    ' * here automatically. The Admin section is appended for OS domain admins in shell.tsx.',
    ' */',
    '',
    'export type AppSection = {',
    '  id: string;',
    '  label: string;',
    '  /** Small leading glyph shown in the sidebar. */',
    '  icon: string;',
    '  page: ComponentType;',
    '};',
    '',
    'export const SECTIONS: AppSection[] = [',
    ...entries,
    '];',
    '',
  ].join('\n');
}

/**
 * Commit-path hook: given the prior tree, the incoming changeset, and the app
 * template, return the changeset — augmented with a regenerated `sections.tsx`
 * when (a) it's a sovereign-app, (b) epic pages exist, and (c) the generated
 * content differs from what's already in the merged tree. Otherwise the changeset
 * is returned unchanged. Never throws — a generation slip just leaves the commit
 * as-is (fail-open, never blocks a commit).
 */
export function ensureSectionsRegistered(
  prior: ScaffoldFile[],
  changeset: ScaffoldFile[],
  template: string,
): ScaffoldFile[] {
  if (template !== 'sovereign-app') return changeset;
  try {
    // Merge prior + changeset (changeset wins) to see the whole tree.
    const merged = new Map<string, string>();
    for (const f of prior) merged.set(f.path, f.content);
    for (const f of changeset) merged.set(f.path, f.content);
    const mergedFiles = [...merged].map(([path, content]) => ({ path, content }));

    const desired = generateSectionsContent(mergedFiles);
    if (desired == null) return changeset;
    if (merged.get(SECTIONS_PATH) === desired) return changeset; // already correct

    // Replace/append the generated sections.tsx in the changeset.
    const out = changeset.filter((f) => f.path !== SECTIONS_PATH);
    out.push({ path: SECTIONS_PATH, content: desired });
    return out;
  } catch {
    return changeset; // fail-open — never block a commit on registry generation
  }
}
