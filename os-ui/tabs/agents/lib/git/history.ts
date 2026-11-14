/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Read-back — the commit a system is at, and the last N commits that touched it
 * USER STORY: As an AI engineer I want the Agents tab and `get_agent_system` to tell me which
 *             commit my system is at, who authored it and when, and to show its recent history —
 *             read from the REPOSITORY, not from a parallel OS ledger (checklist A2/A3), through
 *             the SAME generic module every other object kind uses (checklist G3/G6).
 * ARCHITECTURE:
 *   - NO SECOND IMPLEMENTATION (night 2, stream G). This module is now a THIN adapter over
 *     `core/infra/git-objects.ts`: it supplies the agent-system repo paths and renames the generic
 *     result's fields to the shape the Agents tab's API already returns. The trailer filter, the
 *     path-scoped fallback, the bounded scan and the `truncated` honesty all live in @core, once.
 *   - THE PATH FALLBACK IS WHY `head` STOPPED BEING WRONG. A boot reconcile commits as the
 *     PLATFORM with `OS-Object: <domain>`, so a trailer-only lookup answered `null` for systems
 *     that plainly have files in the tree (night-1 F3-1). The generic reader merges a
 *     `git log -- agents/<lane>/<slug>/` fallback in, so a pre-existing system shows its real head.
 *   - `registerAgentSystemGitObject()` is the tab's half of the @core kind registry: the kernel
 *     may not import a tab, so the tab registers a resolver at boot (`instrumentation.ts`) that
 *     runs the tab's OWN governed read (`getSystem`) as the caller — an invisible system and a
 *     missing one both become the generic, byte-identical `not_found`.
 *   - Owner/scope gating for `systemGitInfo` itself is unchanged and happens BEFORE it is called
 *     (the caller has already passed `getSystem`), so this function performs no authorisation.
 *   - X-R1 / review H-2 (night 2, stream X), AND IT STILL HOLDS THROUGH THE ADAPTER: a
 *     WHOLE-SUBTREE commit (the boot reconcile) cannot name one system in `OS-Object`, so it lists
 *     every system it carried in `OS-Objects` (space-separated ids) and the read-back matches that
 *     too, on a WHOLE token — `sys_abc` must never match `sys_abcd`. The predicate is NOT local
 *     and not duplicated: it is `core/infra/git-trailers.ts` `trailersNameObject`, which
 *     `core/infra/git-objects.ts` now calls as well, so there is exactly ONE trailer parser and a
 *     rewrite of either side cannot lose the whole-token behaviour.
 *   - Server-only: reaches node:fs through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { MAX_LOG_DEPTH, type GitStoreOptions } from '@core/infra/git-store';
import {
  gitInfoForPaths,
  registerGitObject,
  type GitObjectLocation,
  type ObjectCommit,
  type GitInfoVia,
} from '@core/infra/git-objects';
import { agentProjectGitEnabled } from '@tabs/agents/lib/git/commit';
import { projectSnapshot } from '@tabs/agents/lib/git/snapshot';
import { placeSystems, AGENTS_PREFIX } from '@tabs/agents/lib/git/generate';
import { getSystem, type Principal } from '@tabs/agents/lib/store';

/** How many commits of a system's history are returned by default. */
export const DEFAULT_HISTORY = 10;
/** How far back the repo log is read when looking for a system's commits. */
export const DEFAULT_SCAN = 200;

export type SystemCommit = {
  sha: string;
  subject: string;
  author: string;
  email: string;
  /** ISO-8601, from the commit's author time. */
  at: string;
  action?: string;
  surface?: string;
  requestId?: string;
  actor?: string;
  reason?: string;
};

export type SystemGitInfo = {
  domain: string;
  /** The newest commit that touched this system (null when it has none yet). */
  head: SystemCommit | null;
  /** Newest first, at most `limit` entries. */
  history: SystemCommit[];
  /**
   * True when the scan window ended before `limit` of this system's commits were found — so
   * `history` is "what fits in the window", NOT "all there is".
   */
  truncated: boolean;
  /** Which source answered: the `OS-Object` trailer, the path fallback, both, or nothing. */
  via: GitInfoVia;
  /** The repo paths this system occupies — the `git log --` argument an engineer would type. */
  paths: string[];
};

export type HistoryOptions = GitStoreOptions & { limit?: number; scan?: number };

/**
 * The repo paths one system occupies: its own directory, and nothing else. `agents/index.yml` is
 * deliberately EXCLUDED — it changes whenever any system in the domain changes, so including it
 * would put every other system's commits into this one's history.
 */
export function systemRepoPaths(domain: string, systemId: string): string[] {
  if (!domain || !systemId) return [];
  try {
    const placed = placeSystems(projectSnapshot(domain)).find((p) => p.system.id === systemId);
    return placed ? [`${placed.dir}/`] : [];
  } catch {
    // An unreadable store is not a reason to guess at a path; the trailer lookup still works.
    return [];
  }
}

/** Where the generic reader should look for this system (no authorisation — see the header). */
export function systemGitLocation(domain: string, systemId: string, name?: string): GitObjectLocation {
  return { domain, paths: systemRepoPaths(domain, systemId), trailerId: systemId, ...(name ? { name } : {}) };
}

function toSystemCommit(c: ObjectCommit): SystemCommit {
  return {
    sha: c.sha,
    subject: c.subject,
    author: c.author,
    email: c.email,
    at: c.at,
    ...(c.action ? { action: c.action } : {}),
    ...(c.surface ? { surface: c.surface } : {}),
    ...(c.requestId ? { requestId: c.requestId } : {}),
    ...(c.actor ? { actor: c.actor } : {}),
    ...(c.reason ? { reason: c.reason } : {}),
  };
}

/**
 * The repository view of one system. `scan` bounds how far back the repo log is read (the log is
 * the WHOLE domain repo), and the generic reader falls back to this system's own paths when no
 * commit's trailer names it.
 */
export async function systemGitInfo(domain: string, systemId: string, opts: HistoryOptions = {}): Promise<SystemGitInfo | null> {
  if (!agentProjectGitEnabled() || !domain || !systemId) return null;
  const reposDir = opts.reposDir ?? config.reposDir;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_HISTORY, 100));
  const scan = Math.max(limit, Math.min(opts.scan ?? DEFAULT_SCAN, MAX_LOG_DEPTH));
  const info = await gitInfoForPaths('agent-system', systemId, systemGitLocation(domain, systemId), { reposDir, limit, scan });
  return {
    domain,
    head: info.head ? toSystemCommit(info.head) : null,
    history: info.history.map(toSystemCommit),
    truncated: info.truncated,
    via: info.via,
    paths: info.paths,
  };
}

/**
 * Register the agent-system kind with the @core versioning registry. Called once at boot. The
 * resolver runs the tab's own governed read as the CALLER: a system the caller may not see throws,
 * and `core/infra/git-objects.ts` turns that into the same `not_found` a missing id gets.
 */
export function registerAgentSystemGitObject(): void {
  registerGitObject('agent-system', (user, id) => {
    const view = getSystem(id, user as unknown as Principal);
    return systemGitLocation(view.domain ?? '', view.id, view.name);
  });
}

/** The prefix the whole kind lives under — exported so a caller need not import the generator. */
export const AGENT_SYSTEMS_PREFIX = AGENTS_PREFIX;
