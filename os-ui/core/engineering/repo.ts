/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    Reading the REAL bytes out of the domain repository for the engineering sections
 * USER STORY: As an engineer I want the YAML and the SQL on the "Under the hood" panel to be the
 *             bytes that are committed in the repository — not a re-render of the generator — so
 *             that what I read here is what `git show` would print (checklist T3).
 * ARCHITECTURE:
 *   - The one read helper the five adapters share, over `core/infra/git-store.ts`. Read-only: no
 *     commit, no reconcile, so the `hydrationState()` rule for writers does not apply.
 *   - A missing repository is a FACT with a reason, never an exception that empties a panel: every
 *     function returns `{ files, head, reason }` and the adapters put `reason` on the section.
 *   - Nothing here filters by identity: the caller has already passed its tab's own visibility
 *     gate, and a domain member may read the whole repository by design (plan E-R1.8).
 */
import { listTree, readBlob, log, repoExists } from '@core/infra/git-store';

/** One file, as committed. */
export type ReadFile = { path: string; content: string };

/** What a repository read produced, and why it produced nothing when it did. */
export type RepoRead = {
  /** The repository (= the domain) the files came from. */
  repo: string;
  head: string | null;
  files: ReadFile[];
  /** Paths that matched but could not be read, each with its reason. */
  unreadable: { path: string; reason: string }[];
  /** Why there is nothing — null when there is. */
  reason: string | null;
};

const empty = (repo: string, reason: string): RepoRead => ({ repo, head: null, files: [], unreadable: [], reason });

/** Every tracked path at `main`, or a reason. Cheap: one tree walk, no blobs. */
export async function repoPaths(repo: string): Promise<{ repo: string; head: string | null; paths: string[]; reason: string | null }> {
  if (!repo) return { repo, head: null, paths: [], reason: 'this object has no domain repository' };
  if (!repoExists(repo)) {
    return { repo, head: null, paths: [], reason: `no git repository for '${repo}' yet (nothing has been committed, or the git store is disabled in this deployment)` };
  }
  const entries = await log(repo, { limit: 1 });
  const tree = await listTree(repo, 'main');
  return { repo, head: entries[0]?.sha ?? null, paths: tree.map((t) => t.path), reason: tree.length === 0 ? `the git repository '${repo}' has no files on \`main\` yet` : null };
}

/**
 * The bytes of every tracked path the matcher selects, newest-committed head included.
 * `limit` bounds how many blobs are read, so a panel can never pull a whole project into memory.
 */
export async function readRepoFiles(
  repo: string,
  matches: (path: string) => boolean,
  limit = 12,
): Promise<RepoRead> {
  const listed = await repoPaths(repo);
  if (listed.reason && listed.paths.length === 0) return empty(repo, listed.reason);
  const wanted = listed.paths.filter(matches).sort();
  if (wanted.length === 0) {
    return { repo, head: listed.head, files: [], unreadable: [], reason: `no matching file is committed in '${repo}' yet` };
  }
  const files: ReadFile[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  for (const path of wanted.slice(0, limit)) {
    try {
      files.push({ path, content: await readBlob(repo, 'main', path) });
    } catch (e) {
      unreadable.push({ path, reason: (e as Error).message });
    }
  }
  return {
    repo,
    head: listed.head,
    files,
    unreadable,
    reason: files.length === 0 ? `every matching file in '${repo}' failed to read (${unreadable.map((u) => u.reason).join('; ')})` : null,
  };
}
