/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - diff cards: a classified requirement is approved, edited or rejected before anything moves
 * USER STORY: As anyone who can edit the app I want to approve, edit or reject a proposed story change, see exactly
 *             which files it changes, and know that only an approved card changes git (and only then code and tests).
 * ARCHITECTURE:
 *   - The lifecycle of `SpecProposal` (contracts): `pending` → `approved` | `rejected` | `superseded`. Stored on the app
 *     record (`App.proposals`, persisted as JSON through `persistApp`), newest first, bounded.
 *   - WHO: listing needs the app to be visible; every decision needs the app's EDIT scope (`resolveSpecApp(…, 'edit')`,
 *     the same gate the living-spec write uses: owner, in-domain domain admin, admin). Self-approval is allowed: agreeing
 *     a requirement is not shipping (spec section 4). The routes and MCP tools put OPA `authorize()` in front.
 *   - CONCURRENCY: every view carries `rev` (a hash of the stored card); a decision or an edit names the `rev` it saw and
 *     is refused with 409 when the card changed since (another person edited or decided it). Decisions of one app are
 *     serialised by a per-app lock (per process: os-ui runs one replica while the App Builder is on), and the app is
 *     re-read inside it.
 *   - APPROVE (a normal card): ONE commit through A's `mutateSpec` with `OS-Source` = the door and `OS-Proposal` = the
 *     card id; every story the card writes is set to `agreed` in that commit (only then may the build loop touch its code
 *     and tests). Ids that another change took since the card was made are re-allocated inside the commit (A's ids). A
 *     card whose target file was changed by someone after the card was made is refused (409, classify again) rather
 *     than overwrite their edit.
 *   - POST-HOC cards (posthoc.ts, from a developer push) are already in git: approving records the approver and clears
 *     the app's "unreviewed changes"; rejecting keeps it unreviewed until a revert commit lands (the card says so).
 *   - A newer card touching the same story or epic SUPERSEDES a pending normal card (never a post-hoc one: its change
 *     is already in git and still needs a decision).
 *   - AUDIT: approve → `approve`, reject → `deny` (core/policy/audit), subject = the app, detail = card id, class.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import type { Classification, SpecChange, SpecProposal, SpecSource, StoryId } from '@tabs/software/lib/app-builder-contracts';
import { sha256Hex } from '@tabs/software/lib/app-builder-contracts';
import { getAppByIdInternal, persistApp, withStatus, type App } from '@tabs/software/lib/apps';
import { classifyStoryPath, epicPath, parseEpicFile, parseStoryFile, renderEpicFile, renderStoryFile, SPEC_LIMITS, storyPath } from '@tabs/software/lib/stories/files';
import { nextEpicId, nextStoryId } from '@tabs/software/lib/stories/ids';
import { storyRefNote } from '@tabs/software/lib/stories/story-ref';

/** `pending`: open normal cards one app may hold at once (a proposer floods nothing). */
export const PROPOSAL_LIMITS = { kept: 200, reason: 500, files: 20, pending: 50 } as const;

/**
 * A stored card: the contract's `SpecProposal` plus `baseSha`, the commit of the living spec the classifier read. An
 * approval compares each file it writes at `baseSha` with the file now, so it never overwrites an edit made since.
 * Absent on post-hoc cards (their change is already in git).
 */
export type StoredProposal = SpecProposal & { baseSha?: string };

export type Decision = 'approve' | 'reject' | 'edit';
/** The door a decision came through: the OS-Source of the commit an approval makes. */
export type DecisionVia = Exclude<SpecSource, 'git' | 'migration'>;

const fail = (status: number, message: string, code?: string): Error => {
  const e = withStatus(new Error(message), status) as Error & { code?: string };
  if (code) e.code = code;
  return e;
};

/** The optimistic-lock token of a stored card (changes with every edit or decision). */
export function proposalRev(p: SpecProposal): string {
  return sha256Hex(JSON.stringify(p)).slice(0, 16);
}

/** The story and epic ids a card touches (its target and every file it writes or deletes). */
export function touchedIds(p: Pick<SpecProposal, 'targetId' | 'change'>): string[] {
  const out = new Set<string>();
  if (p.targetId) out.add(p.targetId);
  for (const path of [...p.change.writes.map((w) => w.path), ...p.change.deletes]) {
    const c = classifyStoryPath(path);
    if (c?.kind === 'story') out.add(c.story);
    else if (c?.kind === 'epic') out.add(c.epic);
  }
  return [...out];
}

/** Keep every pending or unreviewed card; drop the oldest decided ones beyond the bound. */
export function pruneProposals(list: SpecProposal[], unreviewed: string[] = []): SpecProposal[] {
  const keep = new Set(unreviewed);
  const out: SpecProposal[] = [];
  let decided = 0;
  for (const p of list) {
    if (p.status === 'pending' || keep.has(p.id)) out.push(p);
    else if (decided++ < PROPOSAL_LIMITS.kept) out.push(p);
  }
  return out;
}

/**
 * Pending NORMAL cards a new card supersedes: the SAME person's earlier cards on the same story or epic. Someone else's
 * card is never superseded by another user's proposal; both stay open for a decision.
 */
export function supersededBy(list: SpecProposal[], incoming: SpecProposal): string[] {
  if (incoming.posthoc) return [];
  const mine = new Set(touchedIds(incoming));
  return list
    .filter((p) => p.status === 'pending' && !p.posthoc && p.id !== incoming.id && p.requestedBy === incoming.requestedBy && touchedIds(p).some((id) => mine.has(id)))
    .map((p) => p.id);
}

// ---------------------------------------------------------------- the lock ---

const LOCKS = Symbol.for('soa.software.proposalLocks');
function locks(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  return (g[LOCKS] ??= new Map());
}

/** Serialise every proposal change of one app (taken BEFORE A's spec lock, never inside it). */
export async function withProposalLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks().get(appId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  locks().set(appId, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks().get(appId) === mine) locks().delete(appId);
  }
}

async function freshApp(appId: string): Promise<App> {
  const app = await getAppByIdInternal(appId);
  if (!app) throw fail(404, 'App not found');
  return app;
}

// ---------------------------------------------------------------- create ---

/**
 * Store a card (from classify.ts, or a post-hoc one from posthoc.ts) and supersede the pending normal cards it
 * replaces. The caller has resolved the app for the user. Returns the stored card with its `rev`.
 */
export async function createProposal(appId: string, proposal: SpecProposal): Promise<{ proposal: SpecProposal; rev: string; superseded: string[] }> {
  assertAppBuilderEnabled();
  if (proposal.appId !== appId) throw fail(400, 'the card belongs to another app');
  return withProposalLock(appId, async () => {
    const app = await freshApp(appId);
    const list = [...(app.proposals ?? [])];
    if (list.some((p) => p.id === proposal.id)) throw fail(409, `a card ${proposal.id} exists already`);
    const sup = supersededBy(list, proposal);
    const open = list.filter((p) => p.status === 'pending' && !p.posthoc && !sup.includes(p.id)).length;
    if (!proposal.posthoc && open >= PROPOSAL_LIMITS.pending) throw fail(429, `${app.name} already has ${open} open diff cards; decide some before proposing more`, 'proposal_limit');
    const at = new Date().toISOString();
    const next = [proposal, ...list.map((p) => (sup.includes(p.id) ? { ...p, status: 'superseded' as const, decidedAt: at, reason: `superseded by ${proposal.id}` } : p))];
    const unreviewed = proposal.posthoc ? [...new Set([...(app.unreviewed ?? []), proposal.id])] : app.unreviewed ?? [];
    app.proposals = pruneProposals(next, unreviewed);
    if (proposal.posthoc) app.unreviewed = unreviewed;
    await persistApp(app);
    return { proposal, rev: proposalRev(proposal), superseded: sup };
  });
}

/**
 * Classify a requirement and store its card: the one function behind the chat route and `propose_requirement`. The
 * caller must be able to EDIT the app (proposing spends model budget and opens a card on it) and has passed OPA;
 * nothing in git changes. The card remembers the spec commit it was classified against (`baseSha`).
 */
export async function proposeRequirement(
  user: CurrentUser,
  appId: string,
  input: { text: string; source: Exclude<SpecSource, 'git' | 'migration'>; prefer?: string; commit?: { message: string; paths: string[] } },
): Promise<{ appId: string; proposal: ProposalView; superseded: string[] }> {
  assertAppBuilderEnabled();
  const { resolveSpecApp } = await import('@tabs/software/lib/stories/store');
  const { classifyRequirement } = await import('@tabs/software/lib/stories/classify');
  const app = await resolveSpecApp(appId, user, 'edit');
  const open = (app.proposals ?? []).filter((p) => p.status === 'pending' && !p.posthoc).length;
  if (open >= PROPOSAL_LIMITS.pending) throw fail(429, `${app.name} already has ${open} open diff cards; decide some before proposing more`, 'proposal_limit');
  const { readSpecOf } = await import('@tabs/software/lib/stories/store');
  const baseSha = (await readSpecOf(app)).spec.sha;
  const classified = await classifyRequirement(app, user, {
    text: input.text,
    source: input.source,
    ...(input.prefer ? { prefer: input.prefer as 'refine-story' } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
  });
  const proposal: StoredProposal = baseSha ? { ...classified, baseSha } : classified;
  const stored = await createProposal(app.id, proposal);
  return { appId: app.id, proposal: viewOf(stored.proposal, app.unreviewed ?? []), superseded: stored.superseded };
}

// ------------------------------------------------------------------ list ---

export type ProposalView = SpecProposal & {
  rev: string;
  /** Rejected post-hoc card whose change is still in git: going live in Domain/Company waits for a revert commit. */
  needsRevert: boolean;
  /** The stories it touches (for the card's links). */
  touched: string[];
};

export function viewOf(p: SpecProposal, unreviewed: string[]): ProposalView {
  return { ...p, rev: proposalRev(p), needsRevert: p.posthoc && p.status === 'rejected' && unreviewed.includes(p.id), touched: touchedIds(p) };
}

/** The cards of an app the caller can see, newest first (optionally only pending ones), plus the unreviewed set. */
export async function listProposals(appId: string, user: CurrentUser, opts: { status?: SpecProposal['status'] } = {}) {
  assertAppBuilderEnabled();
  const { resolveSpecApp, canEditSpec } = await import('@tabs/software/lib/stories/store');
  const app = await resolveSpecApp(appId, user, 'view');
  const unreviewed = app.unreviewed ?? [];
  const all = (app.proposals ?? []).filter((p) => !opts.status || p.status === opts.status);
  const diffs = await pendingDiffs(app, all);
  return {
    appId: app.id,
    proposals: all.map((p) => ({ ...viewOf(p, unreviewed), ...(diffs.has(p.id) ? { diffs: diffs.get(p.id) } : {}) })),
    unreviewed,
    canDecide: await canEditSpec(app.id, user),
  };
}

/** Most pending normal cards whose diff against the current spec is computed per listing. */
const DIFF_CARDS = 20;

/**
 * The card's files as unified diffs against the living spec as it is NOW (pending normal cards; a post-hoc card's change
 * is already in git, so its pushed content is the change). Secrets are scrubbed like every version read.
 */
async function pendingDiffs(app: App, list: SpecProposal[]): Promise<Map<string, { path: string; diff: string }[]>> {
  const out = new Map<string, { path: string; diff: string }[]>();
  const pending = list.filter((p) => p.status === 'pending' && !p.posthoc).slice(0, DIFF_CARDS);
  if (pending.length === 0) return out;
  const { readSpecOf } = await import('@tabs/software/lib/stories/store');
  const { unifiedDiff, scrubSecrets } = await import('@core/infra/git-store');
  const { spec } = await readSpecOf(app);
  const now = new Map<string, string>([...spec.epics.map((e) => [e.path, renderEpicFile(e)] as const), ...spec.stories.map((s) => [s.path, renderStoryFile(s)] as const)]);
  for (const p of pending) {
    out.set(
      p.id,
      p.change.writes.map((w) => ({
        path: w.path,
        diff: unifiedDiff(scrubSecrets(now.get(w.path) ?? '').text, scrubSecrets(w.content).text, { aLabel: now.has(w.path) ? w.path : '/dev/null', bLabel: w.path }),
      })),
    );
  }
  return out;
}

// ------------------------------------------------------------ change checks ---

/** An edited change must stay inside the living spec and parse with A's parser. */
export function assertEditableChange(change: SpecChange): void {
  if (!change || typeof change !== 'object' || !Array.isArray(change.writes) || !Array.isArray(change.deletes)) throw fail(400, 'change must be { writes, deletes, summary }');
  if (change.deletes.length > 0) throw fail(400, 'an edited card can only write story and epic files');
  if (change.writes.length === 0 || change.writes.length > PROPOSAL_LIMITS.files) throw fail(400, `an edited card writes between 1 and ${PROPOSAL_LIMITS.files} files`);
  if (String(change.summary ?? '').length > 500) throw fail(400, 'the summary is longer than 500 characters');
  const seen = new Set<string>();
  for (const w of change.writes) {
    if (!w || typeof w.path !== 'string' || typeof w.content !== 'string') throw fail(400, 'every write needs a path and a text content');
    const c = classifyStoryPath(w.path);
    if (!c || c.kind === 'readme') throw fail(400, `'${String(w.path).slice(0, 80)}' is not a story or epic file`);
    if (seen.has(w.path)) throw fail(400, `${w.path} is written twice`);
    seen.add(w.path);
    if (new TextEncoder().encode(w.content).length > SPEC_LIMITS.fileBytes) throw fail(413, `${w.path} is larger than ${SPEC_LIMITS.fileBytes} bytes`);
    const r = c.kind === 'epic' ? parseEpicFile(w.path, w.content) : parseStoryFile(w.path, w.content);
    if ('issues' in r) throw Object.assign(fail(422, `${w.path}: ${r.issues[0].reason}`, 'spec_invalid'), { issues: r.issues });
  }
}

/**
 * Apply a card's writes over the current files (pure): new epics/stories whose id another change took since are
 * re-numbered (their stories follow a renumbered epic), and every story written is set to `agreed`.
 */
export function applyApproved(
  base: { files: { path: string; content: string }[]; spec: { epics: { id: string; path: string }[]; stories: { id: string; path: string }[] } },
  change: SpecChange,
  seen: { epics: string[]; stories: string[] },
): { files: { path: string; content: string }[]; stories: StoryId[] } {
  const files = new Map(base.files.map((f) => [f.path, f.content]));
  for (const d of change.deletes) files.delete(d);
  const epicIds = new Set(base.spec.epics.map((e) => e.id));
  const storyIds = new Set(base.spec.stories.map((s) => s.id));
  const takenEpics = { epics: base.spec.epics.map((e) => ({ id: e.id })) };
  const takenStories = { stories: base.spec.stories.map((s) => ({ id: s.id })) };
  const epicMap = new Map<string, { id: string; path: string }>();
  const stories: StoryId[] = [];
  const isNew = (path: string) => !base.files.some((f) => f.path === path);
  for (const w of change.writes) {
    const c = classifyStoryPath(w.path);
    if (c?.kind !== 'epic') continue;
    const r = parseEpicFile(w.path, w.content);
    if ('issues' in r) throw fail(422, `${w.path}: ${r.issues[0].reason}`, 'spec_invalid');
    let doc = r.epic;
    if (isNew(w.path) && epicIds.has(doc.id)) {
      const id = nextEpicId(takenEpics, seen.epics);
      doc = { ...doc, id, path: epicPath(id, doc.title) };
    }
    takenEpics.epics.push({ id: doc.id });
    epicMap.set(c.epic, { id: doc.id, path: doc.path });
    files.set(doc.path, renderEpicFile(doc));
  }
  for (const w of change.writes) {
    const c = classifyStoryPath(w.path);
    if (c?.kind !== 'story') continue;
    const r = parseStoryFile(w.path, w.content);
    if ('issues' in r) throw fail(422, `${w.path}: ${r.issues[0].reason}`, 'spec_invalid');
    let doc = r.story;
    const movedEpic = epicMap.get(c.epic);
    if (isNew(w.path)) {
      const id = storyIds.has(doc.id) ? nextStoryId(takenStories, seen.stories) : doc.id;
      const epic = movedEpic ?? base.spec.epics.find((e) => e.id === c.epic) ?? { id: c.epic, path: `${w.path.slice(0, w.path.lastIndexOf('/'))}/_epic.md` };
      doc = { ...doc, id, epic: epic.id as typeof doc.epic, path: storyPath(epic, id, doc.title) };
    }
    takenStories.stories.push({ id: doc.id });
    doc = { ...doc, state: 'agreed' };
    files.set(doc.path, renderStoryFile(doc));
    stories.push(doc.id);
  }
  return { files: [...files].map(([path, content]) => ({ path, content })), stories };
}

// --------------------------------------------------------------- decide ---

export type DecideOptions = {
  rev?: string;
  reason?: string;
  change?: SpecChange;
  classification?: Classification;
  via?: DecisionVia;
};

export type DecideResult = { proposal: ProposalView; commit?: { sha: string; changed: boolean }; stories?: StoryId[] };

/**
 * `decideProposal(appId, id, user, decision, { rev?, change?, reason? })`: approve (commit), edit (stays pending) or
 * reject. 409 when the card is no longer pending or changed since `rev`.
 */
export async function decideProposal(appId: string, proposalId: string, user: CurrentUser, decision: Decision, opts: DecideOptions = {}): Promise<DecideResult> {
  assertAppBuilderEnabled();
  if (!['approve', 'reject', 'edit'].includes(decision)) throw fail(400, "decision must be 'approve', 'reject' or 'edit'");
  const { resolveSpecApp, mutateSpec } = await import('@tabs/software/lib/stories/store');
  await resolveSpecApp(appId, user, 'edit');
  return withProposalLock(appId, async () => {
    const app = await freshApp(appId);
    const list = [...(app.proposals ?? [])];
    const i = list.findIndex((p) => p.id === proposalId);
    if (i < 0) throw fail(404, `there is no card ${String(proposalId).slice(0, 40)} on this app`);
    const p = list[i];
    if (p.status !== 'pending') throw fail(409, `the card ${p.id} is already ${p.status}`, 'proposal_conflict');
    if ((decision === 'approve' || decision === 'edit') && !opts.rev) throw fail(400, `${decision === 'approve' ? 'an approval' : 'an edit'} names the rev of the card it decides (read it first)`);
    if (opts.rev !== undefined && opts.rev !== proposalRev(p)) throw fail(409, `the card ${p.id} was changed by someone else since you opened it; reload it`, 'proposal_conflict');
    const at = new Date().toISOString();
    const { record } = await import('@core/policy/audit');

    if (decision === 'edit') {
      if (p.posthoc) throw fail(409, 'a post-hoc card is already in git; approve or reject it, or change the story in a new card');
      const next: SpecProposal = { ...p };
      if (opts.change !== undefined) {
        assertEditableChange(opts.change);
        next.change = { writes: opts.change.writes.map((w) => ({ path: w.path, content: w.content })), deletes: [], summary: String(opts.change.summary ?? p.change.summary).slice(0, 500) };
      }
      if (opts.classification !== undefined) {
        if (!['refine-story', 'refine-epic', 'new-story', 'new-epic'].includes(opts.classification)) throw fail(400, 'classification must be refine-story, refine-epic, new-story or new-epic');
        next.classification = opts.classification;
      }
      if (opts.change === undefined && opts.classification === undefined) throw fail(400, 'an edit changes the files or the classification');
      list[i] = next;
      app.proposals = list;
      await persistApp(app);
      record({ actor: user.id, action: 'spec.proposal.edit', subject: app.id, domain: app.domain, reason: `diff card ${p.id} edited`, detail: { kind: 'spec-proposal', proposalId: p.id, classification: next.classification, files: next.change.writes.map((w) => w.path), fromRev: opts.rev } });
      return { proposal: viewOf(next, app.unreviewed ?? []) };
    }

    if (decision === 'reject') {
      const reason = String(opts.reason ?? '').trim();
      if (!reason) throw fail(400, 'a rejection needs a reason');
      if (reason.length > PROPOSAL_LIMITS.reason) throw fail(400, `the reason is longer than ${PROPOSAL_LIMITS.reason} characters`);
      const next: SpecProposal = { ...p, status: 'rejected', decidedBy: user.id, decidedAt: at, reason };
      list[i] = next;
      app.proposals = list;
      await persistApp(app);
      record({ actor: user.id, action: 'deny', subject: app.id, domain: app.domain, reason: `diff card ${p.id} rejected: ${reason}`, detail: { kind: 'spec-proposal', proposalId: p.id, classification: p.classification, posthoc: p.posthoc } });
      return { proposal: viewOf(next, app.unreviewed ?? []) };
    }

    // approve
    let commit: { sha: string; changed: boolean } | undefined;
    let stories: StoryId[] | undefined;
    if (!p.posthoc) {
      const { seenIdsInHistory } = await import('@tabs/software/lib/stories/history');
      const seen = await seenIdsInHistory({ domain: app.domain, slug: app.slug });
      const out = await mutateSpec(
        app,
        user,
        async (base) => {
          for (const d of p.change.deletes) if (!base.files.some((f) => f.path === d)) throw fail(409, `${d} no longer exists; classify the requirement again`);
          await assertNotStale(app, p as StoredProposal, base.files);
          const applied = applyApproved(base, p.change, seen);
          return { files: applied.files, result: applied.stories };
        },
        { source: opts.via ?? 'ui', proposalId: p.id, message: `${p.change.summary || p.classification} ${storyRefNote(touchedIds(p).filter((x) => x.startsWith('US-')))}`.trim().slice(0, 500) },
      );
      commit = { sha: out.sha, changed: out.changed };
      stories = out.result;
    }
    const next: SpecProposal = { ...p, status: 'approved', decidedBy: user.id, decidedAt: at };
    const after = await freshApp(appId);
    const fresh = [...(after.proposals ?? [])];
    const j = fresh.findIndex((x) => x.id === p.id);
    if (j >= 0) fresh[j] = next;
    after.proposals = fresh;
    if (p.posthoc) after.unreviewed = (after.unreviewed ?? []).filter((id) => id !== p.id);
    await persistApp(after);
    record({ actor: user.id, action: 'approve', subject: app.id, domain: app.domain, reason: `diff card ${p.id} approved (${p.classification})`, detail: { kind: 'spec-proposal', proposalId: p.id, classification: p.classification, posthoc: p.posthoc, ...(commit ? { commit: commit.sha } : {}) } });
    return { proposal: viewOf(next, after.unreviewed ?? []), ...(commit ? { commit } : {}), ...(stories ? { stories } : {}) };
  });
}

/**
 * A card whose file changed since the spec commit it was classified against would overwrite someone's edit: refuse
 * (409, classify again). Compares the file at `baseSha` with the file in the tree being committed (inside A's lock).
 */
export async function assertNotStale(app: Pick<App, 'domain' | 'slug'>, p: StoredProposal, files: { path: string; content: string }[]): Promise<void> {
  if (!p.baseSha) return;
  const { readBlob } = await import('@core/infra/git-store');
  const { config } = await import('@core/kernel/config');
  const { APPS_DIR } = await import('@core/infra/repo-layout');
  for (const path of [...p.change.writes.map((w) => w.path), ...p.change.deletes]) {
    let then: string | null;
    try {
      then = await readBlob(app.domain, p.baseSha, `${APPS_DIR}/${app.slug}/${path}`, { reposDir: config.reposDir });
    } catch {
      then = null; // the file did not exist at the card's base
    }
    const now = files.find((f) => f.path === path)?.content ?? null;
    if (then !== now) throw fail(409, `${path} was changed after this card was made; classify the requirement again so nobody's edit is lost`, 'proposal_stale');
  }
}
