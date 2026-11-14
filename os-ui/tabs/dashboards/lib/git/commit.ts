/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `commitDashboards` — regenerate a domain's `dashboards/**` and commit it as the actor
 * USER STORY: As a user I want every change to a dashboard — created, edited, renamed, promoted,
 *             demoted, moved, archived, restored or deleted, from the UI or over the OS MCP — to be
 *             a git commit in my domain's repository, authored as me and naming the action and its
 *             origin (D8, D-R3.1).
 * ARCHITECTURE:
 *   - The single commit path for the Dashboards tab, the exact shape `tabs/data/lib/dbt/commit.ts`
 *     and `tabs/agents/lib/git/commit.ts` took. `installDashboardCommitHook` subscribes to the
 *     store's change events at boot (`instrumentation.ts`); each event → snapshot →
 *     `generateDashboardFiles` → `commitSubtree`, which commits only when the subtree changed.
 *   - ONE flag for the whole of this machinery: `config.dataProjectGit` (`DATA_PROJECT_GIT`). The
 *     repo, the PVC and the git-daemon sidecar it gates are the same ones this subtree lives in, so
 *     a second switch could only ever be wrong — the same reasoning (and the same historical env
 *     var name) the agents side recorded as its deviation D-2.
 *   - `commitSubtree` + a boot-time `reserveSubtree('dashboards/')`: the dbt generator writes the
 *     WHOLE tree, so without the reservation its next commit would delete `dashboards/**`.
 *   - Surface + request id come from the ambient request context (`core/infra/request-surface`),
 *     read SYNCHRONOUSLY in the listener, so the commit subject says `via mcp:create_dashboard` or
 *     `via ui:/api/dashboards/build`. A writer outside any surface scope is recorded as
 *     `ui:dashboards` and logged as a gap, never silently.
 *   - Actor name/e-mail come from an injected resolver (the admin user directory is another tab);
 *     an absent e-mail ⇒ `<id>@os.local` + the `OS-Author-Email: synthesized` trailer.
 *   - Commits are serialised per domain and the store read is captured in the writer's turn, so two
 *     rapid saves produce two commits, each with its own author, action and state.
 *   - Server-only: reaches node:fs through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import {
  appendTrailers,
  authorFor,
  commitSubtree,
  reserveSubtree,
  type CommitMessageInput,
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import { currentSurface, newRequestId } from '@core/infra/request-surface';
import { onDashboardChange, type DashboardChange } from '@tabs/dashboards/lib/dashboard-events';
import { DASHBOARDS_PREFIX, generateDashboardFiles, placeDashboards } from '@tabs/dashboards/lib/git/generate';
import { projectSnapshot, type SnapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';

/** The surface recorded when a writer ran outside any request-surface scope. */
export const DEFAULT_SURFACE = 'ui:dashboards';

/** The `<area>` half of the commit subject for this tab. */
export const AREA = 'dashboards';

/**
 * The commit subject + OS trailers for a dashboards commit, in the kernel's own format:
 * `dashboards(sales): create dashboard sales-overview — via mcp:create_dashboard` plus
 * `OS-Action` / `OS-Object` / `OS-Surface` / `OS-Request-Id` (and `OS-Run-Id` when a run caused it).
 *
 * WHY NOT `commitMessage` FROM THE GIT STORE: its `area` is typed `'data' | 'agents'`, and
 * `core/infra/git-store.ts` is owned tonight by two other streams (the tag API and the read/diff
 * API), so widening that union is a cross-stream change this stream may not make. This composes
 * the identical string through the store's own exported `appendTrailers`, and
 * `lib/git/commit.test.ts` asserts it is BYTE-IDENTICAL to `commitMessage` for the same input, so
 * the format cannot drift while the two live apart. Recorded as a cross-stream need: widen `area`
 * and delete this function.
 */
export function dashboardCommitMessage(input: Omit<CommitMessageInput, 'area'> & { runId?: string }): string {
  const oneLine = (v: string): string => String(v ?? '').replace(/\s+/g, ' ').trim();
  const subject = `${AREA}(${input.domain}): ${oneLine(input.action)} ${oneLine(input.object)} — via ${oneLine(input.surface)}`;
  return appendTrailers(subject, {
    'OS-Action': oneLine(input.action),
    'OS-Object': oneLine(input.objectId ?? input.object),
    'OS-Surface': oneLine(input.surface),
    'OS-Request-Id': oneLine(input.requestId),
    'OS-Run-Id': oneLine(input.runId ?? currentSurface()?.runId ?? ''),
  });
}

let override: boolean | null = null;

/** The one switch — `DATA_PROJECT_GIT` (tests may pin it). */
export function dashboardProjectGitEnabled(): boolean {
  return override ?? config.dataProjectGit;
}

/** Test hook: pin the flag on/off (`null` = back to the environment). */
export function __setDashboardProjectGitForTests(value: boolean | null): void {
  override = value;
}

export type ActorIdentity = { id: string; name?: string | null; email?: string | null };

export type CommitMeta = {
  action: string;
  /** Short object label for the subject (the dashboard slug); defaults to the domain. */
  object?: string;
  /** `<id> (<name>)` for the `OS-Object` trailer; defaults to `object`. */
  objectId?: string;
  /** `ui:<route>` | `mcp:<tool>`; defaults to {@link DEFAULT_SURFACE}. */
  surface?: string;
  requestId?: string;
  /** An extra `OS-Reason` trailer, for a commit whose CAUSE is not simply its action. */
  reason?: string;
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
  captured?: SnapshotDashboard[];
};

/**
 * Regenerate `domain`'s `dashboards/**` subtree and commit it iff it changed. Returns null when
 * the flag is off. Never throws into a writer: the caller (the hook) logs.
 */
export async function commitDashboards(
  domain: string,
  actor: ActorIdentity,
  meta: CommitMeta,
  deps: CommitDeps = {},
): Promise<CommitResult | null> {
  if (!dashboardProjectGitEnabled()) return null;
  const snapshot = projectSnapshot(domain, deps.captured ?? []);
  const files = generateDashboardFiles(snapshot);
  const object = meta.object ?? domain;
  const message = dashboardCommitMessage({
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
  const result = await commit(domain, DASHBOARDS_PREFIX, files, {
    author,
    message,
    // `OS-Actor` carries the principal id even when the author name is a display name.
    trailers: {
      'OS-Actor': actor.id,
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
  /**
   * Read the domain's dashboards. The store's own read is ASYNC because it resolves stream V's
   * lifecycle pins from a durable mirror (H-5); a test may inject a synchronous one.
   */
  capture?: (domain: string) => SnapshotDashboard[] | Promise<SnapshotDashboard[]>;
};

const inFlight = new Set<Promise<void>>();
const warnedSurfaces = new Set<string>();

/** Await every commit the hook has started (tests; shutdown). */
export async function awaitDashboardCommits(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** The slug the change's dashboard has in the tree, so the subject names the directory. */
function objectLabels(change: DashboardChange, captured: SnapshotDashboard[]): { object: string; objectId: string } {
  const placed = placeDashboards({ domain: change.domain, dashboards: captured }).find(
    (p) => p.dashboard.id === change.dashboardId,
  );
  const name = change.name?.trim();
  return {
    object: placed?.slug ?? change.dashboardId,
    objectId: name ? `${change.dashboardId} (${name})` : change.dashboardId,
  };
}

const chains = new Map<string, Promise<unknown>>();

/** Serialise commits per domain; a failure is logged, never thrown into the write. */
function queue(domain: string, run: () => Promise<void>, context: string): void {
  const prev = chains.get(domain) ?? Promise.resolve();
  const p = prev
    .then(run)
    .catch((e) => {
      console.error(
        `[dashboard-projects] commit failed for ${context} (${domain}): ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      inFlight.delete(p);
      if (chains.get(domain) === p) chains.delete(domain);
    });
  chains.set(domain, p);
  inFlight.add(p);
}

/** The default capture: the registry's own unscoped per-domain read, flattened for the file. */
async function defaultCapture(domain: string): Promise<SnapshotDashboard[]> {
  const { dashboardsForProject } = await import('@tabs/dashboards/lib/store');
  return dashboardsForProject(domain);
}

/**
 * Subscribe the commit path to the store's dashboard-change events. Returns the unsubscribe
 * function. Also RESERVES the `dashboards/` subtree, so the data side's whole-tree commit keeps it.
 */
export function installDashboardCommitHook(deps: HookDeps = {}): () => void {
  reserveSubtree(DASHBOARDS_PREFIX);
  return onDashboardChange((change) => {
    if (!dashboardProjectGitEnabled()) return;
    const surface = currentSurface(); // read synchronously, in the writer's async context
    if (!surface && !warnedSurfaces.has(change.action)) {
      warnedSurfaces.add(change.action);
      console.warn(
        `[dashboard-projects] '${change.action}' reached the store outside a request-surface scope — recorded as ${DEFAULT_SURFACE}`,
      );
    }
    const resolve = async (): Promise<ActorIdentity> =>
      deps.resolveActor ? deps.resolveActor(change.actorId) : { id: change.actorId };
    // A cross-domain move changes two repos: the OLD one loses the dashboard, the NEW one gains it.
    // Both are committed, each from its own captured state, with the same action and actor.
    const domains = [change.previousDomain, change.domain].filter((d): d is string => Boolean(d));
    const captures = new Map<string, SnapshotDashboard[] | Promise<SnapshotDashboard[]>>();
    for (const domain of domains) {
      // Started HERE, in the writer's turn, so the commit records the state THIS write produced
      // rather than whatever the store holds when the queue drains. The read itself may be async
      // (it resolves lifecycle pins), but it is STARTED synchronously, which is what matters.
      if (deps.capture) captures.set(domain, deps.capture(domain));
    }
    for (const domain of domains) {
      queue(
        domain,
        async () => {
          const captured = await (captures.get(domain) ?? defaultCapture(domain));
          const labels = objectLabels(change, captured);
          await commitDashboards(
            domain,
            await resolve(),
            {
              action: change.action,
              ...labels,
              surface: surface?.surface ?? DEFAULT_SURFACE,
              requestId: surface?.requestId,
            },
            { ...deps, captured },
          );
        },
        `${change.action} on ${change.dashboardId}`,
      );
    }
  });
}
