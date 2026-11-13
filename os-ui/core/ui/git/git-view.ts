/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The git badge and history drawer, as testable logic (the `.tsx` are shells)
 * USER STORY: As any user I want one consistent "git head" line and one history drawer across
 *             the Data, KPI, Dashboards, Agents and Software detail headers — showing the sha,
 *             who committed it, when, which action and from which surface, with the per-commit
 *             diff and an honest state for "restore is not available" (checklist G6).
 * ARCHITECTURE:
 *   - A test cannot import a `.tsx` (ARCHITECTURE.md), so EVERY decision lives here: what the
 *     badge says, what the drawer rows say, how a unified diff becomes display rows, and which
 *     of the four restore states applies. `GitHeadBadge.tsx` / `HistoryDrawer.tsx` only render.
 *   - PARAPHRASES NOTHING. The sha is the sha, the action and surface are the commit trailers,
 *     the diff rows are the patch's own lines. A commit the OS made for its own reasons
 *     (`OS-Reason: boot-reconcile`) is LABELLED as such rather than shown as somebody's edit.
 *   - The API shapes mirror `core/infra/git-objects.ts` exactly; this module re-declares them
 *     structurally so a client component never imports a `server-only` module.
 */

/** One commit, as `/api/git?action=history` returns it (mirrors `ObjectGitInfo.history[]`). */
export type GitCommitView = {
  sha: string;
  subject: string;
  author: string;
  email: string;
  at: string;
  action?: string;
  surface?: string;
  requestId?: string;
  actor?: string;
  reason?: string;
  runId?: string;
};

export type GitInfoView = {
  kind: string;
  id: string;
  domain: string;
  name?: string;
  paths: string[];
  head: GitCommitView | null;
  history: GitCommitView[];
  truncated: boolean;
  via: 'trailer' | 'path' | 'trailer+path' | 'none';
};

/** The short sha the whole OS shows — seven characters, like git's own default. */
export function sha7(sha: string): string {
  return String(sha ?? '').slice(0, 7);
}

/**
 * "just now" / "4 min ago" / "3 h ago" / "2 d ago" / an ISO date beyond a month. `now` is
 * injected so this is testable and so a server render and a client render can agree.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 0) return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** What the badge shows: `9c1f2ab · Amir Example · 3 h ago`, plus a full tooltip. */
export type BadgeView = {
  /** Null when there is no commit at all — the badge renders its own honest empty state. */
  label: string | null;
  title: string;
  /** True when the commit was made by the platform, not by a person. */
  platform: boolean;
  /** The one-line reason the badge is empty, when it is. */
  empty?: string;
};

export function badgeView(info: GitInfoView | null, now: number = Date.now()): BadgeView {
  if (!info) {
    return { label: null, title: 'The OS is not committing this object to git (or the repository could not be read).', platform: false, empty: 'not in git' };
  }
  if (!info.head) {
    return {
      label: null,
      title: info.domain
        ? `No commit in ${info.domain} touches this object yet. Nothing is hidden: the repository simply has no version of it.`
        : 'This object has no domain repository yet, so it has no versions.',
      platform: false,
      empty: info.domain ? 'no commit yet' : 'no repository yet',
    };
  }
  const head = info.head;
  const platform = head.reason === 'boot-reconcile';
  const parts = [
    `${sha7(head.sha)}${platform ? ' (OS catch-up)' : ''}`,
    head.author,
    relativeTime(head.at, now),
  ].filter((p) => p.length > 0);
  const title = [
    head.sha,
    head.subject,
    head.action ? `action: ${head.action}` : '',
    head.surface ? `via ${head.surface}` : '',
    head.actor ? `actor: ${head.actor}` : '',
    platform ? 'reason: boot-reconcile — the OS caught the repository up, this was not a person\'s edit' : '',
    info.paths.length > 0 ? `git log -- ${info.paths.join(' ')}` : '',
  ]
    .filter((p) => p.length > 0)
    .join('\n');
  return { label: parts.join(' · '), title, platform };
}

/** One drawer row: what happened, who did it, where from, and whether it was the OS itself. */
export type HistoryRow = {
  sha: string;
  short: string;
  when: string;
  at: string;
  author: string;
  /** The action trailer, falling back to the commit subject — never an invented verb. */
  action: string;
  /** `ui:<route>` / `mcp:<tool>` / `boot:reconcile`, or '' when the commit carries none. */
  surface: string;
  platform: boolean;
  runId?: string;
  requestId?: string;
};

export function historyRows(info: GitInfoView | null, now: number = Date.now()): HistoryRow[] {
  if (!info) return [];
  return info.history.map((c) => ({
    sha: c.sha,
    short: sha7(c.sha),
    when: relativeTime(c.at, now),
    at: c.at,
    author: c.author,
    action: c.action ?? c.subject,
    surface: c.surface ?? '',
    platform: c.reason === 'boot-reconcile',
    ...(c.runId ? { runId: c.runId } : {}),
    ...(c.requestId ? { requestId: c.requestId } : {}),
  }));
}

/** The line under the drawer's title: where this object lives, and whether the list is complete. */
export function drawerFooter(info: GitInfoView | null): string {
  if (!info) return 'Not in git.';
  const where = info.paths.length > 0 ? `${info.domain}: ${info.paths.join(', ')}` : info.domain || 'no repository yet';
  const complete = info.truncated
    ? 'The scan window ran out — these are the commits that fitted, not the whole history.'
    : 'This is the complete history the scan window covers.';
  const via =
    info.via === 'path'
      ? 'Found by path (no commit names this object in its OS-Object trailer — typically an OS catch-up commit).'
      : info.via === 'trailer+path'
        ? 'Found by commit trailer and by path.'
        : info.via === 'trailer'
          ? 'Found by commit trailer.'
          : '';
  return [where, complete, via].filter((s) => s.length > 0).join(' · ');
}

// ----------------------------------------------------------------- the diff ---

export type DiffRowKind = 'file' | 'hunk' | 'add' | 'remove' | 'context' | 'note';
export type DiffRow = { kind: DiffRowKind; text: string };

/** One changed file of a version diff, as `/api/git?action=diff` returns it. */
export type FileDiffView = { path: string; status: 'added' | 'modified' | 'removed'; patch: string };

/**
 * Turn a unified patch into typed display rows. The rows ARE the patch's lines — this classifies
 * them, it never rewrites them, so what the drawer shows is what `git diff` would print.
 */
export function diffRows(patch: string): DiffRow[] {
  const out: DiffRow[] = [];
  for (const line of String(patch ?? '').split('\n')) {
    if (line === '' && out.length > 0) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) out.push({ kind: 'file', text: line });
    else if (line.startsWith('@@')) out.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) out.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) out.push({ kind: 'remove', text: line });
    else if (line.startsWith('\\')) out.push({ kind: 'note', text: line });
    else out.push({ kind: 'context', text: line });
  }
  return out;
}

/** `3 files changed, 12 insertions(+), 4 deletions(-)` — git's own summary line. */
export function diffSummary(files: FileDiffView[]): string {
  if (files.length === 0) return 'No change: the object is byte-identical at both commits.';
  let added = 0;
  let removed = 0;
  for (const f of files) {
    for (const row of diffRows(f.patch)) {
      if (row.kind === 'add' && !row.text.startsWith('+++')) added++;
      if (row.kind === 'remove' && !row.text.startsWith('---')) removed++;
    }
  }
  const plural = files.length === 1 ? 'file' : 'files';
  return `${files.length} ${plural} changed, ${added} insertion${added === 1 ? '' : 's'}(+), ${removed} deletion${removed === 1 ? '' : 's'}(-)`;
}

// -------------------------------------------------------------- the restore ---

export type RestoreState = 'available' | 'unsupported' | 'head' | 'refused';

export type RestoreView = {
  state: RestoreState;
  /** The button label, or null when no button should be rendered at all. */
  label: string | null;
  disabled: boolean;
  /** Why, in the user's words. Never empty for a disabled or refused state. */
  note: string;
  /** The exact phrase the confirm dialog asks for, when a restore is possible. */
  phrase?: string;
};

/**
 * Which of the four restore states applies. `restorable` comes from the server (whether the
 * object's tab has registered its writer) — the UI never guesses, and a refusal is shown as a
 * refusal rather than as a missing button.
 */
export function restoreView(args: { info: GitInfoView | null; sha: string; restorable: boolean; error?: string }): RestoreView {
  const { info, sha, restorable, error } = args;
  if (error) return { state: 'refused', label: 'Restore this version', disabled: true, note: error };
  if (!info || !info.head || !sha) {
    return { state: 'unsupported', label: null, disabled: true, note: 'There is no version to restore.' };
  }
  if (sha === info.head.sha) {
    return { state: 'head', label: 'Restore this version', disabled: true, note: 'This IS the current version.' };
  }
  if (!restorable) {
    return {
      state: 'unsupported',
      label: 'Restore this version',
      disabled: true,
      note:
        'Restoring this kind of object is not available yet. A restore must go back through the object\'s own write path — ' +
        'the OS will not rewrite history or write around the usual validations and approvals.',
    };
  }
  return {
    state: 'available',
    label: 'Restore this version',
    disabled: false,
    note: `Re-applies ${sha7(sha)} through the normal write path. It becomes a NEW commit on top — nothing in the history is rewritten.`,
    phrase: `restore ${sha7(sha)}`,
  };
}

// -------------------------------------------------------------- the releases ---

/** One release tag, as the tag API returns it once it lands (`app/<slug>/v<x.y.z>`). */
export type ReleaseView = { tag: string; sha: string; at?: string; author?: string; message?: string };

export type ReleaseListView = {
  /** False ⇒ render nothing at all: the tag API is not available in this build. */
  visible: boolean;
  rows: { tag: string; version: string; short: string; when: string; author: string; message: string }[];
  note: string;
};

/**
 * The release panel. HIDDEN — not empty — when the tag API is absent, because an empty
 * "Releases" panel reads as "this app has no releases", which is a different claim.
 */
export function releaseListView(args: { available: boolean; releases: ReleaseView[]; now?: number }): ReleaseListView {
  if (!args.available) return { visible: false, rows: [], note: '' };
  const now = args.now ?? Date.now();
  const rows = args.releases.map((r) => ({
    tag: r.tag,
    version: r.tag.split('/').pop() ?? r.tag,
    short: sha7(r.sha),
    when: r.at ? relativeTime(r.at, now) : '',
    author: r.author ?? '',
    message: r.message ?? '',
  }));
  return {
    visible: true,
    rows,
    note: rows.length === 0 ? 'No release tag yet. A release is an annotated tag on the commit it was cut from.' : '',
  };
}
