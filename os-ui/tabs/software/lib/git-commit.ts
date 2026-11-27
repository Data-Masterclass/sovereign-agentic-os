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
 *   - APP BUILDER A (living spec): `meta.source` / `meta.proposalId` add the `OS-Source` / `OS-Proposal` trailers
 *     (spec section 3.3), and `commitAppStories` commits exactly `apps/<slug>/stories/` (every other path of the app
 *     keeps its blob). The stories receive registration (stories/receive-index.ts) is imported here for its side
 *     effect: `app-receive.ts` imports this module at boot, so the stories validator and index hook are armed with
 *     the app ingest, and both do nothing while the App Builder flag is off.
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
import { listTree, mainSha, readSubtree, repoExists } from '@core/infra/git-store';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { APPS_DIR } from '@core/infra/repo-layout';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { OS_PROPOSAL_TRAILER, OS_SOURCE_TRAILER, STORIES_DIR, templateVersionOf, type SpecSource } from '@tabs/software/lib/app-builder-contracts';
import '@tabs/software/lib/stories/receive-index';
// App Builder B registers its post-hoc proposals receive hook the same way (inert with the switch off).
import '@tabs/software/lib/stories/posthoc';

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
  /** App Builder: where the change came from (`OS-Source` trailer). A push never carries it: its source is `git`. */
  source?: Exclude<SpecSource, 'git'>;
  /** App Builder: the approved diff card this commit applies (`OS-Proposal` trailer). */
  proposalId?: string;
  /** App Builder: the person whose action caused a commit the PLATFORM makes (`OS-Requested-By`, e.g. the migration). */
  requestedBy?: string;
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
    ...(meta.source ? { [OS_SOURCE_TRAILER]: one(meta.source) } : {}),
    ...(meta.proposalId ? { [OS_PROPOSAL_TRAILER]: one(meta.proposalId) } : {}),
    ...(meta.requestedBy ? { 'OS-Requested-By': one(meta.requestedBy) } : {}),
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
  // App Builder A: the living spec of a v2 app is owned by the stories path; a whole-tree writer keeps `stories/` exactly
  // as it is in git (read under the app's spec lock, so a story save cannot land between the read and this commit).
  if (appBuilderEnabled() && files.length > 0 && (await isLivingSpecApp(app.id))) {
    const { withSpecLock } = await import('@tabs/software/lib/stories/store');
    return withSpecLock({ domain, slug: app.slug }, async () => {
      let kept: ScaffoldFile[];
      try {
        kept = await withStoriesFromGit({ ...app, domain }, files, deps);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[app-git] commit of apps/${app.slug} in '${domain}' refused: ${reason}`);
        return { ok: false, recorded: false, reason };
      }
      return writeAppTree(app, domain, actor, kept, meta, deps);
    });
  }
  return writeAppTree(app, domain, actor, files, meta, deps);
}

async function writeAppTree(app: AppIdentity, domain: string, actor: ActorIdentity, files: ScaffoldFile[], meta: AppCommitMeta, deps: AppCommitDeps): Promise<AppCommitOutcome> {
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

/** True for an app whose design lives in `stories/` files (template v2). */
async function isLivingSpecApp(appId: string): Promise<boolean> {
  const { getAppByIdInternal } = await import('@tabs/software/lib/apps');
  const rec = await getAppByIdInternal(appId);
  return Boolean(rec && templateVersionOf(rec) === 2);
}

const isStoriesPath = (p: string): boolean => String(p ?? '').replace(/^\.\//, '').startsWith(`${STORIES_DIR}/`);

/**
 * App Builder A: `files` (an app's WHOLE tree, app-relative) with its `stories/` part replaced by what git holds at
 * HEAD, so a code save, `push_app_files`, a build or a deploy pin can never revert or delete a story change made
 * through the stories path (they all start from the file cache, which may predate it). Applies only with the flag on,
 * to a template v2 app, to a non-empty tree (an empty tree is how an archive/delete is recorded), and once the app has
 * a tree in git (a brand-new app's seed keeps its own `stories/`). A stories subtree git cannot hand over whole is a
 * refusal (503), never a silent drop.
 */
export async function withStoriesFromGit(
  app: { id: string; slug: string; domain?: string | null },
  files: ScaffoldFile[],
  deps: { reposDir?: string } = {},
): Promise<ScaffoldFile[]> {
  const domain = String(app.domain ?? '').trim();
  if (!appBuilderEnabled() || files.length === 0 || !domain || !appProjectGitEnabled()) return files;
  if (!(await isLivingSpecApp(app.id))) return files;
  const reposDir = deps.reposDir ?? config.reposDir;
  if (!repoExists(domain, { reposDir }) || !(await mainSha(domain, { reposDir }))) return files;
  const appPrefix = `${appSubtreePrefix(app.slug)}/`;
  if (!(await listTree(domain, 'main', { reposDir })).some((e) => e.path.startsWith(appPrefix))) return files;
  const read = await readSubtree(domain, `${APPS_DIR}/${app.slug}/${STORIES_DIR}`, { reposDir });
  if (read?.truncated) throw new GitStoreError(`${APPS_DIR}/${app.slug}/${STORIES_DIR}/ is too large to read back whole; nothing was written`, 503);
  const fromGit = (read?.files ?? []).map((f) => ({ path: `${STORIES_DIR}/${f.path}`, content: f.content }));
  return [...files.filter((f) => !isStoriesPath(f.path)), ...fromGit];
}

/**
 * App Builder A: a code door (`push_app_files`, `commit`, the build loop, the code editor) may not write the living spec
 * of a v2 app: stories are changed through the stories tools, which validate them and assign ids. Refused (400) with
 * the way out; with the flag off, or for any other app, nothing is refused.
 */
export async function assertNoStoriesWrite(app: { id: string }, paths: string[]): Promise<void> {
  if (!appBuilderEnabled()) return;
  const hits = paths.filter(isStoriesPath);
  if (hits.length === 0 || !(await isLivingSpecApp(app.id))) return;
  throw Object.assign(
    new Error(
      `${hits[0]}${hits.length > 1 ? ` (and ${hits.length - 1} more)` : ''}: the stories of an App Builder app are changed through the Stories view or the stories tools (design_software, get_stories), which validate them and assign their ids, or by a git push. This door does not write stories/.`,
    ),
    { status: 400 },
  );
}

/**
 * App Builder A: commit the app's WHOLE living spec — exactly the subtree `apps/<slug>/stories/` — as the actor, with
 * the OS trailers plus `OS-Source` (and `OS-Proposal` for an approved diff card). `files` are APP-relative
 * (`stories/EP-1-x/US-3-y.md`); a path outside `stories/` is refused before anything is written. Every other path of
 * the app keeps its current blob (`commitSubtree`), so a story edit never touches code. An empty `files` deletes the
 * subtree. Same honest outcome as `commitAppTree`.
 */
export async function commitAppStories(
  app: AppIdentity,
  actor: ActorIdentity,
  files: ScaffoldFile[],
  meta: AppCommitMeta & { source: Exclude<SpecSource, 'git'> },
  deps: AppCommitDeps = {},
): Promise<AppCommitOutcome> {
  if (!appProjectGitEnabled()) return { ok: true, recorded: false, reason: 'the domain git repository is disabled (DATA_PROJECT_GIT=false)' };
  const domain = String(app.domain ?? '').trim();
  if (!domain) return { ok: true, recorded: false, reason: 'the app is not assigned to a domain, so it has no domain repository yet' };
  try {
    const root = `${appSubtreePrefix(app.slug)}/${STORIES_DIR}`;
    for (const f of files) {
      if (!String(f.path ?? '').startsWith(`${STORIES_DIR}/`)) throw new GitStoreError(`'${String(f.path).slice(0, 80)}' is outside ${STORIES_DIR}/`);
    }
    const tree = appTreeFiles(app.slug, files);
    const surface = currentSurface();
    const message = appCommitMessage(app, { ...meta, surface: meta.surface ?? surface?.surface, requestId: meta.requestId ?? surface?.requestId }, domain);
    const { author, synthesized } = authorFor(actor);
    const commit = deps.committer ?? commitSubtree;
    const result = await commit(domain, root, tree, {
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
    return { ok: true, recorded: true, sha: result.sha, changed: result.changed, domain, path: root };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[app-git] stories commit of apps/${app.slug} in '${domain}' failed: ${reason}`);
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
  const state = await readAppTreeState(app, opts);
  return state.kind === 'tree' ? { files: state.files, sha: state.sha, truncated: state.truncated } : null;
}

/**
 * What git can say about an app's tree — with "there is none" and "I could not read it" kept
 * APART. `readAppTreeFromGit` folds both into `null`, which is right for a reader that falls back
 * to a cache, and wrong for a WRITER: `commitToApp` replaces the whole subtree, so mistaking an
 * unreadable tree for an absent one would commit the deletion of everything in it.
 *
 *   `tree`   — the subtree was read (`truncated` says whether it is complete);
 *   `none`   — git answered and holds no tree for this app (or the app has no domain repository
 *              at all: the feature is off, or no domain is assigned);
 *   `failed` — the read threw. A tree may well exist; nothing may be concluded from its absence.
 */
export type AppTreeState =
  | { kind: 'tree'; files: ScaffoldFile[]; sha: string; truncated: boolean }
  | { kind: 'none' }
  | { kind: 'failed'; reason: string };

type SubtreeReader = (
  domain: string,
  prefix: string,
  opts: { reposDir: string; ref?: string },
) => Promise<{ files: { path: string; content: string }[]; sha: string; truncated: boolean } | null>;

let readerOverride: SubtreeReader | null = null;

/** Test hook: substitute the `@core` subtree read (`null` = the real one). */
export function __setAppTreeReaderForTests(reader: SubtreeReader | null): void {
  readerOverride = reader;
}

export async function readAppTreeState(
  app: Pick<AppIdentity, 'slug' | 'domain'>,
  opts: { reposDir?: string; ref?: string } = {},
): Promise<AppTreeState> {
  if (!appProjectGitEnabled()) return { kind: 'none' };
  const domain = String(app.domain ?? '').trim();
  if (!domain) return { kind: 'none' };
  try {
    // REVIEW M-1 + M-5: ONE bounded `@core` read (`readSubtree`) — one tree walk, capped blob
    // reads, and the sha of the commit that last changed THIS APP's prefix (not the repository
    // head, which a dbt or agents commit would otherwise supply as the app's version).
    const reader: SubtreeReader = readerOverride ?? ((await import('@core/infra/git-store')).readSubtree as SubtreeReader);
    const read = await reader(domain, appSubtreePrefix(app.slug), {
      reposDir: opts.reposDir ?? config.reposDir,
      ref: opts.ref,
    });
    if (!read) return { kind: 'none' };
    return { kind: 'tree', files: read.files as ScaffoldFile[], sha: read.sha, truncated: read.truncated };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[app-git] read-back of apps/${app.slug} in '${domain}' failed: ${reason}`);
    return { kind: 'failed', reason };
  }
}
