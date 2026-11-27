/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - a developer's push is never rejected for skipping the diff card, and never silently agreed
 * USER STORY: As a business owner I want a story edited in VS Code, or code pushed without naming a story, to show up as
 *             a card someone must approve, and the app to be blocked from going live to the domain or the company until
 *             that happened.
 * ARCHITECTURE:
 *   - Spec section 5, "developer push". A receive hook (`posthoc-proposals`, registered on import; app-receive runs hooks
 *     only with the App Builder switch on, and this hook only for template v2 apps):
 *       1. a push that changes story or epic files → ONE post-hoc card (`posthoc: true`, `source: 'git'`,
 *          `commitShas` = the pushed commits oldest first, the pushed files as its change; the files are already in git,
 *          so approving commits nothing);
 *       2. a push with ANY commit that changes this app's code without naming an AGREED story of this app (story-ref.ts
 *          `validStoryRefs`) → a "change without a story" card (`classification: 'code-change'`, empty change, the code
 *          paths in its summary). EVERY commit of the pushed range is read from git (the receive input's `fromSha`), never
 *          only the head; a range that cannot be read completely (longer than MAX_RANGE_COMMITS, unknown start) counts as
 *          storyless. The chat offers to turn the card into a story change; no model runs inside the push.
 *     Either keeps the card id in `App.unreviewed` until it is approved. A REJECTED one stays until git shows the change
 *     undone: every path it touched holds again the blob it had before the rejected push (the parent of its first
 *     commit). A commit message is never evidence of a revert.
 *   - `unreviewedBlocksGoLive(app, scope)`: Domain/Company ⇒ the refusal naming the cards; My ⇒ never blocked (its rule
 *     is "no review"). Called by the go-live path (C2's release go-live and F's lifecycle `canGoLive`; see the plan).
 *   - The hook reads the push input and the pushed commits' messages and tree ids; it never reads secrets and never
 *     calls a model.
 */
import 'server-only';
import type { ReceiveHookInput } from '@tabs/software/lib/receive-hooks';
import { registerReceiveHook } from '@tabs/software/lib/receive-hooks';
import type { GoLiveScope } from '@core/policy/go-live-rules';
import type { Classification, SpecProposal, StoryId, EpicId } from '@tabs/software/lib/app-builder-contracts';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { classifyStoryPath } from '@tabs/software/lib/stories/files';
import { APPS_DIR } from '@core/infra/repo-layout';
import { appRelativePath, codePaths, validStoryRefs } from '@tabs/software/lib/stories/story-ref';

export const POSTHOC_HOOK = 'posthoc-proposals';
const SUMMARY_PATHS = 12;

/** Domain/Company go-live refused while unreviewed changes exist (spec 5 and 9); My is never blocked. */
export function unreviewedBlocksGoLive(app: Pick<App, 'name' | 'unreviewed'>, scope: GoLiveScope): string | null {
  if (scope === 'my') return null;
  const ids = app.unreviewed ?? [];
  if (ids.length === 0) return null;
  return `“${app.name}” has unreviewed changes (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}): approve or revert them before it goes live in ${scope === 'domain' ? 'the domain' : 'the company'}`;
}

type Changed = ReceiveHookInput['changed'][number];

/** What a story-file push is, for the card's label: the most significant change wins. Pure. */
export function posthocClassification(changed: Changed[]): { classification: Classification; targetId?: StoryId | EpicId } {
  const rows = changed.map((f) => ({ f, c: classifyStoryPath(appRelativePath(f.path)) })).filter((r) => r.c && r.c.kind !== 'readme');
  const epicAdded = rows.find((r) => r.c!.kind === 'epic' && r.f.status === 'added');
  if (epicAdded) return { classification: 'new-epic', targetId: (epicAdded.c as { epic: EpicId }).epic };
  const storyAdded = rows.find((r) => r.c!.kind === 'story' && r.f.status === 'added');
  if (storyAdded) return { classification: 'new-story', targetId: (storyAdded.c as { story: StoryId }).story };
  const story = rows.find((r) => r.c!.kind === 'story');
  if (story) return { classification: 'refine-story', targetId: (story.c as { story: StoryId }).story };
  const epic = rows.find((r) => r.c!.kind === 'epic');
  return { classification: 'refine-epic', ...(epic ? { targetId: (epic.c as { epic: EpicId }).epic } : {}) };
}

// ------------------------------------------------------------- the pushed range ---

/** One pushed commit: its message and the app-relative paths of THIS app it changed against its first parent. */
export type PushedCommit = { sha: string; message: string; appPaths: string[] };
/** The pushed commits, oldest first. `complete` = every commit between the old head and the new one was read. */
export type PushRange = { commits: PushedCommit[]; complete: boolean };

/** Most commits of one push the hook reads; a longer push is judged storyless (it could not check every commit). */
export const MAX_RANGE_COMMITS = 50;

/** The git reads the hook needs, injectable for tests (default: the domain repository through git-store). */
export type PosthocGit = {
  /** The commits from `fromSha` (exclusive; null = unknown) to `toSha`, with this app's changed paths. */
  range: (domain: string, slug: string, fromSha: string | null, toSha: string) => Promise<PushRange>;
  /** First parent of a commit, or null (root / unknown). */
  parentOf: (domain: string, sha: string) => Promise<string | null>;
  /** path (app-relative) → blob oid of this app's files at `ref`. */
  appTree: (domain: string, slug: string, ref: string) => Promise<Map<string, string>>;
};

/**
 * The commits a push carries, read from git. Every commit's message counts — never only the head's. Pure over its
 * injected reads.
 */
export const defaultPosthocGit: PosthocGit = {
  async range(domain, slug, fromSha, toSha) {
    const { commitAt } = await import('@core/infra/git-store');
    const { config } = await import('@core/kernel/config');
    const opts = { reposDir: config.reposDir };
    const out: PushedCommit[] = [];
    let sha: string | null = toSha;
    while (sha && sha !== fromSha && out.length < MAX_RANGE_COMMITS) {
      const e = await commitAt(domain, sha, opts);
      if (!e) return { commits: out.reverse(), complete: false };
      const parent = e.parents[0] ?? null;
      const now = await this.appTree(domain, slug, e.sha);
      const before = parent ? await this.appTree(domain, slug, parent) : new Map<string, string>();
      const paths = new Set<string>();
      for (const [p, oid] of now) if (before.get(p) !== oid) paths.add(p);
      for (const p of before.keys()) if (!now.has(p)) paths.add(p);
      out.push({ sha: e.sha, message: e.message, appPaths: [...paths] });
      sha = parent;
    }
    // Complete only when the walk reached the old head (or, for a new branch, the root).
    const complete = sha === fromSha || (fromSha === null && sha === null);
    return { commits: out.reverse(), complete };
  },
  async parentOf(domain, sha) {
    const { commitAt } = await import('@core/infra/git-store');
    const { config } = await import('@core/kernel/config');
    const e = await commitAt(domain, sha, { reposDir: config.reposDir });
    return e?.parents[0] ?? null;
  },
  async appTree(domain, slug, ref) {
    const { listTree } = await import('@core/infra/git-store');
    const { config } = await import('@core/kernel/config');
    const prefix = `${APPS_DIR}/${slug}/`;
    const entries = await listTree(domain, ref, { reposDir: config.reposDir });
    return new Map(entries.filter((e) => e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e.oid]));
  },
};

/**
 * The shas of pushed commits that change code without naming an AGREED story of this app. When the range is not
 * complete, the push cannot be shown to be referenced commit by commit, so it counts as storyless. Pure.
 */
export function storylessShas(range: PushRange, agreed: ReadonlySet<string>): string[] {
  const bad = range.commits.filter((c) => codePaths(c.appPaths).length > 0 && validStoryRefs(c.message, agreed).length === 0).map((c) => c.sha);
  if (!range.complete && bad.length === 0 && range.commits.some((c) => codePaths(c.appPaths).length > 0)) return range.commits.map((c) => c.sha);
  return bad;
}

/** The post-hoc cards one push creates (pure; ids and time injected). `commitShas` = the pushed commits, oldest first. */
export function posthocProposals(
  i: { appId: string; sha: string; pusher?: { id?: string }; changed: Changed[]; range: PushRange; agreed: ReadonlySet<string> },
  mint: () => string,
  now: string,
): SpecProposal[] {
  const out: SpecProposal[] = [];
  const pusher = i.pusher?.id ?? 'git';
  const shas = i.range.commits.length > 0 ? i.range.commits.map((c) => c.sha) : [i.sha];
  const spec = i.changed.filter((f) => {
    const c = classifyStoryPath(appRelativePath(f.path));
    return c && c.kind !== 'readme';
  });
  if (spec.length > 0) {
    const writes = spec.filter((f) => f.status !== 'deleted' && typeof f.content === 'string').map((f) => ({ path: appRelativePath(f.path), content: f.content as string }));
    const deletes = spec.filter((f) => f.status === 'deleted').map((f) => appRelativePath(f.path));
    const { classification, targetId } = posthocClassification(spec);
    out.push({
      id: mint(),
      appId: i.appId,
      classification,
      ...(targetId ? { targetId } : {}),
      rationale: `pushed from git by ${pusher} without a diff card`,
      confidence: 1,
      alternatives: [],
      change: { writes, deletes, summary: `story files pushed in ${i.sha.slice(0, 12)}: ${spec.slice(0, SUMMARY_PATHS).map((f) => appRelativePath(f.path)).join(', ')}`.slice(0, 500) },
      source: 'git',
      posthoc: true,
      commitShas: shas,
      requestedBy: pusher,
      status: 'pending',
      createdAt: now,
    });
  }
  const storyless = storylessShas(i.range, i.agreed);
  if (storyless.length > 0) {
    const code = codePaths(i.changed.map((f) => appRelativePath(f.path)));
    const why = i.range.complete ? `${storyless.length} commit(s) change code without naming an agreed story` : `the push is longer than ${MAX_RANGE_COMMITS} commits or its start is unknown, so not every commit could be checked`;
    out.push({
      id: mint(),
      appId: i.appId,
      classification: 'code-change',
      rationale: `change without a story: code pushed from git by ${pusher}; ${why} (no "Story: US-n" trailer or [US-n] reference to an agreed story)`,
      confidence: 1,
      alternatives: [],
      change: { writes: [], deletes: [], summary: `code changed in ${i.sha.slice(0, 12)} without a story: ${code.slice(0, SUMMARY_PATHS).join(', ')}${code.length > SUMMARY_PATHS ? ` and ${code.length - SUMMARY_PATHS} more` : ''}`.slice(0, 500) },
      source: 'git',
      posthoc: true,
      commitShas: shas,
      requestedBy: pusher,
      status: 'pending',
      createdAt: now,
    });
  }
  return out;
}

/**
 * The paths a rejected card's change touched, judged by git: story cards the files they wrote and deleted; code cards
 * every code path that differs between the pre-push state and the card's last commit.
 */
function affectedPaths(p: SpecProposal, base: Map<string, string>, pushed: Map<string, string>): string[] {
  if (p.classification !== 'code-change') return [...p.change.writes.map((w) => w.path), ...p.change.deletes];
  const all = new Set([...base.keys(), ...pushed.keys()]);
  return codePaths([...all].filter((path) => base.get(path) !== pushed.get(path)));
}

/** True when every affected path holds exactly its pre-push blob again (absent stays absent). Pure. */
export function restoredToBase(paths: string[], base: Map<string, string>, now: Map<string, string>): boolean {
  return paths.length > 0 && paths.every((path) => base.get(path) === now.get(path));
}

/**
 * Rejected, still-unreviewed post-hoc cards that the tree at `head` has reverted: every path the card's change touched
 * holds the blob it had BEFORE the rejected push (the parent of the card's first commit), read from git. A commit
 * message saying "revert" proves nothing, and a one-character edit is not a revert.
 */
export async function revertedCards(domain: string, slug: string, head: string, cards: SpecProposal[], git: PosthocGit): Promise<Set<string>> {
  const out = new Set<string>();
  if (cards.length === 0) return out;
  const now = await git.appTree(domain, slug, head);
  for (const p of cards) {
    const shas = p.commitShas ?? [];
    if (shas.length === 0) continue;
    try {
      const baseSha = await git.parentOf(domain, shas[0]);
      const base = baseSha ? await git.appTree(domain, slug, baseSha) : new Map<string, string>();
      const pushed = await git.appTree(domain, slug, shas[shas.length - 1]);
      if (restoredToBase(affectedPaths(p, base, pushed), base, now)) out.add(p.id);
    } catch {
      // Unreadable history: the card stays unreviewed (blocking is the safe direction), and the next push re-checks.
      continue;
    }
  }
  return out;
}

/**
 * The unreviewed set after a push: every pending post-hoc card, plus every rejected one that was unreviewed before and
 * is not reverted by this push. Pure.
 */
export function nextUnreviewed(list: SpecProposal[], before: string[], reverted: Set<string>): string[] {
  const prior = new Set(before);
  return list.filter((p) => p.posthoc && (p.status === 'pending' || (p.status === 'rejected' && prior.has(p.id) && !reverted.has(p.id)))).map((p) => p.id);
}

/** The receive hook: post-hoc cards for this push, and the unreviewed set re-derived. Template v2 apps only. */
export async function posthocHook(i: ReceiveHookInput, git: PosthocGit = defaultPosthocGit): Promise<string[]> {
  if (templateVersionOf(i.app) !== 2) return [];
  const { withProposalLock, pruneProposals, supersededBy } = await import('@tabs/software/lib/stories/proposals');
  const { getAppByIdInternal, persistApp } = await import('@tabs/software/lib/apps');
  const where = `${APPS_DIR}/${i.app.slug}`;
  const range = await git.range(i.app.domain, i.app.slug, i.fromSha ?? null, i.sha);
  return withProposalLock(i.app.id, async () => {
    const app = (await getAppByIdInternal(i.app.id)) ?? i.app;
    const agreed = new Set((app.stories?.index.stories ?? []).filter((s) => s.state === 'agreed').map((s) => s.id));
    const mint = () => `prop_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const fresh = posthocProposals({ appId: app.id, sha: i.sha, pusher: i.pusher, changed: i.changed, range, agreed }, mint, new Date().toISOString());
    let list = [...(app.proposals ?? [])];
    const waiting = list.filter((p) => p.posthoc && p.status === 'rejected' && (app.unreviewed ?? []).includes(p.id));
    const reverted = await revertedCards(app.domain, app.slug, i.sha, waiting, git);
    for (const p of fresh) {
      const sup = supersededBy(list, p);
      list = [p, ...list.map((x) => (sup.includes(x.id) ? { ...x, status: 'superseded' as const } : x))];
    }
    if (fresh.length === 0 && reverted.size === 0) return [];
    const unreviewed = nextUnreviewed(list, app.unreviewed ?? [], reverted);
    app.proposals = pruneProposals(list, unreviewed);
    app.unreviewed = unreviewed;
    await persistApp(app);
    const notes: string[] = [];
    for (const p of fresh) {
      notes.push(
        p.classification === 'code-change'
          ? `${where}: change without a story (card ${p.id}). Name an agreed story in every commit ("Story: US-n" or [US-n]), or open the App Builder chat to create or update one. Going live in the domain or the company waits until the card is decided.`
          : `${where}: story files changed outside the OS (card ${p.id}); someone who can edit the app must approve it before it goes live in the domain or the company.`,
      );
    }
    for (const id of reverted) notes.push(`${where}: the rejected change of card ${id} is reverted in git; it no longer blocks going live.`);
    return notes;
  });
}

/** Idempotent (the registry replaces by name). */
export function registerPosthocReceive(): void {
  registerReceiveHook(POSTHOC_HOOK, (i) => posthocHook(i));
}

registerPosthocReceive();
