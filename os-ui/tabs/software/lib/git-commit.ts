/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    `commitAppTree` — an app's source tree lives in the domain git repository under
 *             `apps/<slug>/`, committed as the acting user through the ONE commit path
 * USER STORY: As an engineer who codes in Claude and pushes to the OS I want my app's source to be
 *             a real git commit in my domain's repository — with my name on it, a sha I can quote,
 *             a history I can read and a diff I can review — not a whole-tree overwrite of one
 *             OpenSearch document that silently discards the prior tree (night-2 S5, decision D16).
 * ARCHITECTURE:
 *   - The exact shape `tabs/data/lib/dbt/commit.ts` and `tabs/agents/lib/git/commit.ts` already
 *     take: `commitSubtree(domain, 'apps/<slug>', files, …)` + a boot-time
 *     `reserveSubtree('apps/')` so the dbt generator's WHOLE-TREE commit cannot delete `apps/**`.
 *   - ONE repo per DOMAIN (not per app): the `os-repos` PVC is ReadWriteOnce behind a
 *     single-replica os-ui with a per-repo mutex, the push mirror is one `{url, tokenSecretRef}`
 *     per domain, and a domain admin has ONE repository to hand their IT department.
 *   - The subject is built HERE with the git store's own `appendTrailers`, so the store's
 *     `commitMessage` keeps its existing `area` union untouched (the night-2 shared-file rule for
 *     `core/infra/git-store.ts`: additive only, no existing export's signature changed).
 *   - Author = the acting user; committer = `Sovereign OS`; trailers `OS-Action` / `OS-Object:
 *     app:<id> (<name>)` / `OS-Surface` / `OS-Request-Id` (+ `OS-Run-Id` when a run caused it,
 *     added by the store from the ambient request scope), `OS-Actor` for the raw principal id and
 *     `OS-Author-Email: synthesized` when the user has no address.
 *   - Idempotent by construction: `commitSubtree` commits ONLY when the resulting tree hash
 *     changed, so pushing the same files twice yields ONE commit.
 *   - The OpenSearch `os-app-files` mirror (`file-mirror.ts`) is DEMOTED to a cache of the
 *     committed tree. Git is the home of record; the mirror is the fast synchronous read.
 *   - Never throws into a writer: a git failure is returned as a typed, visible outcome so the
 *     commit step can SAY that git did not record it, rather than reporting a clean success.
 *   - Server-only: reaches node:fs + isomorphic-git through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import {
  commitSubtree,
  appendTrailers,
  authorFor,
  reserveSubtree,
  GitStoreError,
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import type { ScaffoldFile } from '@tabs/software/lib/model';

/** The subtree every app's source tree lives under, reserved against whole-tree writers. */
export const APPS_PREFIX = 'apps/';

/** The surface recorded when a writer ran outside any request-surface scope. */
export const DEFAULT_SURFACE = 'ui:software';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `apps/<slug>` — one safe path segment, validated before it can reach the filesystem. */
export function appSubtreePrefix(slug: string): string {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new GitStoreError(`invalid app slug '${String(slug).slice(0, 40)}'`);
  return `${APPS_PREFIX}${s}`;
}

/**
 * The app's committed tree as repo-relative `path → content`, under `apps/<slug>/`. A file path
 * that escapes the subtree (absolute, `..`, empty segment) is REFUSED — never silently dropped.
 */
export function appTreeFiles(slug: string, files: ScaffoldFile[]): Map<string, string> {
  const prefix = `${appSubtreePrefix(slug)}/`;
  const out = new Map<string, string>();
  for (const f of files) {
    const p = String(f.path ?? '').trim();
    const parts = p.split('/');
    if (!p || p.startsWith('/') || parts.some((s) => s === '' || s === '.' || s === '..')) {
      throw new GitStoreError(`invalid path in the app tree: '${p.slice(0, 80)}'`);
    }
    out.set(`${prefix}${p}`, String(f.content ?? ''));
  }
  return out;
}

export type AppCommitMeta = {
  /** `commit` / `edit` / `scaffold` / `archive` / `delete` / `push_app_files` … */
  action: string;
  /** `ui:<route>` | `mcp:<tool>`; defaults to {@link DEFAULT_SURFACE}. */
  surface?: string;
  requestId?: string;
  /** An extra `OS-Reason` trailer for a commit whose CAUSE is not simply its action. */
  reason?: string;
  /** A short human line appended to the subject's action, e.g. the user's commit message. */
  note?: string;
};

export type AppIdentity = { id: string; slug: string; name: string; domain?: string | null };
export type ActorIdentity = { id: string; name?: string | null; email?: string | null };

/**
 * `software(<domain>): <action> <slug> — via <surface>` + the OS trailers. Built here (not in the
 * git store) so the store's `commitMessage` signature stays exactly as the Data and Agents tabs
 * found it.
 */
export function appCommitMessage(app: AppIdentity, meta: AppCommitMeta, domain: string): string {
  const one = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const action = one(meta.action) || 'commit';
  const surface = one(meta.surface) || DEFAULT_SURFACE;
  const note = one(meta.note);
  const subject = `software(${domain}): ${action} ${one(app.slug)}${note ? ` — ${note}` : ''} — via ${surface}`;
  return appendTrailers(subject, {
    'OS-Action': action,
    'OS-Object': `app:${one(app.id)}${app.name ? ` (${one(app.name)})` : ''}`,
    'OS-Surface': surface,
    'OS-Request-Id': one(meta.requestId) || newRequestId(),
  });
}

export type SubtreeCommitter = (
  domain: string,
  prefix: string,
  files: Map<string, string>,
  opts: CommitTreeOptions,
) => Promise<CommitResult>;

export type AppCommitDeps = {
  reposDir?: string;
  /** Injected for tests; defaults to the git store's `commitSubtree`. */
  committer?: SubtreeCommitter;
  /** Push to the configured mirror after a changed commit (default true). */
  mirror?: boolean;
};

/** The honest outcome of the git half of a commit — never a silent success, never a throw. */
export type AppCommitOutcome =
  | { ok: true; recorded: true; sha: string; changed: boolean; domain: string; path: string }
  | { ok: true; recorded: false; reason: string }
  | { ok: false; recorded: false; reason: string };

let override: boolean | null = null;

/** Part D's one switch — `DATA_PROJECT_GIT` (the repo, the PVC and the mirror are the same ones). */
export function appProjectGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}

/** Test hook: pin the flag on/off (`null` = back to the environment). */
export function __setAppProjectGitForTests(value: boolean | null): void {
  override = value;
}

/** Reserve `apps/` so the dbt whole-tree generator keeps every app's source. Idempotent. */
export function installAppTreeReservation(): void {
  reserveSubtree(APPS_PREFIX);
}

/**
 * Commit an app's WHOLE tree into `apps/<slug>/` of its domain's repository, as the actor.
 * Returns an honest outcome: `recorded: false` when the flag is off or the app has no domain
 * (a personal app that is not in a domain repo yet), `ok: false` with the reason when git
 * refused. The caller SAYS so on the commit step; nothing here throws into a writer.
 */
export async function commitAppTree(
  app: AppIdentity,
  actor: ActorIdentity,
  files: ScaffoldFile[],
  meta: AppCommitMeta,
  deps: AppCommitDeps = {},
): Promise<AppCommitOutcome> {
  if (!appProjectGitEnabled()) return { ok: true, recorded: false, reason: 'the domain git repository is disabled (DATA_PROJECT_GIT=false)' };
  const domain = String(app.domain ?? '').trim();
  if (!domain) return { ok: true, recorded: false, reason: 'the app is not assigned to a domain, so it has no domain repository yet' };
  try {
    const prefix = appSubtreePrefix(app.slug);
    const tree = appTreeFiles(app.slug, files);
    const surface = currentSurface();
    const message = appCommitMessage(app, { ...meta, surface: meta.surface ?? surface?.surface, requestId: meta.requestId ?? surface?.requestId }, domain);
    const { author, synthesized } = authorFor(actor);
    const commit = deps.committer ?? commitSubtree;
    const result = await commit(domain, prefix, tree, {
      author,
      message,
      trailers: {
        'OS-Actor': actor.id,
        ...(meta.reason ? { 'OS-Reason': meta.reason } : {}),
        ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
      },
      reposDir: deps.reposDir ?? config.reposDir,
    });
    if (result.changed && deps.mirror !== false && !deps.committer) {
      const { pushMirrorAfterCommit } = await import('@core/infra/git-mirror');
      void pushMirrorAfterCommit(domain, result.sha, { reposDir: deps.reposDir ?? config.reposDir });
    }
    return { ok: true, recorded: true, sha: result.sha, changed: result.changed, domain, path: prefix };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[app-git] commit of apps/${app.slug} in '${domain}' failed: ${reason}`);
    return { ok: false, recorded: false, reason };
  }
}

/** The one line the commit step shows, so a failed or skipped git write is never invisible. */
export function gitCommitNote(outcome: AppCommitOutcome): string {
  if (outcome.ok && outcome.recorded) {
    return outcome.changed
      ? `git ${outcome.sha.slice(0, 12)} on ${outcome.path} (${outcome.domain})`
      : `git unchanged — no new commit (${outcome.path})`;
  }
  if (outcome.ok) return `⚠ not recorded in git: ${outcome.reason}`;
  return `⚠ git commit FAILED: ${outcome.reason} — the files are in the mirror cache only`;
}

// ------------------------------------------------------------------ read-back ---

/**
 * READ AN APP'S TREE BACK FROM GIT — the home of record, under `apps/<slug>/`.
 *
 * This is the read half of the same service both doors use: `read_app_files` over the MCP and
 * the editor's file list in the UI resolve through here, so "what you committed is what you
 * read" is a property of ONE function rather than of two caches agreeing. The OpenSearch mirror
 * stays as the fast synchronous fallback (and for an app whose domain repo is off), and the
 * caller is told WHICH it got — `governed-commit` vs `mirror-cache` vs `template-seed` — because
 * a substituted source that reads as the real thing is the failure mode we refuse.
 *
 * Returns `null` (never throws) when git cannot answer, so the caller falls back honestly.
 */
export async function readAppTreeFromGit(
  app: Pick<AppIdentity, 'slug' | 'domain'>,
  opts: { reposDir?: string; ref?: string } = {},
): Promise<{ files: ScaffoldFile[]; sha: string; truncated: boolean } | null> {
  if (!appProjectGitEnabled()) return null;
  const domain = String(app.domain ?? '').trim();
  if (!domain) return null;
  try {
    // REVIEW M-1 + M-5: ONE bounded `@core` read (`readSubtree`) — one tree walk, capped blob
    // reads, and the sha of the commit that last changed THIS APP's prefix (not the repository
    // head, which a dbt or agents commit would otherwise supply as the app's version).
    const { readSubtree } = await import('@core/infra/git-store');
    const read = await readSubtree(domain, appSubtreePrefix(app.slug), {
      reposDir: opts.reposDir ?? config.reposDir,
      ref: opts.ref,
    });
    if (!read) return null;
    return { files: read.files as ScaffoldFile[], sha: read.sha, truncated: read.truncated };
  } catch (e) {
    console.warn(`[app-git] read-back of apps/${app.slug} in '${domain}' failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
