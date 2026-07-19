/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ScaffoldFile } from './model.ts';

/**
 * The Build-stage CHANGESET — the per-run before/after file diff surfaced inline
 * in the Software Build stage (Lovable-style "what did the agent just change?").
 *
 * A Build run commits through `commitToApp`, which snapshots the whole tree per
 * app (`lib/software/snapshot.ts`). We diff the snapshot taken BEFORE the run
 * against the one AFTER it to show exactly which files were added or edited (and,
 * defensively, removed) — never prose, the real committed content.
 *
 * PURE + side-effect-free so it runs under the repo's `node --test` runner.
 */

export type FileChangeKind = 'added' | 'modified' | 'removed';

export type FileChange = {
  path: string;
  kind: FileChangeKind;
  /** File content before the run ('' for an added file). */
  before: string;
  /** File content after the run ('' for a removed file). */
  after: string;
};

function treeMap(files: ScaffoldFile[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files ?? []) if (f && typeof f.path === 'string') m.set(f.path, f.content ?? '');
  return m;
}

/**
 * Diff two committed trees into the set of files that actually changed. Unchanged
 * files are omitted. Sorted by path for a stable, legible render.
 */
export function diffTrees(
  before: ScaffoldFile[] | null | undefined,
  after: ScaffoldFile[] | null | undefined,
): FileChange[] {
  const a = treeMap(before);
  const b = treeMap(after);
  const changes: FileChange[] = [];

  for (const [path, afterContent] of b) {
    if (!a.has(path)) {
      changes.push({ path, kind: 'added', before: '', after: afterContent });
    } else if (a.get(path) !== afterContent) {
      changes.push({ path, kind: 'modified', before: a.get(path) ?? '', after: afterContent });
    }
  }
  for (const [path, beforeContent] of a) {
    if (!b.has(path)) changes.push({ path, kind: 'removed', before: beforeContent, after: '' });
  }

  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/** A one-line human summary of a changeset (e.g. "3 files changed: 2 added, 1 modified"). */
export function summarizeChanges(changes: FileChange[]): string {
  if (changes.length === 0) return 'No files changed.';
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const c of changes) counts[c.kind]++;
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  const n = changes.length;
  return `${n} file${n === 1 ? '' : 's'} changed: ${parts.join(', ')}`;
}
