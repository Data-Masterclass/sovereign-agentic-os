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
import { log, listTree, readBlob, archive, repoExists, listRepos, type LogEntry, type TreeEntry, type GitStoreOptions } from '@core/infra/git-store';

export type ProjectReader = { id: string; domains: string[] };

export type ProjectIndexEntry = {
  name: string;
  head: string | null;
  /** The principals the repo's `os/schedules.yml` names, with the OS's view of their activity. */
  principals: { id: string; active: boolean }[];
};

/** The `principal:` values of a generated `os/schedules.yml` (a flat list the OS itself emits). */
export function schedulePrincipals(schedulesYml: string): string[] {
  const out = new Set<string>();
  for (const m of schedulesYml.matchAll(/^\s+principal:\s*("?)([^"\n]+)\1\s*$/gm)) out.add(m[2].trim());
  return [...out].sort();
}

/**
 * The repo index the Dagster `repo-sync` sidecar and the `os_principals` sensor poll
 * (engine rebuild B2, closes deviation B1-8): every domain repository, its `main` head and the
 * schedule principals with their activity (resolved through `isActive`; unknown ⇒ inactive, so a
 * deleted owner's schedule is paused rather than run). `domains` narrows the list for a signed-in
 * caller; the cluster-internal caller sees all.
 */
export async function projectIndex(
  isActive: (principalId: string) => Promise<boolean>,
  opts: GitStoreOptions & { domains?: string[] } = {},
): Promise<{ domains: ProjectIndexEntry[] }> {
  const repos = await listRepos(opts);
  const out: ProjectIndexEntry[] = [];
  for (const r of repos) {
    if (opts.domains && !opts.domains.includes(r.name)) continue;
    let principals: { id: string; active: boolean }[] = [];
    if (r.head) {
      let yml = '';
      try {
        yml = await readBlob(r.name, r.head, 'os/schedules.yml', opts);
      } catch {
        yml = ''; // no schedules in this repo
      }
      principals = await Promise.all(schedulePrincipals(yml).map(async (id) => ({ id, active: await isActive(id).catch(() => false) })));
    }
    out.push({ name: r.name, head: r.head, principals });
  }
  return { domains: out };
}

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
