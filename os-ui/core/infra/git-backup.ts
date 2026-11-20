/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Git backup glue (WP-56) — the commit path's hand-off to the bundle sidecar, and the
 *             live repository inventory the restore drill compares against
 * USER STORY: As the owner I want every commit to reach object-locked storage as a git bundle
 *             without any commit waiting for it or failing because of it, and a weekly drill that
 *             proves the bundles restore to exactly what the live repositories hold.
 * ARCHITECTURE:
 *   - The bundling itself is git's own `git bundle` in the `git-backup` sidecar
 *     (charts/.../files/backup/git-bundler.sh). isomorphic-git has no bundle support, so this
 *     module never bundles; it only DROPS A MARKER: one file per repository in the queue
 *     directory shared with the sidecar (`GIT_BACKUP_QUEUE_DIR`, an emptyDir). Repeated commits
 *     coalesce into one marker.
 *   - INTERIM for the pg-boss outbox: WP-07's adapter (`core/adapters/postgres/boss.ts`) is merged,
 *     but no OS process runs a queue or a worker yet (WP-08), so the marker directory is the queue.
 *     The swap: `send('git-bundle', { key }, { singletonKey: key })` here, consumed by the sidecar. A lost marker (pod restart) is covered by the sidecar's periodic rescan, which
 *     bundles every repository whose refs moved since its `latest` pointer.
 *   - `notifyCommitted` NEVER throws and is NEVER awaited by the commit: the write is scheduled
 *     with `setImmediate` after the commit returns; a failure is logged, not raised. With the
 *     variable unset (backups off) it does nothing.
 *   - The key is the bare repo's path under the repos root without `.git`, so every repository
 *     kind of repo-layout.ts (`domain-<d>`, `user-<token>`, `platform`) is covered with no change
 *     here. A legacy name that is a symlink alias resolves to its canonical repo; the inventory
 *     and the sidecar skip symlinks, so no repository is bundled twice.
 *   - `backupInventory` lists EVERY bare repository under the root (any depth up to 4) with its
 *     refs — the drill's independent "live" side, served at /api/git/backup-inventory.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { config } from '@core/kernel/config';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The repository key of a bare repo (`<root>/sales.git` → `sales`), or null when outside the root. */
export function repoKeyFor(gitdir: string, reposDir: string = config.reposDir): string | null {
  const rel = path.relative(path.resolve(reposDir), path.resolve(gitdir)).split(path.sep).join('/');
  if (!rel.endsWith('.git')) return null;
  const key = rel.slice(0, -'.git'.length);
  if (!key || key.startsWith('/') || key.split('/').some((s) => s === '' || s === '.' || s === '..') || !KEY_RE.test(key)) return null;
  return key;
}

/** The marker's file name: the key with `/` made flat, so every key is one file in one directory. */
export function markerName(key: string): string {
  return key.replace(/\//g, '__');
}

export type NotifyOptions = { reposDir?: string; queueDir?: string | null };

/**
 * Tell the bundle sidecar that `gitdir` has a new commit. Fire-and-forget: returns before any
 * IO, never throws, never rejects. Returns whether a marker was scheduled (for tests).
 */
export function notifyCommitted(gitdir: string, opts: NotifyOptions = {}): boolean {
  try {
    const queue = opts.queueDir === undefined ? process.env.GIT_BACKUP_QUEUE_DIR || null : opts.queueDir;
    if (!queue) return false;
    const reposDir = opts.reposDir ?? config.reposDir;
    if (!repoKeyFor(gitdir, reposDir)) return false;
    setImmediate(() => {
      // Resolved on the later turn: a legacy `<domain>.git` name is a symlink alias of the
      // canonical repo (repo-layout.ts), and the bundle belongs to the canonical key only.
      fs.promises
        .realpath(gitdir)
        .then(async (real) => {
          const key = repoKeyFor(real, await fs.promises.realpath(reposDir));
          if (!key) throw new Error(`'${gitdir}' resolves outside the repositories root`);
          await fs.promises.mkdir(queue, { recursive: true });
          // Atomic: write a dot-file (the sidecar's glob skips dot-files), then rename over the marker.
          const tmp = path.join(queue, `.${markerName(key)}.${process.pid}.${Date.now()}`);
          await fs.promises.writeFile(tmp, key);
          await fs.promises.rename(tmp, path.join(queue, markerName(key)));
        })
        .catch((e: unknown) => {
          console.error(`[git-backup] could not queue '${gitdir}' for bundling (the sidecar's rescan will pick it up): ${e instanceof Error ? e.message : String(e)}`);
        });
    });
    return true;
  } catch (e) {
    console.error(`[git-backup] notify failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export type InventoryRepo = { key: string; refs: Record<string, string> };

function findBareRepos(root: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  // An unreadable directory is an ERROR: the drill must see "inventory unreadable", never a
  // shorter list that would let a repository silently drop out of the comparison.
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name.endsWith('.git')) {
      if (fs.existsSync(path.join(p, 'HEAD'))) out.push(p);
    } else if (!e.name.startsWith('.')) {
      findBareRepos(p, depth - 1, out);
    }
  }
}

/** Every bare repository under the root with every ref (`refs/heads/*`, `refs/tags/*`, …) and its oid. */
export async function backupInventory(reposDir: string = config.reposDir): Promise<{ repos: InventoryRepo[] }> {
  const dirs: string[] = [];
  findBareRepos(reposDir, 3, dirs);
  const repos: InventoryRepo[] = [];
  for (const gitdir of dirs) {
    const key = repoKeyFor(gitdir, reposDir);
    if (!key) continue;
    const refs: Record<string, string> = {};
    for (const ref of await git.listRefs({ fs, gitdir, filepath: 'refs' })) {
      const name = `refs/${ref}`;
      // Never peeled: a tag ref names the tag object, exactly as `git for-each-ref` (the drill's side) reports it.
      refs[name] = await git.resolveRef({ fs, gitdir, ref: name });
    }
    repos.push({ key, refs });
  }
  return { repos };
}
