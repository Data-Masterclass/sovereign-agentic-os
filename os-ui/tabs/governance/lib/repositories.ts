/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        governance
 * FEATURE:    Governance → Repositories — one row per domain repository, with its mirror health
 * USER STORY: As an operator I want to see every domain repository the OS writes: where its head
 *             is, how many commits it has, who made the last one, whether the push-mirror is
 *             healthy, and which object kinds live at which paths — so "everything is in git" is
 *             something I can verify rather than take on trust (checklist G10).
 * ARCHITECTURE:
 *   - PURE view logic over the `/api/git?action=repos` payload (which is itself `repoSummaries()`
 *     plus the EXISTING `git-mirror` health record — no second health source, no new state).
 *   - The mirror status is three words and never flattering: `ok` only when the last push
 *     succeeded AT the current head; `behind` when it succeeded at an older one; `failed` when
 *     the last attempt failed, carrying the real error; `none` when no mirror is configured.
 *   - Lives in `.ts` because a test cannot import the `.tsx` that renders it.
 */

export type MirrorSignalView = {
  domain: string;
  url: string;
  lastSha?: string;
  lastPushedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
};

/** One repository as `/api/git?action=repos` returns it. */
export type RepoRow = {
  domain: string;
  head: string | null;
  commits: number;
  countTruncated: boolean;
  lastAuthor: string | null;
  lastSubject: string | null;
  lastAt: string | null;
  mirror: MirrorSignalView | null;
};

export type MirrorState = 'ok' | 'behind' | 'failed' | 'none';

export type RepoView = {
  domain: string;
  /** `9c1f2ab`, or '—' for a repository with no commit yet. */
  head: string;
  commits: string;
  lastAuthor: string;
  lastSubject: string;
  lastAt: string;
  mirror: MirrorState;
  /** One line about the mirror, always true, never reassuring by default. */
  mirrorDetail: string;
  /** The clone URL an engineer would use for this repo, read-only. */
  cloneHint: string;
};

/** The mirror's real state for one repository — judged against the repo's CURRENT head. */
export function mirrorState(row: RepoRow): { state: MirrorState; detail: string } {
  const m = row.mirror;
  if (!m) return { state: 'none', detail: 'No push-mirror configured. The repository lives only on the OS volume.' };
  if (m.lastError) {
    return { state: 'failed', detail: `Last push FAILED${m.lastErrorAt ? ` at ${m.lastErrorAt}` : ''}: ${m.lastError}` };
  }
  if (!m.lastSha) return { state: 'behind', detail: `Configured (${m.url}) but nothing has been pushed yet.` };
  if (row.head && m.lastSha !== row.head) {
    return {
      state: 'behind',
      detail: `Pushed up to ${m.lastSha.slice(0, 7)}${m.lastPushedAt ? ` at ${m.lastPushedAt}` : ''} — the repository is now at ${row.head.slice(0, 7)}. The next commit retries the push.`,
    };
  }
  return { state: 'ok', detail: `Mirrored to ${m.url} at ${m.lastSha.slice(0, 7)}${m.lastPushedAt ? ` (${m.lastPushedAt})` : ''}.` };
}

/** The rows the table renders, sorted by domain. */
export function repoViews(rows: RepoRow[], gitDaemonHost = 'os-ui.agentic-os.svc.cluster.local'): RepoView[] {
  return [...rows]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((row) => {
      const { state, detail } = mirrorState(row);
      return {
        domain: row.domain,
        head: row.head ? row.head.slice(0, 7) : '—',
        commits: row.countTruncated ? `${row.commits}+` : String(row.commits),
        lastAuthor: row.lastAuthor ?? '—',
        lastSubject: row.lastSubject ?? '—',
        lastAt: row.lastAt ?? '',
        mirror: state,
        mirrorDetail: detail,
        cloneHint: `git clone git://${gitDaemonHost}/${row.domain}.git`,
      };
    });
}

/** The badge class the table uses for a mirror state (the OS's existing badge vocabulary). */
export function mirrorBadgeClass(state: MirrorState): string {
  return state === 'ok' ? 'ok' : state === 'failed' ? 'err' : state === 'behind' ? 'warn' : '';
}

/** One roll-up line above the table — counts only, and it says when there is nothing. */
export function repoSummaryLine(rows: RepoRow[]): string {
  if (rows.length === 0) {
    return 'No domain repository exists yet. One is created the first time a dataset, KPI, dashboard, agent system or app is saved in a domain.';
  }
  const views = repoViews(rows);
  const failed = views.filter((v) => v.mirror === 'failed').length;
  const behind = views.filter((v) => v.mirror === 'behind').length;
  const commits = rows.reduce((n, r) => n + r.commits, 0);
  const parts = [`${rows.length} repositor${rows.length === 1 ? 'y' : 'ies'}`, `${commits} commits`];
  if (failed > 0) parts.push(`${failed} mirror push${failed === 1 ? '' : 'es'} FAILING`);
  if (behind > 0) parts.push(`${behind} mirror${behind === 1 ? '' : 's'} behind`);
  return parts.join(' · ');
}

/** One layout row, as the API serialises `GIT_OBJECT_LAYOUT`. */
export type LayoutRow = {
  kind: string;
  label: string;
  paths: string[];
  personalLane: string | null;
  writer: { state: 'committed'; via: string; since: string } | { state: 'landing'; via: string; stream: string } | { state: 'backlog'; reason: string };
};

export type LayoutView = {
  kind: string;
  label: string;
  paths: string;
  personalLane: string;
  /** `in git`, `landing`, or `not in git yet` — the user-facing word for the writer state. */
  status: 'in git' | 'landing' | 'not in git yet';
  /** The reason or the writer module, so the claim is checkable. */
  detail: string;
};

/** The layout table, as the section renders it — the same data the enumeration test gates. */
export function layoutViews(rows: LayoutRow[]): LayoutView[] {
  return rows.map((r) => ({
    kind: r.kind,
    label: r.label,
    paths: r.paths.join(', '),
    personalLane: r.personalLane ?? '—',
    status: r.writer.state === 'committed' ? 'in git' : r.writer.state === 'landing' ? 'landing' : 'not in git yet',
    detail:
      r.writer.state === 'committed'
        ? `${r.writer.via} (since ${r.writer.since})`
        : r.writer.state === 'landing'
          ? `${r.writer.via} — lands with ${r.writer.stream}`
          : r.writer.reason,
  }));
}


// ------------------------------------------------------------- commit log ---

/** One commit of a repository's log, as `/api/git?action=repolog` returns it. */
export type RepoCommit = {
  sha: string;
  subject: string;
  author: string;
  at: string;
  action?: string;
  surface?: string;
  object?: string;
  reason?: string;
};

export type RepoCommitView = {
  sha: string;
  short: string;
  author: string;
  at: string;
  /** The action trailer, falling back to the subject — never an invented verb. */
  action: string;
  surface: string;
  /** The `OS-Object` trailer: which object this commit was about. */
  object: string;
  /** True when the OS made this commit for its own reasons, not a person. */
  platform: boolean;
};

export function repoCommitViews(commits: RepoCommit[]): RepoCommitView[] {
  return commits.map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    author: c.author,
    at: c.at,
    action: c.action || c.subject,
    surface: c.surface || '—',
    object: c.object || '—',
    platform: c.reason === 'boot-reconcile',
  }));
}
