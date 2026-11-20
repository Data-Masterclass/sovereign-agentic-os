/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — commit a domain's `connections/**` on every save, and read a catalog BACK
 * USER STORY: As a user I want every create, edit, archive or delete of a warehouse connection to
 *             be a git commit in my domain's repository authored as me, and as an operator I want
 *             Trino to load what that commit holds — not a second, in-memory render (contract C4).
 * ARCHITECTURE:
 *   - The same shape as `tabs/dashboards/lib/git/commit.ts`: snapshot → pure generator →
 *     `commitSubtree('connections/')`, which commits only when the subtree changed. The subtree is
 *     reserved at boot (`instrumentation.ts`) so the dbt generator's whole-tree commit keeps it.
 *   - ONE flag: `config.dataProjectGit` (`DATA_PROJECT_GIT`), the switch for every domain-repo writer.
 *   - `readCatalogFromGit` is the read-back: the committed `catalog.properties` at a sha (HEAD by
 *     default) — the bytes `registerWarehouseCatalog` applies to Trino, with that sha recorded.
 *   - Server-only: reaches node:fs through the git store. Never throws into a store write: the
 *     store's caller logs a failed commit.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { appendTrailers, authorFor, commitSubtree, log, readBlob, type CommitResult, type CommitTreeOptions } from '@core/infra/git-store';
import { connectionCatalogPath } from '@core/infra/repo-layout';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import { CONNECTIONS_PREFIX, generateConnectionFiles, parseCatalogProperties, type SnapshotConnection } from '@tabs/connections/lib/git/generate';

export const AREA = 'connections';
export const DEFAULT_SURFACE = 'ui:connections';

let override: boolean | null = null;
export function connectionsGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}
/** Test hook: pin the flag (`null` = back to the environment). */
export function __setConnectionsGitForTests(value: boolean | null): void {
  override = value;
}

export type ActorIdentity = { id: string; name?: string | null; email?: string | null };
export type CommitMeta = { action: string; object?: string; objectId?: string; surface?: string; requestId?: string; reason?: string };
export type CommitDeps = {
  reposDir?: string;
  /** The domain's stored connections, captured in the writer's turn. */
  captured: SnapshotConnection[];
  /** Push to the configured mirror after a changed commit (default true). */
  mirror?: boolean;
};

function oneLine(v: string): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** `connections(<domain>): <action> <object> — via <surface>` + the kernel's OS trailers. */
export function connectionCommitMessage(input: { domain: string; action: string; object: string; objectId?: string; surface: string; requestId: string }): string {
  const subject = `${AREA}(${input.domain}): ${oneLine(input.action)} ${oneLine(input.object)} — via ${oneLine(input.surface)}`;
  return appendTrailers(subject, {
    'OS-Action': oneLine(input.action),
    'OS-Object': oneLine(input.objectId ?? input.object),
    'OS-Surface': oneLine(input.surface),
    'OS-Request-Id': oneLine(input.requestId),
    'OS-Run-Id': oneLine(currentSurface()?.runId ?? ''),
  });
}

/** Regenerate `domain`'s `connections/**` and commit it iff it changed. Null when git is off. */
export async function commitConnections(domain: string, actor: ActorIdentity, meta: CommitMeta, deps: CommitDeps): Promise<CommitResult | null> {
  if (!connectionsGitEnabled()) return null;
  const files = generateConnectionFiles(domain, deps.captured);
  const surface = currentSurface();
  const message = connectionCommitMessage({
    domain,
    action: meta.action,
    object: meta.object ?? domain,
    objectId: meta.objectId,
    surface: meta.surface ?? surface?.surface ?? DEFAULT_SURFACE,
    requestId: meta.requestId ?? surface?.requestId ?? newRequestId(),
  });
  const { author, synthesized } = authorFor(actor);
  const reposDir = deps.reposDir ?? config.reposDir;
  const opts: CommitTreeOptions = {
    author,
    message,
    trailers: {
      'OS-Actor': actor.id,
      ...(meta.reason ? { 'OS-Reason': meta.reason } : {}),
      ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
    },
    reposDir,
  };
  const result = await commitSubtree(domain, CONNECTIONS_PREFIX, files, opts);
  if (result.changed && deps.mirror !== false) {
    const { pushMirrorAfterCommit } = await import('@core/infra/git-mirror');
    void pushMirrorAfterCommit(domain, result.sha, { reposDir });
  }
  return result;
}

export type CommittedCatalog = { sha: string; path: string; text: string; props: Record<string, string> };

/**
 * THE READ-BACK: the committed catalog file of `catalog` in `domain`'s repo, at `ref` (default:
 * the head of main). Throws `not committed` when the file is absent at that commit.
 */
export async function readCatalogFromGit(domain: string, catalog: string, opts: { reposDir?: string; ref?: string } = {}): Promise<CommittedCatalog> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const sha = opts.ref ?? (await log(domain, { reposDir, limit: 1 }))[0]?.sha;
  const path = connectionCatalogPath(catalog);
  if (!sha) throw new Error(`catalog '${catalog}' is not committed: '${domain}' has no commits`);
  let text: string;
  try {
    text = await readBlob(domain, sha, path, { reposDir });
  } catch {
    throw new Error(`catalog '${catalog}' is not committed in '${domain}' at ${sha.slice(0, 12)} (${path})`);
  }
  return { sha, path, text, props: parseCatalogProperties(text) };
}

let resolveActor: (id: string) => Promise<ActorIdentity> = async (id) => ({ id });
/** Boot wiring (`instrumentation.ts`): the admin directory's name + e-mail for an actor id. */
export function setConnectionActorResolver(fn: (id: string) => Promise<ActorIdentity>): void {
  resolveActor = fn;
}

const chains = new Map<string, Promise<unknown>>();
const inFlight = new Set<Promise<unknown>>();

/** Await every queued commit (tests; shutdown). */
export async function awaitConnectionCommits(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/**
 * Queue a commit of `domain`'s `connections/**`, serialised per domain. `captured` is the store
 * state THIS write produced, taken synchronously by the caller. The returned promise resolves to
 * the commit (or null with git off); a failure is logged with the domain and action and rethrown
 * to an awaiting caller, so a fire-and-forget caller is never silent and an awaiting one can refuse.
 */
export function queueConnectionsCommit(domain: string, actor: ActorIdentity, meta: CommitMeta, captured: SnapshotConnection[], deps: Omit<CommitDeps, 'captured'> = {}): Promise<CommitResult | null> {
  const surface = currentSurface();
  const pinned: CommitMeta = { ...meta, surface: meta.surface ?? surface?.surface, requestId: meta.requestId ?? surface?.requestId };
  const prev = chains.get(domain) ?? Promise.resolve();
  const p = prev
    .catch(() => undefined)
    .then(async () => {
      const known = await resolveActor(actor.id).catch(() => ({ id: actor.id }));
      return commitConnections(domain, { ...actor, ...Object.fromEntries(Object.entries(known).filter(([, v]) => v)) }, pinned, { ...deps, captured });
    })
    .catch((e) => {
      console.error(`[connections-git] commit failed for '${meta.action}' in ${domain}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
  const tracked = p.finally(() => {
    inFlight.delete(tracked);
    if (chains.get(domain) === tracked) chains.delete(domain);
  });
  tracked.catch(() => undefined);
  chains.set(domain, tracked);
  inFlight.add(tracked);
  return p;
}
