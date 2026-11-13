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
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
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
  const { author, synthesized } = authorFor(actor);
  const reposDir = deps.reposDir ?? config.reposDir;
  const commit = deps.committer ?? commitSubtree;
  const result = await commit(domain, AGENTS_PREFIX, files, {
    author,
    message,
    // `OS-Actor` carries the principal id even when the author name is a display name.
    trailers: { 'OS-Actor': actor.id, ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}) },
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
