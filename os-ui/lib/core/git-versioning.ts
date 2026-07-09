/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { ForgejoClient } from '../agents/build/live.ts';

/**
 * GIT-backed version history — the reusable helper that turns a Forgejo repo's
 * COMMIT log into the same `{ version, at, author, summary }` shape the ONE
 * VersionHistory panel already reads, and RESTORES a prior build by re-committing
 * that commit's file contents onto HEAD as a NEW commit (never a destructive
 * reset). It is the git counterpart of lib/versioning.ts (snapshot log): every
 * artifact that lives in a Forgejo repo (agent systems today; software + data
 * next) can share this.
 *
 * Design contract kept identical to the snapshot log so no UI changes:
 *   • `version` is an INDEX into the newest-first commit list (0 = HEAD/current),
 *     matching the numeric `{ version }` the VersionHistory panel round-trips.
 *   • RESTORE is auditable + non-destructive: it reads the chosen commit's files
 *     and writes them back to HEAD, producing a fresh "restore of <sha>" commit.
 *
 * Injected ForgejoClient (no `server-only`/Next import) so it is unit-testable
 * against a fake; the API route is the server boundary that authenticates.
 */

/** The UI-facing version shape (mirrors ArtifactVersion's public slice). */
export type GitVersion = { version: number; at: string; author: string; summary: string };

/** The per-system Forgejo repo name (mirrors the Build write path: `os-<id>`). */
export function systemRepo(systemId: string): string {
  return `os-${systemId}`;
}

/**
 * The repo's commit history mapped to the VersionHistory shape, NEWEST first.
 * Returns `null` when the repo has no git history yet OR Forgejo is unreachable,
 * so the caller falls back to the snapshot log honestly rather than showing an
 * empty (fake) git history.
 */
export async function listGitVersions(
  forgejo: ForgejoClient,
  repo: string,
  opts: { limit?: number } = {},
): Promise<GitVersion[] | null> {
  const commits = await forgejo.listCommits(repo, { limit: opts.limit ?? 30 });
  if (!commits || commits.length === 0) return null;
  // Index = position in the newest-first list. 0 is HEAD (the "current" build);
  // the UI shows index 0 as current and offers Restore on the rest.
  return commits.map((c, i) => ({
    version: i,
    at: c.date,
    author: c.author,
    summary: firstLine(c.message) || c.sha.slice(0, 8),
  }));
}

/**
 * Resolve a UI `version` index back to its commit sha against the CURRENT history
 * (stateless: the route re-lists on restore). Returns null when the index is out
 * of range or there is no git history.
 */
export async function shaForVersion(
  forgejo: ForgejoClient,
  repo: string,
  version: number,
  opts: { limit?: number } = {},
): Promise<string | null> {
  const commits = await forgejo.listCommits(repo, { limit: opts.limit ?? 30 });
  if (!commits) return null;
  const c = commits[version];
  return c ? c.sha : null;
}

/**
 * Restore a prior build: read the chosen commit's whitelisted files and write them
 * back onto HEAD as a NEW commit ("restore of <sha>"). Non-destructive — the whole
 * history (including the state before this restore, which is still HEAD's parent)
 * is retained, so the restore is itself an auditable, reversible commit. Returns
 * the restored `manifest` file's content so the caller can reload the live record
 * from it.
 *
 * `manifestPath` is the repo file that MUST be present at the commit for a restore
 * to be meaningful — `system.yaml` for agent systems (the default), `app.yaml` for
 * Software apps, etc. Throws when the commit's files can't be read (unreachable
 * Forgejo / missing manifest) so the caller reports the failure instead of
 * clobbering HEAD.
 */
export async function restoreGitVersion(
  forgejo: ForgejoClient,
  repo: string,
  sha: string,
  author: string,
  opts: { manifestPath?: string } = {},
): Promise<{ yaml: string; sha: string }> {
  const manifestPath = opts.manifestPath ?? 'system.yaml';
  const files = await forgejo.getCommitFiles(repo, sha);
  if (!files || typeof files[manifestPath] !== 'string') {
    throw new Error(`Could not read commit ${sha.slice(0, 8)} from ${repo} to restore.`);
  }
  const short = sha.slice(0, 8);
  const message = `restore of ${short} (by ${author})`;
  // Re-commit every file from the chosen commit onto HEAD. Each write reads the
  // current blob sha first so it's an UPDATE (not a create-race) — the same
  // POST-vs-PUT discipline the Build path uses.
  let lastSha = '';
  for (const [path, content] of Object.entries(files)) {
    const cur = await forgejo.readFile(repo, path);
    const res = await forgejo.writeFile(repo, path, content, cur?.sha, message);
    if (path === manifestPath) lastSha = res.sha;
  }
  return { yaml: files[manifestPath], sha: lastSha };
}

function firstLine(s: string): string {
  return (s.split('\n', 1)[0] ?? '').trim();
}
