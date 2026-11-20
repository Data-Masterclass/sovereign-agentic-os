/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — commit a domain's OKF bundle on every save, and read it BACK from git
 * USER STORY: As a domain member I want every publish, edit, rename, move, archive or delete of a
 *             shared workflow, and every edit of the domain operating manual, to be a git commit
 *             authored as me — and the store to be rebuilt from those files after a restart.
 * ARCHITECTURE:
 *   - The same shape as the dashboards and connections writers: snapshot → pure generator
 *     (`bundle.ts`) → `commitSubtree('knowledge/')`, committed only when the subtree changed. The
 *     subtree is reserved at boot so the dbt whole-tree commit keeps it.
 *   - ONE flag: `config.dataProjectGit` (`DATA_PROJECT_GIT`).
 *   - A write that produces no bundle in a domain with no repository creates nothing (no empty repo
 *     for a Personal draft).
 *   - `readKnowledgeFromGit` is the read-back the store's reconcile uses: every `knowledge/**` file
 *     at a sha (HEAD by default), parsed by the bundle's inverse.
 *   - Commits are serialised per domain; a failure is logged with the domain and action.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { appendTrailers, authorFor, commitSubtree, listTree, log, readBlob, repoExists, type CommitResult } from '@core/infra/git-store';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import { KNOWLEDGE_PREFIX, generateKnowledgeFiles, readKnowledgeBundle, type BundleReadBack, type KnowledgeSnapshot } from '@tabs/knowledge/lib/git/bundle';

export const AREA = 'knowledge';
export const DEFAULT_SURFACE = 'ui:knowledge';

let override: boolean | null = null;
export function knowledgeGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}
/** Test hook: pin the flag (`null` = back to the environment). */
export function __setKnowledgeGitForTests(value: boolean | null): void {
  override = value;
}

export type ActorIdentity = { id: string; name?: string | null; email?: string | null };
export type CommitMeta = { action: string; object?: string; objectId?: string; surface?: string; requestId?: string; reason?: string };
export type CommitDeps = { reposDir?: string; captured: KnowledgeSnapshot; mirror?: boolean; /** Unix seconds (tests). */ timestamp?: number };

function oneLine(v: string): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export function knowledgeCommitMessage(input: { domain: string; action: string; object: string; objectId?: string; surface: string; requestId: string }): string {
  const subject = `${AREA}(${input.domain}): ${oneLine(input.action)} ${oneLine(input.object)} — via ${oneLine(input.surface)}`;
  return appendTrailers(subject, {
    'OS-Action': oneLine(input.action),
    'OS-Object': oneLine(input.objectId ?? input.object),
    'OS-Surface': oneLine(input.surface),
    'OS-Request-Id': oneLine(input.requestId),
    'OS-Run-Id': oneLine(currentSurface()?.runId ?? ''),
  });
}

/** Regenerate `domain`'s `knowledge/**` and commit it iff it changed. Null when git is off. */
export async function commitKnowledge(domain: string, actor: ActorIdentity, meta: CommitMeta, deps: CommitDeps): Promise<CommitResult | null> {
  if (!knowledgeGitEnabled()) return null;
  const reposDir = deps.reposDir ?? config.reposDir;
  const files = generateKnowledgeFiles(domain, deps.captured);
  if (!files.size && !repoExists(domain, { reposDir })) return { sha: '', changed: false };
  const surface = currentSurface();
  const { author, synthesized } = authorFor(actor);
  const result = await commitSubtree(domain, KNOWLEDGE_PREFIX, files, {
    author,
    message: knowledgeCommitMessage({
      domain,
      action: meta.action,
      object: meta.object ?? domain,
      objectId: meta.objectId,
      surface: meta.surface ?? surface?.surface ?? DEFAULT_SURFACE,
      requestId: meta.requestId ?? surface?.requestId ?? newRequestId(),
    }),
    trailers: {
      'OS-Actor': actor.id,
      ...(meta.reason ? { 'OS-Reason': meta.reason } : {}),
      ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
    },
    reposDir,
    ...(deps.timestamp ? { timestamp: deps.timestamp } : {}),
  });
  if (result.changed && deps.mirror !== false) {
    const { pushMirrorAfterCommit } = await import('@core/infra/git-mirror');
    void pushMirrorAfterCommit(domain, result.sha, { reposDir });
  }
  return result;
}

export type CommittedKnowledge = BundleReadBack & { sha: string; timestamp: number };

/** THE READ-BACK: `domain`'s committed bundle at `ref` (HEAD by default); null when nothing is committed. */
export async function readKnowledgeFromGit(domain: string, opts: { reposDir?: string; ref?: string } = {}): Promise<CommittedKnowledge | null> {
  const reposDir = opts.reposDir ?? config.reposDir;
  if (!repoExists(domain, { reposDir })) return null;
  const head = (await log(domain, { reposDir, limit: 1 }))[0];
  const sha = opts.ref ?? head?.sha;
  if (!sha) return null;
  const files = new Map<string, string>();
  for (const e of await listTree(domain, sha, { reposDir })) {
    if (e.path.startsWith(KNOWLEDGE_PREFIX)) files.set(e.path, await readBlob(domain, sha, e.path, { reposDir }));
  }
  if (!files.size) return null;
  return { sha, timestamp: head?.timestamp ?? 0, ...readKnowledgeBundle(files) };
}

let resolveActor: (id: string) => Promise<ActorIdentity> = async (id) => ({ id });
/** Boot wiring (`instrumentation.ts`): the admin directory's name + e-mail for an actor id. */
export function setKnowledgeActorResolver(fn: (id: string) => Promise<ActorIdentity>): void {
  resolveActor = fn;
}

const chains = new Map<string, Promise<unknown>>();
const inFlight = new Set<Promise<unknown>>();

/** Await every queued commit (tests; shutdown). */
export async function awaitKnowledgeCommits(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** Queue a commit of `domain`'s bundle from the state THIS write produced (captured by the caller). */
export function queueKnowledgeCommit(domain: string, actor: ActorIdentity, meta: CommitMeta, captured: KnowledgeSnapshot, deps: Omit<CommitDeps, 'captured'> = {}): Promise<CommitResult | null> {
  const surface = currentSurface();
  const pinned: CommitMeta = { ...meta, surface: meta.surface ?? surface?.surface, requestId: meta.requestId ?? surface?.requestId };
  const prev = chains.get(domain) ?? Promise.resolve();
  const p = prev
    .then(async () => {
      const known = await resolveActor(actor.id).catch((e) => {
        console.warn(`[knowledge-git] actor ${actor.id}: directory lookup failed, committing with the id only (${e instanceof Error ? e.message : String(e)})`);
        return { id: actor.id };
      });
      return commitKnowledge(domain, { ...actor, ...Object.fromEntries(Object.entries(known).filter(([, v]) => v)) }, pinned, { ...deps, captured });
    })
    .catch((e) => {
      console.error(`[knowledge-git] commit failed for '${meta.action}' in ${domain}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
  // `allSettled` HANDLES p (it is logged above and returned to an awaiting caller), so the chain
  // and a fire-and-forget caller never see an unhandled rejection, and the next commit still runs.
  const tracked: Promise<unknown> = Promise.allSettled([p]).then(() => {
    inFlight.delete(tracked);
    if (chains.get(domain) === tracked) chains.delete(domain);
  });
  chains.set(domain, tracked);
  inFlight.add(tracked);
  return p;
}
