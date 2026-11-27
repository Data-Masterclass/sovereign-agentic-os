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
 *          `commitShas: [sha]`, the pushed files as its change; the files are already in git, so approving commits
 *          nothing);
 *       2. a push that changes code without a story reference (story-ref.ts) → a "change without a story" card
 *          (`classification: 'code-change'`, empty change, the code paths in its summary). The chat offers to turn it into
 *          a story change (classify.ts, from the commit message and paths); no model runs inside the push.
 *     Either keeps the card id in `App.unreviewed` until it is approved; a rejected one stays until the push that reverts
 *     it (`git revert`'s "This reverts commit <sha>", or story files no longer holding the pushed content).
 *   - `unreviewedBlocksGoLive(app, scope)`: Domain/Company ⇒ the refusal naming the cards; My ⇒ never blocked (its rule
 *     is "no review"). Called by the go-live path (C2's release go-live and F's lifecycle `canGoLive`; see the plan).
 *   - The hook reads only the push input (paths, contents of changed story files, the head commit message); it never
 *     reads secrets and never calls a model.
 */
import 'server-only';
import type { ReceiveHookInput } from '@tabs/software/lib/receive-hooks';
import { registerReceiveHook } from '@tabs/software/lib/receive-hooks';
import type { GoLiveScope } from '@core/policy/go-live-rules';
import type { Classification, SpecProposal, StoryId, EpicId } from '@tabs/software/lib/app-builder-contracts';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { classifyStoryPath } from '@tabs/software/lib/stories/files';
import { appRelativePath, codePaths, isStoryless, revertedShas } from '@tabs/software/lib/stories/story-ref';

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

/** The post-hoc cards one push creates (pure; ids and time injected). */
export function posthocProposals(i: Pick<ReceiveHookInput, 'changed' | 'sha' | 'pusher' | 'messages'> & { appId: string }, mint: () => string, now: string): SpecProposal[] {
  const out: SpecProposal[] = [];
  const pusher = i.pusher?.id ?? 'git';
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
      commitShas: [i.sha],
      requestedBy: pusher,
      status: 'pending',
      createdAt: now,
    });
  }
  const paths = i.changed.map((f) => f.path);
  if (isStoryless(paths, i.messages)) {
    const code = codePaths(paths).map(appRelativePath);
    out.push({
      id: mint(),
      appId: i.appId,
      classification: 'code-change',
      rationale: `change without a story: code pushed from git by ${pusher} names no story (no "Story: US-n" trailer or [US-n] reference)`,
      confidence: 1,
      alternatives: [],
      change: { writes: [], deletes: [], summary: `code changed in ${i.sha.slice(0, 12)} without a story: ${code.slice(0, SUMMARY_PATHS).join(', ')}${code.length > SUMMARY_PATHS ? ` and ${code.length - SUMMARY_PATHS} more` : ''}`.slice(0, 500) },
      source: 'git',
      posthoc: true,
      commitShas: [i.sha],
      requestedBy: pusher,
      status: 'pending',
      createdAt: now,
    });
  }
  return out;
}

/**
 * Rejected post-hoc cards this push reverts: a `git revert` of one of their commits, or (story cards) every file they
 * wrote no longer holds the pushed content and every file they deleted is back. Pure.
 */
export function revertedBy(proposals: SpecProposal[], i: Pick<ReceiveHookInput, 'changed' | 'messages'>): Set<string> {
  const shas = new Set(i.messages.flatMap(revertedShas));
  const now = new Map(i.changed.map((f) => [appRelativePath(f.path), f]));
  const out = new Set<string>();
  for (const p of proposals) {
    if (!p.posthoc || p.status !== 'rejected') continue;
    if ((p.commitShas ?? []).some((s) => shas.has(s))) {
      out.add(p.id);
      continue;
    }
    if (p.classification === 'code-change') continue;
    const touched = [...p.change.writes.map((w) => w.path), ...p.change.deletes];
    if (touched.length === 0) continue;
    const undone =
      p.change.writes.every((w) => {
        const f = now.get(w.path);
        return f !== undefined && (f.status === 'deleted' || f.content !== w.content);
      }) && p.change.deletes.every((d) => now.get(d)?.status === 'added');
    if (undone) out.add(p.id);
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
export async function posthocHook(i: ReceiveHookInput): Promise<string[]> {
  if (templateVersionOf(i.app) !== 2) return [];
  const { withProposalLock, pruneProposals, supersededBy } = await import('@tabs/software/lib/stories/proposals');
  const { getAppByIdInternal, persistApp } = await import('@tabs/software/lib/apps');
  return withProposalLock(i.app.id, async () => {
    const app = (await getAppByIdInternal(i.app.id)) ?? i.app;
    const mint = () => `prop_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const fresh = posthocProposals({ ...i, appId: app.id }, mint, new Date().toISOString());
    let list = [...(app.proposals ?? [])];
    const reverted = revertedBy(list, i);
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
          ? `apps/${app.slug}: change without a story (card ${p.id}). Name the story in the commit ("Story: US-n" or [US-n]), or open the App Builder chat to create or update one. Going live in the domain or the company waits until the card is decided.`
          : `apps/${app.slug}: story files changed outside the OS (card ${p.id}); someone who can edit the app must approve it before it goes live in the domain or the company.`,
      );
    }
    for (const id of reverted) notes.push(`apps/${app.slug}: the rejected change of card ${id} is reverted; it no longer blocks going live.`);
    return notes;
  });
}

/** Idempotent (the registry replaces by name). */
export function registerPosthocReceive(): void {
  registerReceiveHook(POSTHOC_HOOK, posthocHook);
}

registerPosthocReceive();
