/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `commitDataProject` — regenerate a domain's dbt project and commit it as the acting user
 * USER STORY: As a data engineer I want every change I make to a dataset, composition, quality rule,
 *             sync or publish — in the UI or through the OS MCP — to be a git commit in my domain's
 *             repository, authored as me and naming the action and its origin (checklist D2, X1).
 * ARCHITECTURE:
 *   - The single commit path for the Data tab, behind `DATA_PROJECT_GIT` (ON by default since B4; off: no repo is
 *     touched). `installDataProjectCommitHook` subscribes to the store's project-change events at
 *     boot (`instrumentation.ts`); each event → snapshot → `generateProject` → `commitTree`, which
 *     commits only when the tree changed. Mirror push afterwards is fire-and-forget and never
 *     fails the save (concept §2.1).
 *   - Surface + request id come from the ambient request context (`core/infra/request-surface`),
 *     read SYNCHRONOUSLY in the listener; a writer outside any surface scope is recorded as
 *     `ui:data` and logged as a gap, never silently.
 *   - Actor name/e-mail are resolved through an injected resolver (the admin user directory is
 *     another tab — `instrumentation.ts` wires it); absent e-mail ⇒ `<id>@os.local` + the
 *     `OS-Author-Email: synthesized` trailer.
 *   - Server-only: imports node:fs + isomorphic-git through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { commitTree, commitMessage, authorFor, type CommitResult, type CommitTreeOptions } from '@core/infra/git-store';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import { onProjectChange, type ProjectChange } from '@tabs/data/lib/project-events';
import { peekDatasetMeta, datasetsForProject } from '@tabs/data/lib/store';
import { slug } from '@tabs/data/lib/store-fqn';
import { projectSnapshot, type SnapshotDeps, type SnapshotDataset } from '@tabs/data/lib/dbt/snapshot';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import { pushMirrorAfterCommit } from '@tabs/data/lib/dbt/mirror';

/** The surface recorded when a writer ran outside any request-surface scope. */
export const DEFAULT_SURFACE = 'ui:data';

let override: boolean | null = null;

/** `DATA_PROJECT_GIT` (tests may pin it). */
export function dataProjectGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}

/** Test hook: pin the flag on/off (`null` = back to the environment). */
export function __setDataProjectGitForTests(value: boolean | null): void {
  override = value;
}

export type ActorIdentity = { id: string; name?: string | null; email?: string | null };

export type CommitMeta = {
  action: string;
  /** Short object label for the subject (a dataset slug); defaults to the domain. */
  object?: string;
  /** `<id> (<name>)` for the OS-Object trailer; defaults to `object`. */
  objectId?: string;
  /** `ui:<route>` | `mcp:<tool>`; defaults to {@link DEFAULT_SURFACE}. */
  surface?: string;
  requestId?: string;
  /** Extra commit trailers (the boot reconcile's `OS-Reason`); never overwrite `OS-Actor`. */
  extraTrailers?: Record<string, string>;
};

export type Committer = (domain: string, files: Map<string, string>, opts: CommitTreeOptions) => Promise<CommitResult>;

export type CommitDeps = SnapshotDeps & {
  reposDir?: string;
  /** Injected for tests; defaults to the git store's `commitTree`. */
  committer?: Committer;
  /** Push to the configured mirror after a changed commit (default true). */
  mirror?: boolean;
  /** The store read captured synchronously in the writer's turn (the hook passes it — review M3). */
  captured?: SnapshotDataset[];
};

/**
 * Regenerate `domain`'s project and commit it iff it changed. Returns null when the flag is off.
 */
export async function commitDataProject(domain: string, actor: ActorIdentity, meta: CommitMeta, deps: CommitDeps = {}): Promise<CommitResult | null> {
  if (!dataProjectGitEnabled()) return null;
  const snapshot = await projectSnapshot(domain, deps, deps.captured);
  // The generator reads no env: the auth method is handed in, because `profiles.yml`'s
  // `password:` key is a generator decision, not a Jinja-time one (B4-review E-3).
  const files = generateProject(domain, snapshot, { trinoAuthMethod: config.trinoAuthMethod });
  const object = meta.object ?? domain;
  const message = commitMessage({
    area: 'data',
    domain,
    action: meta.action,
    object,
    objectId: meta.objectId,
    surface: meta.surface ?? DEFAULT_SURFACE,
    requestId: meta.requestId ?? newRequestId(),
  });
  const { author, synthesized } = authorFor(actor);
  const reposDir = deps.reposDir ?? config.reposDir;
  const commit = deps.committer ?? commitTree;
  const result = await commit(domain, files, {
    author,
    message,
    // `OS-Actor` carries the principal id even when the author name is a display name (review L3).
    trailers: {
      ...(meta.extraTrailers ?? {}),
      'OS-Actor': actor.id,
      ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
    },
    reposDir,
  });
  if (result.changed && deps.mirror !== false && !deps.committer) {
    void pushMirrorAfterCommit(domain, result.sha, { reposDir });
  }
  return result;
}

export type HookDeps = CommitDeps & {
  /** Resolve the acting user's display name + e-mail (the admin directory). Absent ⇒ id only. */
  resolveActor?: (id: string) => Promise<ActorIdentity>;
};

const inFlight = new Set<Promise<void>>();
const warnedSurfaces = new Set<string>();

/** Await every commit the hook has started (tests; shutdown). */
export async function awaitDataProjectCommits(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

function objectLabels(change: ProjectChange): { object: string; objectId: string } {
  const meta = peekDatasetMeta(change.datasetId);
  const name = meta?.name?.trim();
  return name
    ? { object: slug(name), objectId: `${change.datasetId} (${name})` }
    : { object: change.datasetId, objectId: change.datasetId };
}

async function handleChange(
  change: ProjectChange,
  surface: { surface: string; requestId: string } | null,
  labels: { object: string; objectId: string },
  captured: SnapshotDataset[],
  deps: HookDeps,
): Promise<CommitResult | null> {
  if (!surface && !warnedSurfaces.has(change.action)) {
    warnedSurfaces.add(change.action);
    console.warn(`[data-projects] '${change.action}' reached the store outside a request-surface scope — recorded as ${DEFAULT_SURFACE}`);
  }
  const actor = deps.resolveActor ? await deps.resolveActor(change.actorId) : { id: change.actorId };
  return commitDataProject(
    change.domain,
    actor,
    { action: change.action, ...labels, surface: surface?.surface ?? DEFAULT_SURFACE, requestId: surface?.requestId },
    { ...deps, captured },
  );
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Subscribe the commit path to the store's project-change events. Returns the unsubscribe
 * function. The store read and the object labels are captured SYNCHRONOUSLY in the writer's turn
 * and commits are serialised per domain, so two rapid writes produce two commits, each carrying its
 * own author, action and state (review M3). Failures are logged, never thrown into the write.
 */
export function installDataProjectCommitHook(deps: HookDeps = {}): () => void {
  return onProjectChange((change) => {
    if (!dataProjectGitEnabled()) return;
    if (!change.domain) return; // an unassigned dataset has no repo
    const surface = currentSurface(); // read synchronously, in the writer's async context
    const labels = objectLabels(change);
    const captured = datasetsForProject(change.domain); // the state THIS write produced
    const prev = chains.get(change.domain) ?? Promise.resolve();
    const p = prev
      .then(async () => { await handleChange(change, surface, labels, captured, deps); })
      .catch((e) => {
        console.error(`[data-projects] commit failed for ${change.action} on ${change.datasetId} (${change.domain}): ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        inFlight.delete(p);
        if (chains.get(change.domain) === p) chains.delete(change.domain);
      });
    chains.set(change.domain, p);
    inFlight.add(p);
  });
}
