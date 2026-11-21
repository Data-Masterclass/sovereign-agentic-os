/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The layout migration: every existing domain repo moves to the v2 layout in ONE commit
 *             (component design 12, rule 5)
 * USER STORY: As an operator I want each existing domain repository moved to the readable layout
 *             at deploy, behind a flag, idempotently and with a dry run first, so that file history
 *             follows every move (`git log --follow`), nothing is rewritten, and the old layout is
 *             back with one `git revert` of that commit per repo.
 * ARCHITECTURE:
 *   - `git mv` semantics without a working tree: the migration commit's tree reuses the SAME blob
 *     oids at the new paths and changes no content, so git's rename detection follows each file at
 *     100% similarity. Its only additions are the layout marker and the generated READMEs.
 *   - The commit is made by the OS (`Sovereign OS`) with the trailer `OS-Reason: layout-migration`,
 *     under the repo's ordinary lock. It is NOT a boot reconcile, so the destructive-delta guard
 *     (which judges generated catch-ups) is neither needed nor tripped; the next boot reconcile
 *     regenerates the SAME tree at the new paths and commits nothing.
 *   - The directory is renamed `<domain>.git` → `domain-<domain>.git` and the old name is left as a
 *     symlink ALIAS, so every reader of the old URL keeps working.
 *   - Personal agent lanes `agents/personal/<token>/**` leave the domain repo: their folder history
 *     is imported into the owner's `user-<token>` repo (`importFolderHistory`) and merged there,
 *     BEFORE the domain commit removes them. The token IS the user repo's token, so no id lookup.
 *   - IDEMPOTENT: a repo that already carries `os/layout.yml` is skipped; a repo already renamed is
 *     not renamed again. `dryRun` reads only and returns the plan.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { config } from '@core/kernel/config';
import {
  acquireRepoLock, appendTrailers, commitMessage, COMMITTER, commitSubtreeMerge, ensureLegacyAlias, ensureV2Repo,
  importFolderHistory, listAllRepos, listTree, MAIN, readFilesAt, repoPath, resolveRepo, type GitStoreOptions,
} from '@core/infra/git-store';
import { generatedReadmes } from '@core/infra/repo-readme';
import { notifyCommitted } from '@core/infra/git-backup';
import {
  AGENTS_DIR, LAYOUT_MARKER_PATH, LEGACY_PERSONAL_DIR, layoutMarker, layoutMigrationMoves, configuredDbtProjectDir,
  repoDirName, USER_REPO_PREFIX, prefixOf, type LayoutMove,
} from '@core/infra/repo-layout';

export const MIGRATION_REASON = 'layout-migration';

export type PersonalLane = { token: string; userRepo: string; files: string[] };

export type MigrationPlan = {
  domain: string;
  /** Current directory name and the canonical one. */
  from: string;
  to: string;
  rename: boolean;
  alreadyMigrated: boolean;
  moves: LayoutMove[];
  personal: PersonalLane[];
  readmes: string[];
};

export type MigrationResult = MigrationPlan & { sha: string | null; dryRun: boolean };

const LANE_RE = new RegExp(`^${AGENTS_DIR}/${LEGACY_PERSONAL_DIR}/([0-9a-f]{12})/(.+)$`);

/** The plan for one domain repo. Reads only. */
export async function planLayoutMigration(domain: string, opts: GitStoreOptions = {}): Promise<MigrationPlan> {
  const r = resolveRepo(domain, opts);
  const from = path.basename(r.dir);
  const to = repoDirName(r.canonical);
  const tree = (await listTree(domain, undefined, opts)).map((e) => e.path);
  const alreadyMigrated = tree.includes(LAYOUT_MARKER_PATH);
  const lanes = new Map<string, string[]>();
  for (const p of tree) {
    const m = LANE_RE.exec(p);
    if (m) lanes.set(m[1], [...(lanes.get(m[1]) ?? []), p]);
  }
  const kept = tree.filter((p) => !LANE_RE.test(p));
  const moves = alreadyMigrated ? [] : layoutMigrationMoves(kept);
  const moved = new Set(moves.map((m) => m.from));
  const after = [...kept.filter((p) => !moved.has(p)), ...moves.map((m) => m.to), LAYOUT_MARKER_PATH];
  return {
    domain,
    from,
    to,
    rename: from !== to,
    alreadyMigrated,
    moves,
    personal: alreadyMigrated ? [] : [...lanes.entries()].sort().map(([token, files]) => ({ token, userRepo: `${USER_REPO_PREFIX}${token}`, files })),
    readmes: alreadyMigrated ? [] : [...generatedReadmes(after, r.canonical).keys()],
  };
}

/** Migrate one domain repo (or, with `dryRun`, report what would happen). */
export async function migrateRepoLayout(domain: string, opts: GitStoreOptions & { dryRun?: boolean; timestamp?: number } = {}): Promise<MigrationResult> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const plan = await planLayoutMigration(domain, { reposDir });
  if (opts.dryRun) return { ...plan, sha: null, dryRun: true };
  const store = { reposDir };

  // 1. Personal lanes → the owners' user repos, history first, BEFORE the domain commit drops them.
  for (const lane of plan.personal) {
    await ensureV2Repo(lane.userRepo, store);
    const laneDir = `${AGENTS_DIR}/${LEGACY_PERSONAL_DIR}/${lane.token}/`;
    const { tip } = await importFolderHistory(domain, laneDir, lane.userRepo, prefixOf(AGENTS_DIR), store);
    if (!tip) continue;
    const existing = await readFilesAt(lane.userRepo, undefined, [prefixOf(AGENTS_DIR)], store).catch(() => ({ files: [] as { path: string; content: string }[] }));
    const files = new Map(existing.files.map((f) => [f.path, f.content]));
    const incoming = await readFilesAt(domain, undefined, [laneDir], store);
    for (const f of incoming.files) {
      let target = `${prefixOf(AGENTS_DIR)}${f.path.slice(laneDir.length)}`;
      // Another domain's personal system of the same owner already holds this folder.
      if (files.has(target) && files.get(target) !== f.content) target = `${prefixOf(AGENTS_DIR)}${plan.domain}-${f.path.slice(laneDir.length)}`;
      files.set(target, f.content);
    }
    await commitSubtreeMerge(lane.userRepo, prefixOf(AGENTS_DIR), files, {
      author: COMMITTER,
      message: commitMessage({ area: 'os', domain: lane.userRepo, action: `move personal agent systems from ${plan.domain}`, object: lane.userRepo, surface: 'os:boot', requestId: MIGRATION_REASON }),
      trailers: { 'OS-Reason': MIGRATION_REASON },
      mergeParent: tip,
      reposDir,
      ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    });
  }

  // 2. The domain repo: rename + alias, then ONE commit of pure moves.
  const release = await acquireRepoLock(domain, store);
  try {
    const base = reposDir;
    if (plan.rename && !fs.existsSync(path.join(base, plan.to))) {
      fs.renameSync(path.join(base, plan.from), path.join(base, plan.to));
      ensureLegacyAlias(plan.to.slice(0, -'.git'.length), store);
    }
    if (plan.alreadyMigrated) return { ...plan, sha: null, dryRun: false };
    const gitdir = repoPath(domain, store);
    const head = await git.resolveRef({ fs, gitdir, ref: MAIN });
    const moveTo = new Map(plan.moves.map((m) => [m.from, m.to]));
    const entries: { path: string; oid: string; mode: string }[] = [];
    for (const e of await listTree(domain, head, store)) {
      if (LANE_RE.test(e.path)) continue;
      entries.push({ path: moveTo.get(e.path) ?? e.path, oid: e.oid, mode: e.mode });
    }
    const markerOid = await git.writeBlob({ fs, gitdir, blob: new Uint8Array(Buffer.from(layoutMarker(configuredDbtProjectDir()), 'utf8')) });
    entries.push({ path: LAYOUT_MARKER_PATH, oid: markerOid, mode: '100644' });
    for (const [p, content] of generatedReadmes(entries.map((e) => e.path), plan.to.slice(0, -'.git'.length))) {
      if (entries.some((e) => e.path === p)) continue; // a moved writer's README stays the writer's
      entries.push({ path: p, oid: await git.writeBlob({ fs, gitdir, blob: new Uint8Array(Buffer.from(content, 'utf8')) }), mode: '100644' });
    }
    const tree = await writeNested(gitdir, entries);
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const message = appendTrailers(
      commitMessage({ area: 'os', domain: plan.domain, action: 'migrate repository layout', object: plan.domain, surface: 'os:boot', requestId: MIGRATION_REASON }),
      { 'OS-Reason': MIGRATION_REASON },
    );
    const sha = await git.writeCommit({
      fs,
      gitdir,
      commit: { message, tree, parent: [head], author: { ...COMMITTER, timestamp, timezoneOffset: 0 }, committer: { ...COMMITTER, timestamp, timezoneOffset: 0 } },
    });
    await git.writeRef({ fs, gitdir, ref: MAIN, value: sha, force: true });
    notifyCommitted(gitdir, { reposDir }); // WP-56: the migration commit is bundled like any other
    return { ...plan, sha, dryRun: false };
  } finally {
    release();
  }
}

/** Write a flat `{path, oid, mode}` list as nested git trees; returns the root tree oid. */
async function writeNested(gitdir: string, entries: { path: string; oid: string; mode: string }[]): Promise<string> {
  type Node = { blobs: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> };
  const root: Node = { blobs: new Map(), dirs: new Map() };
  for (const e of entries) {
    const parts = e.path.split('/');
    let cur = root;
    for (const seg of parts.slice(0, -1)) {
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, { blobs: new Map(), dirs: new Map() });
      cur = cur.dirs.get(seg)!;
    }
    cur.blobs.set(parts[parts.length - 1], { oid: e.oid, mode: e.mode });
  }
  const write = async (n: Node): Promise<string> => {
    const tree: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    for (const [name, b] of n.blobs) tree.push({ mode: b.mode, path: name, oid: b.oid, type: 'blob' });
    for (const [name, d] of n.dirs) tree.push({ mode: '040000', path: name, oid: await write(d), type: 'tree' });
    tree.sort((a, b) => {
      const an = a.type === 'tree' ? `${a.path}/` : a.path;
      const bn = b.type === 'tree' ? `${b.path}/` : b.path;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return git.writeTree({ fs, gitdir, tree });
  };
  return write(root);
}

/** The deploy-time mode, from `OS_REPO_LAYOUT_MIGRATION`: `off` (default), `dry-run`, `apply`. */
export function migrationMode(): 'off' | 'dry-run' | 'apply' {
  const v = (process.env.OS_REPO_LAYOUT_MIGRATION ?? '').trim().toLowerCase();
  return v === 'apply' || v === 'dry-run' ? v : 'off';
}

/** The domains the migration is limited to, from `OS_REPO_LAYOUT_MIGRATION_DOMAINS` (chart
 *  `osUI.dataProjectGit.layout.migrationDomains`, comma-separated). Unset or empty = every domain,
 *  the contract `migration` has always had; a list lets an operator move one domain first. */
export function migrationDomains(): string[] | undefined {
  const list = (process.env.OS_REPO_LAYOUT_MIGRATION_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** Every domain repo (or only `domains`), one result each; one failing repo never stops the others. */
export async function migrateAllRepos(opts: GitStoreOptions & { dryRun?: boolean; domains?: string[] } = {}): Promise<(MigrationResult | { domain: string; error: string })[]> {
  const out: (MigrationResult | { domain: string; error: string })[] = [];
  const only = opts.domains ? new Set(opts.domains) : null;
  for (const r of await listAllRepos(opts)) {
    if (r.kind !== 'domain' || !r.domain || !r.head) continue;
    if (only && !only.has(r.domain)) continue;
    try {
      out.push(await migrateRepoLayout(r.domain, opts));
    } catch (e) {
      out.push({ domain: r.domain, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
