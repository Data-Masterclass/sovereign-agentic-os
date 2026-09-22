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

/**
 * Title-case a story-folder name into a readable nav label. Handles kebab/snake
 * (`live-dossier` → `Live Dossier`), camelCase/PascalCase
 * (`AssignNewCaseToServiceCenter` → `Assign New Case To Service Center`), and
 * de-shouts a long ALL-CAPS run with no word boundaries
 * (`ASSIGNNEWCASE` → `Assigncase`) so a tab never SHOUTS. Short acronyms (≤3, e.g.
 * `KPI`, `API`) are left intact.
 */
function humanize(slug: string): string {
  const spaced = slug
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary
    .replace(/\s+/g, ' ')
    .trim();
  const deShouted = spaced
    .split(' ')
    .map((w) => (/^[A-Z]{4,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(' ');
  return deShouted.replace(/\b\w/g, (c) => c.toUpperCase()) || slug;
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
 * Off-pattern `.tsx` files under `src/epics/` that LOOK like an intended page but will
 * NOT be auto-registered, so the build "compiles but the feature never shows". The
 * generator (`discoverPages`) only wires files at EXACTLY
 * `src/epics/<epic>/<story>/<PascalCase>.tsx` (depth 4, one per folder, `general/`
 * excluded). This flags the near-misses so the silent drop becomes a visible hint:
 *   • lowercase-first filename (e.g. `index.tsx`)  → rename to PascalCase
 *   • wrong depth (too shallow / too deep)         → move to <epic>/<story>/<Page>.tsx
 *   • a 2nd PascalCase page in a story folder       → only the first registers
 * PURE + side-effect free. Returns [] when nothing is off-pattern (the common case).
 */
export function unregisteredPageHints(files: ScaffoldFile[]): string[] {
  const okRe = /^src\/epics\/([^/]+)\/([^/]+)\/([A-Z][A-Za-z0-9]*)\.tsx$/;
  const hints: string[] = [];
  const registeredFolders = new Set<string>();
  // First pass: the folders that DO get a registered page (the first PascalCase file).
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const m = okRe.exec(f.path);
    if (m && m[2] !== 'general') registeredFolders.add(`${m[1]}/${m[2]}`);
  }
  const secondSeen = new Set<string>();
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const p = f.path;
    if (!p.startsWith('src/epics/') || !p.endsWith('.tsx')) continue;
    const rel = p.slice('src/epics/'.length);
    const parts = rel.split('/');
    // Skip epic-wide shared code — general/ is intentionally not a page.
    if (parts.includes('general')) continue;
    const m = okRe.exec(p);
    if (m) {
      // A valid page: only the FIRST per folder registers; a 2nd+ is a silent drop.
      const folder = `${m[1]}/${m[2]}`;
      if (secondSeen.has(folder)) {
        hints.push(`${p} won't register — a story folder gets ONE page; only the first PascalCase page in ${folder} is wired.`);
      } else {
        secondSeen.add(folder);
      }
      continue;
    }
    // Not the canonical shape — say why (only for plausible pages, depth ≥ 2).
    const fileName = parts[parts.length - 1];
    if (parts.length !== 3) {
      hints.push(`${p} won't register — a page must be at EXACTLY src/epics/<epic>/<story>/<PascalCase>.tsx (depth 4).`);
    } else if (!/^[A-Z]/.test(fileName)) {
      hints.push(`${p} won't register — the page filename must start UPPERCASE (PascalCase), e.g. ${parts[0]}/${parts[1]}/Page.tsx.`);
    }
  }
  return hints;
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
