/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `commitAgentSystem` — regenerate a domain's `agents/**` and commit it as the actor
 * USER STORY: As an AI engineer I want every change to an agent system — created, edited, built,
 *             promoted, renamed, moved, archived or deleted, from the UI or through the OS MCP —
 *             to be a git commit in my domain's repository, authored as me and naming the action
 *             and its origin (checklist A2, A33, X1).
 * ARCHITECTURE:
 *   - The single commit path for the Agents tab, the exact shape `tabs/data/lib/dbt/commit.ts`
 *     took for the data side. `installAgentProjectCommitHook` subscribes to the store's
 *     system-change events at boot (`instrumentation.ts`); each event → snapshot →
 *     `generateAgentFiles` → `commitSubtree`, which commits only when the subtree changed.
 *   - ONE flag for the whole of Part D: `config.dataProjectGit` (`DATA_PROJECT_GIT`, chart
 *     `osUI.dataProjectGit.enabled`). The repo, the PVC and the git-daemon sidecar it gates are
 *     the same ones this subtree lives in, so a second switch could only ever be wrong
 *     (deviation D-2 — the env var keeps its historical name).
 *   - `commitSubtree` + a boot-time `reserveSubtree('agents/')`: the dbt generator writes the
 *     WHOLE tree, so without the reservation its next commit would delete `agents/**`.
 *   - Surface + request id come from the ambient request context (`core/infra/request-surface`),
 *     read SYNCHRONOUSLY in the listener; a writer outside any surface scope is recorded as
 *     `ui:agents` and logged as a gap, never silently.
 *   - Actor name/e-mail come from an injected resolver (the admin user directory is another tab);
 *     an absent e-mail ⇒ `<id>@os.local` + the `OS-Author-Email: synthesized` trailer.
 *   - Commits are serialised per domain and the store read is captured in the writer's turn, so
 *     two rapid writes produce two commits, each with its own author, action and state.
 *   - Server-only: reaches node:fs + isomorphic-git through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import {
  commitSubtree,
  commitMessage,
  authorFor,
  reserveSubtree,
  readBlob,
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import { OBJECTS_TRAILER, renderObjectsTrailer } from '@core/infra/git-trailers';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import { onSystemChange, type SystemChange } from '@tabs/agents/lib/system-events';
import { systemsForProject } from '@tabs/agents/lib/store';
import { projectSnapshot, snapshotSystem, type SnapshotSystem } from '@tabs/agents/lib/git/snapshot';
import { generateAgentFiles, AGENTS_PREFIX, placeSystems } from '@tabs/agents/lib/git/generate';

/** The surface recorded when a writer ran outside any request-surface scope. */
export const DEFAULT_SURFACE = 'ui:agents';

let override: boolean | null = null;

/** Part D's one switch — `DATA_PROJECT_GIT` (tests may pin it). */
export function agentProjectGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}

/** Test hook: pin the flag on/off (`null` = back to the environment). */
export function __setAgentProjectGitForTests(value: boolean | null): void {
  override = value;
}

export type ActorIdentity = { id: string; name?: string | null; email?: string | null };

export type CommitMeta = {
  action: string;
  /** Short object label for the subject (the system slug); defaults to the domain. */
  object?: string;
  /** `<id> (<name>)` for the OS-Object trailer; defaults to `object`. */
  objectId?: string;
  /** `ui:<route>` | `mcp:<tool>`; defaults to {@link DEFAULT_SURFACE}. */
  surface?: string;
  requestId?: string;
  /**
   * An extra `OS-Reason` trailer, for a commit whose CAUSE is not simply its action — today only
   * `boot-reconcile` (B1 spelled the per-write reason `OS-Action`, and that stays the convention).
   */
  reason?: string;
  /**
   * X-R1: this commit touched EVERY system in the subtree, not one — so list them all in an
   * `OS-Objects` trailer beside the single-valued `OS-Object`.
   *
   * WHY IT IS NEEDED. The boot reconcile commits one commit for the whole `agents/` subtree, with
   * `OS-Object: <domain>`. The history read-back (`systemGitInfo`) filters the repo log on
   * `OS-Object` matching the SYSTEM id, so for a system whose only commit is that reconcile — i.e.
   * every system that existed before git was switched on — the filter matched nothing and
   * `git.head` came back `null`, which the UI and `get_agent_system` render as "never committed".
   * That is a lie about a system that is in the repository.
   *
   * WHY A SECOND TRAILER RATHER THAN A REPEATED `OS-Object`. `parseTrailers` returns
   * `Record<string, string>` — a repeated key keeps only the last value, so N `OS-Object` lines
   * would attribute the commit to exactly one system. `OS-Objects` is a space-separated list of
   * ids, which survives `oneLine` and the trailer grammar unchanged.
   *
   * THE LIST INCLUDES SYSTEMS THE COMMIT **REMOVED** (review L-2). Built from the live snapshot
   * alone it named only what survives, so the one commit that matters most for a deleted
   * system — the one that deleted it — was the one commit its history could not find. The ids
   * already in the repo's `agents/index.yml` are unioned in, so a removal is attributed to the
   * system it removed.
   *
   * The complementary half — the path-based `git log -- <path>` fallback for the GENERIC object
   * read-back — is stream G's (`core/infra/git-objects.ts`, G-R2.1). Either alone fixes the
   * symptom; this one also makes the reconcile commit say what it actually did.
   */
  allObjects?: boolean;
};

export type SubtreeCommitter = (
  domain: string,
  prefix: string,
  files: Map<string, string>,
  opts: CommitTreeOptions,
) => Promise<CommitResult>;

export type CommitDeps = {
  reposDir?: string;
  /** Injected for tests; defaults to the git store's `commitSubtree`. */
  committer?: SubtreeCommitter;
  /** Push to the configured mirror after a changed commit (default true). */
  mirror?: boolean;
  /** The store read captured synchronously in the writer's turn (the hook passes it). */
  captured?: SnapshotSystem[];
};

/**
 * The system ids the repo's CURRENT `agents/index.yml` lists — i.e. what was there before this
 * commit. Unioned into `OS-Objects` so a commit that REMOVES a system is attributed to it
 * (review L-2); a removed system's own history otherwise missed the one commit that matters.
 *
 * Deliberately a line scan, not a YAML parse: the file is generated by `renderIndex`, which emits
 * exactly `    id: <token>` per entry, and a commit path must not fail because a hand-edited index
 * is malformed. Anything unreadable (no repo yet, no index yet, a bad blob) yields no extra ids —
 * never an exception into a writer.
 */
async function previousIndexIds(domain: string, reposDir: string): Promise<string[]> {
  try {
    const text = await readBlob(domain, 'main', `${AGENTS_PREFIX}index.yml`, { reposDir });
    return [...text.matchAll(/^\s+id:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/**
 * Regenerate `domain`'s `agents/**` subtree and commit it iff it changed. Returns null when the
 * flag is off. Never throws into a writer: the caller (the hook) logs.
 */
export async function commitAgentSystem(domain: string, actor: ActorIdentity, meta: CommitMeta, deps: CommitDeps = {}): Promise<CommitResult | null> {
  if (!agentProjectGitEnabled()) return null;
  const snapshot = projectSnapshot(domain, deps.captured);
  const files = generateAgentFiles(snapshot);
  const object = meta.object ?? domain;
  const message = commitMessage({
    area: 'agents',
    domain,
    action: meta.action,
    object,
    objectId: meta.objectId,
    surface: meta.surface ?? DEFAULT_SURFACE,
    requestId: meta.requestId ?? newRequestId(),
  });
  const reposDir = deps.reposDir ?? config.reposDir;
  // X-R1: a whole-subtree commit names every system it carried — the survivors from the snapshot
  // AND (review L-2) the ones this commit removes, read from the index still in the repo.
  let allObjects = '';
  if (meta.allObjects) {
    const ids = new Set(snapshot.systems.map((sy) => sy.id));
    for (const gone of await previousIndexIds(domain, reposDir)) ids.add(gone);
    const rendered = renderObjectsTrailer(ids);
    allObjects = rendered.value;
    // Review L-3: an id that cannot be written is NAMED. A silently missing attribution is the
    // defect X-R1 fixed, reintroduced quietly.
    if (rendered.skipped.length > 0) {
      console.warn(
        `[agent-projects] ${domain}: ${rendered.skipped.length} system id(s) carry whitespace and were left out of the ` +
          `${OBJECTS_TRAILER} trailer, so their history will not find this commit: ${rendered.skipped.map((i) => JSON.stringify(i)).join(', ')}`,
      );
    }
  }
  const { author, synthesized } = authorFor(actor);
  const commit = deps.committer ?? commitSubtree;
  const result = await commit(domain, AGENTS_PREFIX, files, {
    author,
    message,
    // `OS-Actor` carries the principal id even when the author name is a display name.
    trailers: {
      'OS-Actor': actor.id,
      ...(allObjects ? { [OBJECTS_TRAILER]: allObjects } : {}),
      ...(meta.reason ? { 'OS-Reason': meta.reason } : {}),
      ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
    },
    reposDir,
  });
  if (result.changed && deps.mirror !== false && !deps.committer) {
    const { pushMirrorAfterCommit } = await import('@core/infra/git-mirror');
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
export async function awaitAgentProjectCommits(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** The slug the change's system has in the tree (so the subject names the directory, not an id). */
function objectLabels(change: SystemChange, captured: SnapshotSystem[]): { object: string; objectId: string } {
  const placed = placeSystems({ domain: change.domain, systems: captured }).find((p) => p.system.id === change.systemId);
  const name = change.name?.trim();
  return {
    object: placed?.slug ?? change.systemId,
    objectId: name ? `${change.systemId} (${name})` : change.systemId,
  };
}

/** The state THIS write produced, read synchronously in the writer's turn. */
function capture(domain: string): SnapshotSystem[] {
  return domain ? systemsForProject(domain).map(({ rec, version }) => snapshotSystem(rec, version)) : [];
}

const chains = new Map<string, Promise<unknown>>();

/** Serialise commits per domain; a failure is logged, never thrown into the write. */
function queue(domain: string, run: () => Promise<void>, context: string): void {
  const prev = chains.get(domain) ?? Promise.resolve();
  const p = prev
    .then(run)
    .catch((e) => {
      console.error(`[agent-projects] commit failed for ${context} (${domain}): ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      inFlight.delete(p);
      if (chains.get(domain) === p) chains.delete(domain);
    });
  chains.set(domain, p);
  inFlight.add(p);
}

/**
 * Subscribe the commit path to the store's system-change events. Returns the unsubscribe
 * function. Also RESERVES the `agents/` subtree, so the data side's whole-tree commit keeps it.
 */
export function installAgentProjectCommitHook(deps: HookDeps = {}): () => void {
  reserveSubtree(AGENTS_PREFIX);
  return onSystemChange((change) => {
    if (!agentProjectGitEnabled()) return;
    const surface = currentSurface(); // read synchronously, in the writer's async context
    if (!surface && !warnedSurfaces.has(change.action)) {
      warnedSurfaces.add(change.action);
      console.warn(`[agent-projects] '${change.action}' reached the store outside a request-surface scope — recorded as ${DEFAULT_SURFACE}`);
    }
    const meta = (object: { object: string; objectId: string }) => ({
      action: change.action,
      ...object,
      surface: surface?.surface ?? DEFAULT_SURFACE,
      requestId: surface?.requestId,
    });
    const resolve = async (): Promise<ActorIdentity> => (deps.resolveActor ? deps.resolveActor(change.actorId) : { id: change.actorId });
    // A cross-domain move changes two repos: the OLD one loses the system, the NEW one gains it.
    // Both are committed, each from its own captured state, with the same action and actor.
    for (const domain of [change.previousDomain, change.domain]) {
      if (!domain) continue; // an unassigned system has no repo
      const captured = capture(domain);
      const labels = objectLabels(change, captured);
      queue(
        domain,
        async () => {
          await commitAgentSystem(domain, await resolve(), meta(labels), { ...deps, captured });
        },
        `${change.action} on ${change.systemId}`,
      );
    }
  });
}
