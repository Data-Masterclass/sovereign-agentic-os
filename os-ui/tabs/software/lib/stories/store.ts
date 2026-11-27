/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - read and change the living spec: every change is one validated git commit
 * USER STORY: As a business user I want each save of a story to be a commit with my name on it, refused with the reason
 *             when it would break the spec, and never lost because someone else changed another story at the same time.
 * ARCHITECTURE:
 *   - Git is the single source of truth (spec 3.1). `readSpec` reads `apps/<slug>/stories/` at a ref and parses it;
 *     `commitSpecChange` (the one write, used by the UI, the MCP, the migration and workstream B's diff cards) reads the
 *     current subtree, applies the change, parses the RESULT with the same parser the receive gate uses, refuses any
 *     issue the change introduces (422 with the issues) and commits the whole subtree through `commitAppStories`
 *     (git-commit.ts) with `OS-Source` / `OS-Proposal`. `App.stories` is then rebuilt (a cache).
 *   - IDS: allocated under ONE per-app lock (`withSpecLock`), from the tree plus the ids seen in the subtree's recent
 *     history, so concurrent creates never collide and a deleted id is not reused within that window.
 *   - CONCURRENT PUSH: an OS write refuses while a push to the domain holds the receive lease (409, try again). If a push
 *     still lands between the read and the commit, the commit's parent is not the head that was read; the change is
 *     then re-applied once on top of the newer subtree and committed again, so the pushed change is kept (both commits
 *     stay in history). A second race is a 409.
 *   - OPTIMISTIC LOCK for the UI: a save may carry `baseSha` (the spec sha it was loaded at); when the target file changed
 *     since, the save is refused with 409 instead of overwriting someone else's edit.
 *   - AUTHORIZATION: reads need the app to be visible to the caller; writes need the app's edit scope (owner, in-domain
 *     domain_admin, admin: `getEditableAppForUser`, the same gate as design_software). The routes and MCP tools put OPA
 *     `authorize()` in front of every write. Every public function refuses with `app_builder_disabled` while the flag
 *     is off, and only a template v2 app in a domain has a living spec.
 *   - PATHS: only paths `classifyStoryPath` accepts (`stories/EP-<n>…/…`) can be written or deleted, so no input can
 *     reach outside `apps/<slug>/stories/`; sizes are bounded by SPEC_LIMITS and by `CHANGE_LIMITS`.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import { config } from '@core/kernel/config';
import { commitAt, mainSha, readBlob, readSubtree } from '@core/infra/git-store';
import { leaseHolder } from '@core/infra/git-receive';
import type {
  Criterion,
  CriterionId,
  EpicDoc,
  EpicId,
  LivingSpec,
  SpecChange,
  SpecIssue,
  SpecSource,
  StoryDoc,
  StoryLight,
  StoryState,
  StoryStatus,
} from '@tabs/software/lib/app-builder-contracts';
import { STORIES_DIR, templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { getAppByIdInternal, getAppForUser, getEditableAppForUser, persistApp, withStatus, type App } from '@tabs/software/lib/apps';
import { commitAppStories } from '@tabs/software/lib/git-commit';
import {
  CRITERION_ID_RE,
  classifyStoryPath,
  epicPath,
  issueLine,
  parseLivingSpec,
  renderEpicFile,
  renderStoryFile,
  SPEC_LIMITS,
  storyPath,
  validateEpicDoc,
  validateStoryDoc,
  type SpecFile,
} from '@tabs/software/lib/stories/files';
import { nextCriterionId, nextEpicId, nextStoryId } from '@tabs/software/lib/stories/ids';
import { seenIdsInHistory } from '@tabs/software/lib/stories/history';

/** Bounds of one `SpecChange` (workstream B's diff cards and the MCP). */
export const CHANGE_LIMITS = { files: 100, summary: 500, message: 500 } as const;

const SHA_RE = /^[0-9a-f]{40}$/;

/** A change that would break the living spec: 422 with every issue (path, line, reason, fix). */
export class SpecValidationError extends Error {
  readonly status = 422;
  readonly code = 'spec_invalid';
  readonly issues: SpecIssue[];
  constructor(issues: SpecIssue[]) {
    super(issues.length ? `the change would break the living spec: ${issueLine(issues[0])}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}` : 'the change would break the living spec');
    this.name = 'SpecValidationError';
    this.issues = issues;
  }
}

const fail = (status: number, message: string): Error => withStatus(new Error(message), status);

// ------------------------------------------------------------------ resolution ---

/** The app of a living-spec call: visible (view) or editable (edit), template v2, in a domain. */
export async function resolveSpecApp(appId: string, user: CurrentUser, mode: 'view' | 'edit'): Promise<App> {
  const app = mode === 'edit' ? await getEditableAppForUser(appId, user) : await getAppForUser(appId, user);
  if (templateVersionOf(app) !== 2) throw fail(409, `${app.name} is not an App Builder app (template nextjs-web@2); its design lives on the app record`);
  if (!String(app.domain ?? '').trim()) throw fail(409, `${app.name} has no domain, so it has no domain repository for its stories yet`);
  return app;
}

/** Whether the caller may change the living spec of this app (the UI shows edit controls only then). */
export async function canEditSpec(appId: string, user: CurrentUser): Promise<boolean> {
  try {
    await getEditableAppForUser(appId, user);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------- reads ---

type StoriesRead = { files: SpecFile[]; sha: string; truncated: boolean };

async function readStoriesFiles(app: Pick<App, 'domain' | 'slug'>, ref?: string): Promise<StoriesRead> {
  const read = await readSubtree(app.domain, `apps/${app.slug}/${STORIES_DIR}`, { reposDir: config.reposDir, ...(ref ? { ref } : {}) });
  if (!read) return { files: [], sha: '', truncated: false };
  return { files: read.files.map((f) => ({ path: `${STORIES_DIR}/${f.path}`, content: f.content })), sha: read.sha, truncated: read.truncated };
}

export type SpecRead = { spec: LivingSpec; issues: SpecIssue[]; truncated: boolean };

/** `readSpec(appId, user, sha?)`: the living spec at `sha` (default: main) for a caller who can see the app. */
export async function readSpec(appId: string, user: CurrentUser, sha?: string): Promise<SpecRead> {
  assertAppBuilderEnabled();
  if (sha !== undefined && !SHA_RE.test(sha)) throw fail(400, 'sha must be a full 40-character commit id');
  const app = await resolveSpecApp(appId, user, 'view');
  return readSpecOf(app, sha);
}

/** The same read for an app already resolved by the caller (MCP tools, the routes). */
export async function readSpecOf(app: Pick<App, 'domain' | 'slug'>, sha?: string): Promise<SpecRead> {
  let read: StoriesRead;
  try {
    read = await readStoriesFiles(app, sha);
  } catch (e) {
    if (sha) throw fail(404, `the commit ${sha.slice(0, 12)} does not exist in this app's repository`);
    throw e;
  }
  const { spec, issues } = parseLivingSpec(read.files, sha ?? read.sha);
  return { spec, issues, truncated: read.truncated };
}

/**
 * The Stories view's payload (GET /api/apps/[id]/stories and `get_stories`): the spec plus, per story, its file state
 * as `status` and its light (`untested` until workstream B records one), whether the caller may edit, and how many
 * record-only epics still wait for the migration.
 */
export async function storiesView(appId: string, user: CurrentUser, sha?: string) {
  assertAppBuilderEnabled();
  if (sha !== undefined && !SHA_RE.test(sha)) throw fail(400, 'sha must be a full 40-character commit id');
  const app = await resolveSpecApp(appId, user, 'view');
  const { spec, issues, truncated } = await readSpecOf(app, sha);
  const lights = app.stories?.lights ?? {};
  const hasFiles = spec.epics.length + spec.stories.length + issues.length > 0;
  return {
    appId: app.id,
    sha: spec.sha,
    epics: spec.epics,
    stories: spec.stories.map((s) => ({ ...s, status: s.state as StoryStatus, light: (lights[s.id] ?? 'untested') as StoryLight })),
    issues,
    truncated,
    canEdit: await canEditSpec(app.id, user),
    legacyEpics: hasFiles ? 0 : Array.isArray(app.epics) ? app.epics.length : 0,
  };
}

// ----------------------------------------------------------------------- index ---

/** Rebuild the `App.stories` cache from a parsed spec (keeps workstream B's lights; they are re-derived from checks). */
export async function writeSpecIndex(appId: string, spec: LivingSpec): Promise<void> {
  const app = await getAppByIdInternal(appId);
  if (!app) return;
  app.stories = { sha: spec.sha, index: spec, ...(app.stories?.lights ? { lights: app.stories.lights } : {}) };
  await persistApp(app);
}

// ---------------------------------------------------------------------- the lock ---

const LOCKS = Symbol.for('soa.software.specLocks');
function locks(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  return (g[LOCKS] ??= new Map());
}

/** Serialise every living-spec write of one app (domain + slug) in this process. */
export async function withSpecLock<T>(app: Pick<App, 'domain' | 'slug'>, fn: () => Promise<T>): Promise<T> {
  const key = `${app.domain}/${app.slug}`;
  // Each holder's marker only ever RESOLVES (on release), so waiting on the predecessor never sees its failure: the
  // failure stays with the caller that owns it.
  const prev = locks().get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks().set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks().get(key) === mine) locks().delete(key);
  }
}

// ---------------------------------------------------------------------- writing ---

export type CommitMeta = { source: Exclude<SpecSource, 'git'>; proposalId?: string; message: string };
export type SpecCommitResult = { sha: string; changed: boolean; spec: LivingSpec };

/** What a change sees: the current files and their parse. */
export type SpecBase = { files: SpecFile[]; spec: LivingSpec; issues: SpecIssue[]; sha: string };

const issueKey = (i: SpecIssue) => `${i.path}|${i.reason}`;

function filesEqual(a: SpecFile[], b: SpecFile[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((f) => [f.path, f.content]));
  return b.every((f) => m.get(f.path) === f.content);
}

/**
 * The one write: under the app's lock, read the subtree, let `build` produce the new complete set of files, refuse any
 * issue the result introduces, commit, verify the commit sits on the head that was read (re-apply once if a push slipped
 * in), rebuild the index. Exported for migrate.ts; everything else goes through `commitSpecChange`, `saveStory`,
 * `saveEpic`.
 */
export async function mutateSpec<R>(
  app: App,
  user: CurrentUser,
  build: (base: SpecBase) => Promise<{ files: SpecFile[]; result: R }>,
  meta: CommitMeta,
): Promise<SpecCommitResult & { result: R }> {
  if (String(meta.message ?? '').length > CHANGE_LIMITS.message) throw fail(400, `the commit message is longer than ${CHANGE_LIMITS.message} characters`);
  return withSpecLock(app, async () => {
    const attempt = async (headRef: string | undefined) => {
      const read = await readStoriesFiles(app, headRef);
      if (read.truncated) throw fail(409, `apps/${app.slug}/${STORIES_DIR}/ is larger than one read; change it with git`);
      const parsed = parseLivingSpec(read.files, read.sha);
      const base: SpecBase = { files: read.files, spec: parsed.spec, issues: parsed.issues, sha: read.sha };
      const out = await build(base);
      if (out.files.length > SPEC_LIMITS.files + 1) throw fail(422, `the living spec may hold at most ${SPEC_LIMITS.files} files`);
      const after = parseLivingSpec(out.files, read.sha);
      const known = new Set(parsed.issues.map(issueKey));
      const introduced = after.issues.filter((i) => !known.has(issueKey(i)));
      if (introduced.length > 0) throw new SpecValidationError(introduced);
      return { base, files: out.files, result: out.result, spec: after.spec };
    };
    const commit = async (files: SpecFile[], reason?: string) => {
      const outcome = await commitAppStories(
        { id: app.id, slug: app.slug, name: app.name, domain: app.domain },
        { id: user.id, name: user.name, email: (user as { email?: string | null }).email ?? null },
        files,
        { action: 'stories', note: meta.message, source: meta.source, ...(meta.proposalId ? { proposalId: meta.proposalId } : {}), ...(reason ? { reason } : {}) },
      );
      if (!outcome.ok) throw fail(500, `git refused the change: ${outcome.reason}`);
      if (!outcome.recorded) throw fail(409, `the stories are not in git: ${outcome.reason}`);
      return outcome;
    };

    if (leaseHolder(app.domain)) throw fail(409, `a git push to '${app.domain}' is in progress; nothing was changed, try again in a moment`);
    const head = await mainSha(app.domain, { reposDir: config.reposDir });
    const first = await attempt(undefined);
    if (filesEqual(first.base.files, first.files)) return { sha: first.base.sha, changed: false, spec: first.base.spec, result: first.result };
    let done = await commit(first.files);
    let spec = first.spec;
    let result = first.result;
    const landed = await commitAt(app.domain, done.sha, { reposDir: config.reposDir });
    const parent = landed?.parents[0] ?? null;
    if (done.changed && head && parent && parent !== head) {
      // Something committed between the read and this commit. If it changed the stories, re-apply on top of it.
      const theirs = await readStoriesFiles(app, parent);
      if (!filesEqual(theirs.files, first.base.files)) {
        const again = await attempt(parent);
        done = await commit(again.files, 're-applied over a concurrent change');
        const check = await commitAt(app.domain, done.sha, { reposDir: config.reposDir });
        if (check?.parents[0] !== landed?.sha) throw fail(409, 'the stories changed twice while saving; reload and try again');
        spec = again.spec;
        result = again.result;
      }
    }
    const indexed: LivingSpec = { ...spec, sha: done.sha };
    await writeSpecIndex(app.id, indexed);
    return { sha: done.sha, changed: done.changed, spec: indexed, result };
  });
}

function assertChangeShape(change: SpecChange): void {
  if (!change || typeof change !== 'object') throw fail(400, 'change must be an object { writes, deletes, summary }');
  if (!Array.isArray(change.writes) || !Array.isArray(change.deletes)) throw fail(400, 'change.writes and change.deletes must be lists');
  if (change.writes.length + change.deletes.length === 0) throw fail(400, 'the change writes and deletes nothing');
  if (change.writes.length + change.deletes.length > CHANGE_LIMITS.files) throw fail(400, `a change may touch at most ${CHANGE_LIMITS.files} files`);
  if (String(change.summary ?? '').length > CHANGE_LIMITS.summary) throw fail(400, `the summary is longer than ${CHANGE_LIMITS.summary} characters`);
  const seen = new Set<string>();
  for (const w of change.writes) {
    if (!w || typeof w.path !== 'string' || typeof w.content !== 'string') throw fail(400, 'every write needs a path and a text content');
    if (!classifyStoryPath(w.path)) throw fail(400, `'${String(w.path).slice(0, 80)}' is not a path of the living spec (stories/EP-<n>-<name>/_epic.md or …/US-<m>-<name>.md)`);
    if (new TextEncoder().encode(w.content).length > SPEC_LIMITS.fileBytes) throw fail(413, `${w.path} is larger than ${SPEC_LIMITS.fileBytes} bytes`);
    if (seen.has(w.path)) throw fail(400, `${w.path} is written twice`);
    seen.add(w.path);
  }
  for (const d of change.deletes) {
    if (typeof d !== 'string' || !classifyStoryPath(d)) throw fail(400, `'${String(d).slice(0, 80)}' is not a path of the living spec`);
    if (seen.has(d)) throw fail(400, `${d} is both written and deleted`);
  }
}

/**
 * `commitSpecChange(appId, user, change, { source, proposalId?, message })` (plan, workstream A): apply file writes and
 * deletes to the living spec as one commit. Every resulting file is parsed; a change that introduces an issue (a
 * malformed file, an id used twice, a story without its epic) is refused with 422 and nothing is written.
 */
export async function commitSpecChange(appId: string, user: CurrentUser, change: SpecChange, meta: CommitMeta): Promise<SpecCommitResult> {
  assertAppBuilderEnabled();
  assertChangeShape(change);
  const app = await resolveSpecApp(appId, user, 'edit');
  const { sha, changed, spec } = await mutateSpec(
    app,
    user,
    async (base) => {
      const del = new Set(change.deletes);
      const writes = new Map(change.writes.map((w) => [w.path, w.content]));
      for (const d of del) if (!base.files.some((f) => f.path === d)) throw fail(404, `${d} does not exist`);
      const files = base.files.filter((f) => !del.has(f.path) && !writes.has(f.path));
      for (const [path, content] of writes) files.push({ path, content });
      return { files, result: null };
    },
    { ...meta, message: meta.message || change.summary },
  );
  return { sha, changed, spec };
}

// ------------------------------------------------------------ stories and epics ---

export type CriterionInput = { id?: string; title?: string; given?: string[]; when?: string[]; then?: string[] };
export type StoryInput = {
  id?: string;
  epic: string;
  title: string;
  asA?: string;
  iWant?: string;
  soThat?: string;
  state?: StoryState;
  criteria?: CriterionInput[];
  notes?: string;
  /** The spec sha the editor loaded; a save over a newer version of the same file is refused (409). */
  baseSha?: string;
};
export type EpicInput = {
  id?: string;
  title: string;
  description?: string;
  requirements?: { technical?: string; ux?: string; governance?: string };
  baseSha?: string;
};

const oneLine = (v: unknown): string => String(v ?? '').replace(/\r\n?/g, '\n').trim();
const text = (v: unknown): string => String(v ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(oneLine).filter((l) => l.length > 0) : []);

async function assertNotStale(app: App, base: SpecBase, baseSha: string | undefined, path: string | undefined): Promise<void> {
  if (!baseSha || !path || baseSha === base.sha) return;
  if (!SHA_RE.test(baseSha)) throw fail(400, 'baseSha must be a full 40-character commit id');
  let then: string | null = null;
  try {
    then = await readBlob(app.domain, baseSha, `apps/${app.slug}/${path}`, { reposDir: config.reposDir });
  } catch {
    then = null;
  }
  const now = base.files.find((f) => f.path === path)?.content ?? null;
  if (then !== now) throw fail(409, `${path} was changed by someone else since you opened it; reload to see their version`);
}

/** Save one story (create when `id` is absent). Returns the saved story and the commit. */
export async function saveStory(
  appId: string,
  user: CurrentUser,
  input: StoryInput,
  opts: { source: Exclude<SpecSource, 'git'>; proposalId?: string },
): Promise<SpecCommitResult & { story: StoryDoc }> {
  assertAppBuilderEnabled();
  if (!input || typeof input !== 'object') throw fail(400, 'story must be an object');
  const app = await resolveSpecApp(appId, user, 'edit');
  const seen = await seenIdsInHistory({ domain: app.domain, slug: app.slug }, typeof input.id === 'string' ? input.id : undefined);
  const out = await mutateSpec(
    app,
    user,
    async (base) => {
      const existing = input.id ? base.spec.stories.find((s) => s.id === input.id) : undefined;
      if (input.id && !existing) throw fail(404, `there is no story ${String(input.id).slice(0, 20)} in this app`);
      await assertNotStale(app, base, input.baseSha, existing?.path);
      const epic = base.spec.epics.find((e) => e.id === input.epic);
      if (!epic) throw fail(422, `there is no epic ${String(input.epic).slice(0, 20)}; create the epic first`);
      const id = existing?.id ?? nextStoryId(base.spec, seen.stories);
      const criteria = buildCriteria(input.criteria, existing, seen.criteria);
      const doc: Omit<StoryDoc, 'path'> = {
        id,
        epic: epic.id,
        title: oneLine(input.title),
        asA: oneLine(input.asA),
        iWant: oneLine(input.iWant),
        soThat: oneLine(input.soThat),
        state: input.state === undefined ? (existing?.state ?? 'draft') : input.state,
        criteria,
        notes: text(input.notes),
      };
      const path = existing && existing.epic === epic.id ? existing.path : storyPath(epic, id, doc.title);
      const issues = validateStoryDoc(doc, path);
      if (issues.length) throw new SpecValidationError(issues);
      const files = base.files.filter((f) => f.path !== existing?.path && f.path !== path);
      files.push({ path, content: renderStoryFile(doc) });
      return { files, result: { ...doc, path } as StoryDoc };
    },
    { source: opts.source, proposalId: opts.proposalId, message: `${input.id ? 'edit' : 'add'} story ${oneLine(input.title).slice(0, 80)}` },
  );
  return { sha: out.sha, changed: out.changed, spec: out.spec, story: out.result };
}

function buildCriteria(input: CriterionInput[] | undefined, existing: StoryDoc | undefined, seen: string[]): Criterion[] {
  if (input === undefined) return existing?.criteria ?? [];
  if (!Array.isArray(input)) throw fail(400, 'criteria must be a list');
  if (input.length > SPEC_LIMITS.criteria) throw fail(422, `a story may have at most ${SPEC_LIMITS.criteria} acceptance criteria`);
  const known = new Set((existing?.criteria ?? []).map((c) => c.id));
  const allocated: { id: string }[] = [...(existing?.criteria ?? []), ...input.filter((c) => typeof c?.id === 'string' && c.id).map((c) => ({ id: String(c.id) }))];
  return input.map((c) => {
    if (!c || typeof c !== 'object') throw fail(400, 'every criterion must be an object');
    let id: CriterionId;
    if (c.id) {
      if (!CRITERION_ID_RE.test(String(c.id)) || !known.has(String(c.id) as CriterionId)) {
        throw fail(422, `${String(c.id).slice(0, 20)} is not a criterion of this story; leave the id out for a new criterion (the OS assigns it)`);
      }
      id = c.id as CriterionId;
    } else {
      id = nextCriterionId({ criteria: allocated }, seen);
      allocated.push({ id });
    }
    return { id, title: oneLine(c.title), given: lines(c.given), when: lines(c.when), then: lines(c.then) };
  });
}

// ------------------------------------------------------------- design_software ---

/** One epic as `design_software` sends it (legacy shape, plus structured `criteria` and `state` per story). */
export type DesignEpicInput = {
  id?: string;
  title?: string;
  description?: string;
  requirements?: { technical?: string; ux?: string; governance?: string };
  stories?: (Omit<Partial<StoryInput>, 'epic' | 'baseSha'> & { acceptance?: string })[];
};

/** Most epics, and stories per epic, one `design_software` call may send. */
export const DESIGN_LIMITS = { epics: 50, storiesPerEpic: 100 } as const;

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Apply `design_software` epics to the living spec (pure over the base). An epic or story is matched by its id when it
 * names an existing one, else by its title (case-insensitive; stories within their epic), else created with a server
 * id. Only the fields sent are changed. `acceptance` (legacy free text) is kept as the story's Notes unless `notes` is
 * sent; legacy `status` is ignored (built and verified are derived from tests, never written).
 */
export function designEpicsToFiles(
  base: SpecBase,
  epics: DesignEpicInput[],
  seen: { epics: string[]; stories: string[] },
): { files: SpecFile[]; epics: EpicId[]; stories: string[] } {
  if (!Array.isArray(epics)) throw fail(400, 'epics must be a list');
  if (epics.length > DESIGN_LIMITS.epics) throw fail(422, `at most ${DESIGN_LIMITS.epics} epics per call`);
  const files = new Map(base.files.map((f) => [f.path, f.content]));
  const spec: LivingSpec = { sha: base.sha, epics: [...base.spec.epics], stories: [...base.spec.stories] };
  const touchedEpics: EpicId[] = [];
  const touchedStories: string[] = [];
  for (const e of epics) {
    if (!e || typeof e !== 'object') throw fail(400, 'every epic must be an object');
    const existing = spec.epics.find((x) => x.id === e.id) ?? (e.title ? spec.epics.find((x) => sameTitle(x.title, String(e.title))) : undefined);
    const id = (existing?.id ?? nextEpicId(spec, seen.epics)) as EpicId;
    const doc: Omit<EpicDoc, 'path'> = {
      id,
      title: e.title !== undefined ? oneLine(e.title) : existing?.title ?? '',
      description: e.description !== undefined ? text(e.description).trim() : existing?.description ?? '',
      requirements: {
        technical: e.requirements?.technical !== undefined ? text(e.requirements.technical).trim() : existing?.requirements.technical ?? '',
        ux: e.requirements?.ux !== undefined ? text(e.requirements.ux).trim() : existing?.requirements.ux ?? '',
        governance: e.requirements?.governance !== undefined ? text(e.requirements.governance).trim() : existing?.requirements.governance ?? '',
      },
    };
    const path = existing?.path ?? epicPath(id, doc.title);
    const issues = validateEpicDoc(doc, path);
    if (issues.length) throw new SpecValidationError(issues);
    files.set(path, renderEpicFile(doc));
    const epicDoc: EpicDoc = { ...doc, path };
    if (existing) spec.epics[spec.epics.indexOf(existing)] = epicDoc;
    else spec.epics.push(epicDoc);
    touchedEpics.push(id);
    const stories = e.stories ?? [];
    if (!Array.isArray(stories)) throw fail(400, `the stories of ${id} must be a list`);
    if (stories.length > DESIGN_LIMITS.storiesPerEpic) throw fail(422, `at most ${DESIGN_LIMITS.storiesPerEpic} stories per epic`);
    for (const s of stories) {
      if (!s || typeof s !== 'object') throw fail(400, 'every story must be an object');
      const prior = spec.stories.find((x) => x.id === s.id) ?? (s.title ? spec.stories.find((x) => x.epic === id && sameTitle(x.title, String(s.title))) : undefined);
      const sid = prior?.id ?? nextStoryId(spec, seen.stories);
      const story: Omit<StoryDoc, 'path'> = {
        id: sid,
        epic: id,
        title: s.title !== undefined ? oneLine(s.title) : prior?.title ?? '',
        asA: s.asA !== undefined ? oneLine(s.asA) : prior?.asA ?? '',
        iWant: s.iWant !== undefined ? oneLine(s.iWant) : prior?.iWant ?? '',
        soThat: s.soThat !== undefined ? oneLine(s.soThat) : prior?.soThat ?? '',
        state: s.state !== undefined ? s.state : prior?.state ?? 'draft',
        criteria: buildCriteria(s.criteria, prior, []),
        notes: s.notes !== undefined ? text(s.notes) : s.acceptance !== undefined ? text(s.acceptance) : prior?.notes ?? '',
      };
      const spath = prior && prior.epic === id ? prior.path : storyPath(epicDoc, sid, story.title);
      const sIssues = validateStoryDoc(story, spath);
      if (sIssues.length) throw new SpecValidationError(sIssues);
      if (prior && prior.path !== spath) files.delete(prior.path);
      files.set(spath, renderStoryFile(story));
      const storyDoc: StoryDoc = { ...story, path: spath };
      if (prior) spec.stories[spec.stories.indexOf(prior)] = storyDoc;
      else spec.stories.push(storyDoc);
      touchedStories.push(sid);
    }
  }
  return { files: [...files].map(([path, content]) => ({ path, content })), epics: touchedEpics, stories: touchedStories };
}

/** Save one epic (create when `id` is absent). */
export async function saveEpic(
  appId: string,
  user: CurrentUser,
  input: EpicInput,
  opts: { source: Exclude<SpecSource, 'git'>; proposalId?: string },
): Promise<SpecCommitResult & { epic: EpicDoc }> {
  assertAppBuilderEnabled();
  if (!input || typeof input !== 'object') throw fail(400, 'epic must be an object');
  const app = await resolveSpecApp(appId, user, 'edit');
  const seen = await seenIdsInHistory({ domain: app.domain, slug: app.slug });
  const out = await mutateSpec(
    app,
    user,
    async (base) => {
      const existing = input.id ? base.spec.epics.find((e) => e.id === input.id) : undefined;
      if (input.id && !existing) throw fail(404, `there is no epic ${String(input.id).slice(0, 20)} in this app`);
      await assertNotStale(app, base, input.baseSha, existing?.path);
      const id = (existing?.id ?? nextEpicId(base.spec, seen.epics)) as EpicId;
      const doc: Omit<EpicDoc, 'path'> = {
        id,
        title: oneLine(input.title),
        description: text(input.description).trim(),
        requirements: {
          technical: text(input.requirements?.technical).trim(),
          ux: text(input.requirements?.ux).trim(),
          governance: text(input.requirements?.governance).trim(),
        },
      };
      const path = existing?.path ?? epicPath(id, doc.title);
      const issues = validateEpicDoc(doc, path);
      if (issues.length) throw new SpecValidationError(issues);
      const files = base.files.filter((f) => f.path !== path);
      files.push({ path, content: renderEpicFile(doc) });
      return { files, result: { ...doc, path } as EpicDoc };
    },
    { source: opts.source, proposalId: opts.proposalId, message: `${input.id ? 'edit' : 'add'} epic ${oneLine(input.title).slice(0, 80)}` },
  );
  return { sha: out.sha, changed: out.changed, spec: out.spec, epic: out.result };
}
