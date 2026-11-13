/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Read-back — the commit a system is at, and the last N commits that touched it
 * USER STORY: As an AI engineer I want the Agents tab and `get_agent_system` to tell me which
 *             commit my system is at, who authored it and when, and to show its recent history —
 *             read from the REPOSITORY, not from a parallel OS ledger (checklist A2/A3).
 * ARCHITECTURE:
 *   - Reads `core/infra/git-store.ts` `log` and filters by the `OS-Object` trailer, which carries
 *     `<systemId> (<name>)`: a rename, a move between lanes and even a delete therefore stay in
 *     one history, because the ID is the identity and the directory is only a slug.
 *   - There is NO second source of truth: `sha`, `author`, `at` come from the commit. When the
 *     flag is off, or the domain has no repo yet, the answer is an honest `null`.
 *   - Owner/scope gating is unchanged and happens BEFORE this is called (the caller has already
 *     passed `getSystem`), so this module performs no authorisation of its own.
 *   - Server-only: reaches node:fs through the git store.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { log, type GitStoreOptions } from '@core/infra/git-store';
import { agentProjectGitEnabled } from '@tabs/agents/lib/git/commit';

/** How many commits of a system's history are returned by default. */
export const DEFAULT_HISTORY = 10;

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
};

export type HistoryOptions = GitStoreOptions & { limit?: number; scan?: number };

/**
 * The repository view of one system. `scan` bounds how far back the repo log is read (the log is
 * the WHOLE domain repo — the dbt project commits too — so a system's own commits are filtered
 * out of it by trailer).
 */
export async function systemGitInfo(domain: string, systemId: string, opts: HistoryOptions = {}): Promise<SystemGitInfo | null> {
  if (!agentProjectGitEnabled() || !domain || !systemId) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_HISTORY, 100));
  const entries = await log(domain, { reposDir: opts.reposDir ?? config.reposDir, limit: Math.max(limit, opts.scan ?? 200) });
  const mine: SystemCommit[] = [];
  for (const e of entries) {
    const object = e.trailers['OS-Object'] ?? '';
    if (object !== systemId && !object.startsWith(`${systemId} `)) continue;
    mine.push({
      sha: e.sha,
      subject: e.subject,
      author: e.author.name,
      email: e.author.email,
      at: new Date(e.timestamp * 1000).toISOString(),
      action: e.trailers['OS-Action'],
      surface: e.trailers['OS-Surface'],
      requestId: e.trailers['OS-Request-Id'],
      actor: e.trailers['OS-Actor'],
      reason: e.trailers['OS-Reason'],
    });
    if (mine.length >= limit) break;
  }
  return { domain, head: mine[0] ?? null, history: mine };
}
