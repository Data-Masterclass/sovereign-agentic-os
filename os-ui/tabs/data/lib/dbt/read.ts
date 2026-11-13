/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Read access to a domain's data-project repository (tree, log, blob, tar export)
 * USER STORY: As a domain member I want to browse my domain's generated dbt project, read any file
 *             at any commit and download the project at a commit — and nobody outside the domain
 *             can (concept §2.5).
 * ARCHITECTURE:
 *   - Thin, server-only logic the three `/api/data/projects/<domain>` routes call: domain
 *     membership is the gate (the same `user.domains` scope every list applies); errors carry
 *     an HTTP status via `DatasetError`.
 *   - Reads go straight to the git store; no cache, no OS ledger — git is the record.
 */
import 'server-only';
import { DatasetError } from '@tabs/data/lib/dataset-schema';
import { log, listTree, readBlob, archive, repoExists, type LogEntry, type TreeEntry, type GitStoreOptions } from '@core/infra/git-store';

export type ProjectReader = { id: string; domains: string[] };

export type ProjectView = {
  domain: string;
  head: string | null;
  tree: TreeEntry[];
  log: LogEntry[];
};

function requireMember(domain: string, user: ProjectReader): void {
  if (!user.domains.includes(domain)) throw new DatasetError(`Not a member of domain '${domain}'`, 403);
}

function requireRepo(domain: string, opts: GitStoreOptions): void {
  if (!repoExists(domain, opts)) {
    throw new DatasetError(`No data project repository for '${domain}' yet (DATA_PROJECT_GIT off, or nothing committed)`, 404);
  }
}

/** Tree at `main` + the newest commits. */
export async function readProject(domain: string, user: ProjectReader, opts: GitStoreOptions & { limit?: number } = {}): Promise<ProjectView> {
  requireMember(domain, user);
  requireRepo(domain, opts);
  const entries = await log(domain, { reposDir: opts.reposDir, limit: opts.limit ?? 50 });
  const tree = await listTree(domain, 'main', opts);
  return { domain, head: entries[0]?.sha ?? null, tree, log: entries };
}

/** One file at a ref. */
export async function readProjectBlob(domain: string, user: ProjectReader, ref: string | undefined, path: string, opts: GitStoreOptions = {}): Promise<{ domain: string; ref: string; path: string; content: string }> {
  requireMember(domain, user);
  requireRepo(domain, opts);
  if (!path) throw new DatasetError('path is required', 400);
  const content = await readBlob(domain, ref, path, opts);
  return { domain, ref: ref ?? 'main', path, content };
}

/** The project at a ref as a tar. */
export async function exportProject(domain: string, user: ProjectReader, ref: string | undefined, opts: GitStoreOptions = {}): Promise<{ filename: string; sha: string; tar: Buffer }> {
  requireMember(domain, user);
  requireRepo(domain, opts);
  const { sha, tar } = await archive(domain, ref, opts);
  return { filename: `${domain}-${sha.slice(0, 7)}.tar`, sha, tar };
}
