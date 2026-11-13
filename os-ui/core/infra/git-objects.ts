/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Generic versioning over the domain repos — one read-back for EVERY object kind
 * USER STORY: As any user I want to see which commit my dataset, KPI, dashboard, agent system or
 *             app is at, read its files at an older commit, diff two versions and restore one —
 *             the same way for every kind, through one owner/scope-gated module the UI and the
 *             MCP both call (checklist G3, G4, G5, G7, G9; decisions D23, D24).
 * ARCHITECTURE:
 *   - THE KIND TABLE LIVES HERE AND THE RESOLVERS ARE REGISTERED BY THE TABS. The kernel may not
 *     import a tab (`CONTRIBUTING.md` rule 2), so `GIT_OBJECT_LAYOUT` is the authoritative,
 *     static repo-layout table (mirrored in `docs/components/git.md`) and each tab calls
 *     `registerGitObject(kind, resolver)` at boot to say "here is how to find THIS object's
 *     domain, its repo paths and whether this caller may see it at all".
 *   - RESOLVING A HISTORY: the `OS-Object` trailer first (it carries `<id> (<name>)`, so a
 *     rename, a lane move and a delete all stay in one history), then a path-scoped
 *     `git log -- <paths>` fallback, MERGED newest-first. The fallback is the point: boot
 *     reconciles commit as the platform with `OS-Object: <domain>`, so a trailer-only lookup
 *     answered `null` for objects that plainly have files in the tree (night-1 F3-1). `via` says
 *     which source(s) produced the answer — never a guess presented as a fact.
 *   - GATING: the resolver answers `null` for "you may not see this" AND for "it does not
 *     exist", and this module turns both into ONE byte-identical `not_found` (G5). No read here
 *     widens identity: every resolver runs the tab's own governed read as the caller.
 *   - RESTORE IS A NEW COMMIT, NEVER A REWRITE (D24). `restoreVersion` reads the files at the old
 *     commit and hands them to the kind's NORMAL writer, registered by the tab, so every
 *     invariant, validation, approval and trailer on the normal path still applies. A kind with
 *     no registered writer is refused with a typed `restore_unsupported` — never half-applied.
 *   - Server-only: reaches node:fs through `core/infra/git-store.ts`.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import {
  logPaths,
  readFilesAt,
  diffPaths,
  log,
  parseTrailers,
  MAX_LOG_DEPTH,
  type LogEntry,
  type FileAtCommit,
  type FileDiff,
  type GitStoreOptions,
} from '@core/infra/git-store';

// ------------------------------------------------------------- kind table ---

/**
 * Every builder artefact kind that lives in a domain repository. A CLOSED list: adding a kind is
 * a one-line change here plus a row in {@link GIT_OBJECT_LAYOUT}, and the enumeration test
 * (`git-objects-kinds.test.ts`, checklist G1) fails until the new kind declares whether its
 * writer commits or is deliberately backlog.
 */
export const GIT_OBJECT_KINDS = [
  'dataset',
  'metric',
  'dashboard',
  'agent-system',
  'software',
  'lifecycle-pin',
  'knowledge-workflow',
  'connection-config',
] as const;
export type GitObjectKind = (typeof GIT_OBJECT_KINDS)[number];

export function isGitObjectKind(x: string): x is GitObjectKind {
  return (GIT_OBJECT_KINDS as readonly string[]).includes(x);
}

/**
 * Whether a kind's OS writer commits to the repo today, is LANDING in a named stream, or is
 * declared backlog and why. The enumeration test (checklist G1) reads this: a kind may only claim
 * `committed` when its writer module exists AND reaches the one commit path, and no writer module
 * may exist that no kind claims — which is what makes "everything lives in git" non-optional.
 */
export type GitWriterState =
  | { state: 'committed'; via: string; since: string }
  | { state: 'landing'; via: string; stream: string }
  | { state: 'backlog'; reason: string };

export type GitObjectLayout = {
  kind: GitObjectKind;
  /** The tool's own noun, for a UI label (vocabulary rule). */
  label: string;
  /** Repo paths, exactly as `docs/components/git.md`'s table states them. */
  paths: string[];
  /** The personal lane, or null for a kind that is owned rather than laned. */
  personalLane: string | null;
  writer: GitWriterState;
};

/**
 * THE REPO LAYOUT TABLE — authoritative, and mirrored in `docs/components/git.md`. One bare repo
 * per domain at `<OS_REPOS_DIR>/<domain>.git`, `main` only.
 */
export const GIT_OBJECT_LAYOUT: Record<GitObjectKind, GitObjectLayout> = {
  dataset: {
    kind: 'dataset',
    label: 'dbt model',
    paths: ['dbt_project.yml', 'profiles.yml', 'models/', 'os/schedules.yml', 'os/sources.yml', 'os/external.yml'],
    personalLane: 'models/personal/<uid>/',
    writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'engine rebuild B1' },
  },
  metric: {
    kind: 'metric',
    label: 'dbt metric',
    paths: ['models/semantic/<model>.yml'],
    personalLane: 'models/personal/<uid>/semantic/<model>.yml',
    writer: { state: 'landing', via: 'tabs/data/lib/dbt/commit.ts', stream: 'M (the semantic emitter writes models/semantic/<model>.yml through the dbt commit path)' },
  },
  dashboard: {
    kind: 'dashboard',
    label: 'dashboard-as-code',
    paths: ['dashboards/index.yml', 'dashboards/<slug>/'],
    personalLane: 'dashboards/personal/<uid>/<slug>/',
    writer: { state: 'landing', via: 'tabs/dashboards/lib/git/commit.ts', stream: 'D (dashboard-as-code + reserveSubtree("dashboards/"))' },
  },
  'agent-system': {
    kind: 'agent-system',
    label: 'LangGraph system',
    paths: ['agents/index.yml', 'agents/<slug>/'],
    personalLane: 'agents/personal/<uid>/<slug>/',
    writer: { state: 'committed', via: 'tabs/agents/lib/git/commit.ts', since: 'engine rebuild D' },
  },
  software: {
    kind: 'software',
    label: 'app source tree',
    paths: ['apps/<slug>/', 'apps/<slug>/.app/release.json'],
    personalLane: null,
    writer: { state: 'landing', via: 'tabs/software/lib/git/commit.ts', stream: 'S (app source trees through commitSubtree("apps/<slug>"))' },
  },
  'lifecycle-pin': {
    kind: 'lifecycle-pin',
    label: 'lifecycle pin',
    paths: ['os/lifecycle.yml'],
    personalLane: null,
    writer: { state: 'landing', via: 'core/kernel/lifecycle.ts', stream: 'V (os/lifecycle.yml + the live/<kind>/<id> tags)' },
  },
  'knowledge-workflow': {
    kind: 'knowledge-workflow',
    label: 'knowledge workflow',
    paths: ['knowledge/<slug>/'],
    personalLane: 'knowledge/personal/<uid>/<slug>/',
    writer: {
      state: 'backlog',
      reason: 'the knowledge store has no git writer yet; the workflow definition still lives only in the registry (plan: stream G backlog)',
    },
  },
  'connection-config': {
    kind: 'connection-config',
    label: 'connection configuration',
    paths: ['connections/<slug>.yml'],
    personalLane: null,
    writer: {
      state: 'backlog',
      reason: 'connection CONFIGURATION (never a credential) has no git writer yet (plan: stream G backlog)',
    },
  },
};

// ---------------------------------------------------------------- registry ---

/**
 * Where one object's files live, as the owning tab answers it. `null` from a resolver means
 * "not found OR not visible to you" — the two are deliberately indistinguishable (G5).
 */
export type GitObjectLocation = {
  /** The domain whose repo holds it. */
  domain: string;
  /** Repo path selectors: `a/b/` for everything under, `a/b.yml` for one file. */
  paths: string[];
  /** The id as the `OS-Object` trailer carries it (defaults to the object id). */
  trailerId?: string;
  /** A display name for the drawer header. */
  name?: string;
  /**
   * The tag prefix this object's releases live under (`app/<slug>/` for a software app). Absent
   * for a kind that does not publish releases — which is most of them.
   */
  tagPrefix?: string;
};

export type GitObjectResolver = (user: CurrentUser, id: string) => Promise<GitObjectLocation | null> | GitObjectLocation | null;

/**
 * Re-apply one version through the kind's NORMAL writer. Receives the files AS THEY WERE at that
 * commit; must produce ONE new commit and must apply every gate the normal write path applies.
 */
export type GitObjectRestorer = (
  user: CurrentUser,
  id: string,
  version: { sha: string; files: FileAtCommit[]; location: GitObjectLocation },
) => Promise<{ sha: string; changed: boolean }>;

type Registration = { resolve: GitObjectResolver; restore?: GitObjectRestorer };

const REGISTRY_KEY = Symbol.for('soa.git-objects.registry');
function registry(): Map<GitObjectKind, Registration> {
  const g = globalThis as unknown as Record<symbol, Map<GitObjectKind, Registration> | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

/** A tab declares how to locate one of its object kinds in the repo. Idempotent per kind. */
export function registerGitObject(kind: GitObjectKind, resolve: GitObjectResolver): void {
  const existing = registry().get(kind);
  registry().set(kind, { ...(existing ?? {}), resolve });
}

/** A tab declares the writer `restoreVersion` goes back through for one kind. */
export function registerGitObjectRestorer(kind: GitObjectKind, restore: GitObjectRestorer): void {
  const existing = registry().get(kind);
  if (!existing) throw new GitObjectError(`cannot register a restorer for '${kind}' before its resolver`, 500, 'not_registered');
  registry().set(kind, { ...existing, restore });
}

/** Which kinds have a registered resolver right now (boot wiring; the kinds test reads it). */
export function registeredGitObjectKinds(): GitObjectKind[] {
  return [...registry().keys()].sort();
}

/** Which kinds can be restored right now. */
export function restorableGitObjectKinds(): GitObjectKind[] {
  return [...registry().entries()].filter(([, r]) => !!r.restore).map(([k]) => k).sort();
}

/** Test hook: forget every registration. */
export function __clearGitObjectRegistry(): void {
  registry().clear();
}

// ------------------------------------------------------------------ errors ---

export class GitObjectError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GitObjectError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The ONE message for "no such object" and for "you may not see this object" — byte-identical by
 * construction, so an id cannot be probed for existence (checklist G5).
 */
export function notFoundMessage(kind: string, id: string): string {
  return `no ${kind} '${id}'`;
}

function notFound(kind: string, id: string): never {
  throw new GitObjectError(notFoundMessage(kind, id), 404, 'not_found');
}

// ------------------------------------------------------------------- reads ---

export type ObjectCommit = {
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
  runId?: string;
};

/** Which source produced the history: the trailer, the path fallback, both, or nothing. */
export type GitInfoVia = 'trailer' | 'path' | 'trailer+path' | 'none';

export type ObjectGitInfo = {
  kind: GitObjectKind;
  id: string;
  domain: string;
  name?: string;
  /** The repo paths this object occupies — what `git log --` was run against. */
  paths: string[];
  /** The newest commit that touched it; null ONLY when it has no commit and no files. */
  head: ObjectCommit | null;
  /** Newest first, at most `limit`. */
  history: ObjectCommit[];
  /** True when the scan window ended before `limit` of this object's commits were found. */
  truncated: boolean;
  via: GitInfoVia;
};

export type GitInfoOptions = GitStoreOptions & { limit?: number; scan?: number };

/** `{ reposDir? }` — re-exported so a caller need not import the git store for one option. */
export type GitStoreOptionsLike = GitStoreOptions;

/** How many commits of an object's history are returned by default. */
export const DEFAULT_OBJECT_HISTORY = 10;
/** How far back the repo log is read while looking for an object's commits. */
export const DEFAULT_OBJECT_SCAN = 200;

function toCommit(e: LogEntry): ObjectCommit {
  const t = e.trailers;
  return {
    sha: e.sha,
    subject: e.subject,
    author: e.author.name,
    email: e.author.email,
    at: new Date(e.timestamp * 1000).toISOString(),
    ...(t['OS-Action'] ? { action: t['OS-Action'] } : {}),
    ...(t['OS-Surface'] ? { surface: t['OS-Surface'] } : {}),
    ...(t['OS-Request-Id'] ? { requestId: t['OS-Request-Id'] } : {}),
    ...(t['OS-Actor'] ? { actor: t['OS-Actor'] } : {}),
    ...(t['OS-Reason'] ? { reason: t['OS-Reason'] } : {}),
    ...(t['OS-Run-Id'] ? { runId: t['OS-Run-Id'] } : {}),
  };
}

/** Does this commit's `OS-Object` trailer name `id`? (The trailer is `<id>` or `<id> (<name>)`.) */
function trailerNames(message: string, id: string): boolean {
  const object = parseTrailers(message)['OS-Object'] ?? '';
  return object === id || object.startsWith(`${id} `);
}

/**
 * The repository view of one object, WITHOUT the owner/scope gate — for a caller that has
 * already run the tab's own governed read (`systemGitInfo` is exactly that). Prefer
 * {@link objectGitInfo}, which gates.
 */
export async function gitInfoForPaths(
  kind: GitObjectKind,
  id: string,
  location: GitObjectLocation,
  opts: GitInfoOptions = {},
): Promise<ObjectGitInfo> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_OBJECT_HISTORY, 100));
  const scan = Math.max(limit, Math.min(opts.scan ?? DEFAULT_OBJECT_SCAN, MAX_LOG_DEPTH));
  const trailerId = location.trailerId ?? id;
  const empty: ObjectGitInfo = {
    kind,
    id,
    domain: location.domain,
    ...(location.name ? { name: location.name } : {}),
    paths: location.paths,
    head: null,
    history: [],
    truncated: false,
    via: 'none',
  };
  // An object that exists but has no repo yet (an unassigned system, a domain whose repo has
  // never been written) is an honest `head: null` — never an error and never a fabricated sha.
  if (!location.domain) return empty;
  const window = await log(location.domain, { reposDir, limit: scan });
  const byTrailer = window.filter((e) => trailerNames(e.message, trailerId)).slice(0, limit);
  const exhausted = window.length >= scan;

  let entries = byTrailer;
  let via: GitInfoVia = byTrailer.length > 0 ? 'trailer' : 'none';
  // THE FALLBACK (D24 / night-1 F3-1). Boot reconciles carry platform attribution, so an object
  // with files in the tree can have NO commit whose trailer names it. Merge the path-scoped log in
  // whenever the trailer did not already fill the page, so `head` is never a wrong `null`.
  if (byTrailer.length < limit) {
    const byPath = await logPaths(location.domain, location.paths, { reposDir, limit, scan });
    if (byPath.entries.length > 0) {
      const seen = new Set(entries.map((e) => e.sha));
      const merged = [...entries, ...byPath.entries.filter((e) => !seen.has(e.sha))];
      // Order by POSITION IN THE WALK, not by timestamp: both sources come from the same
      // newest-first window, and two commits one second apart (a save and its follow-up) carry
      // the SAME author timestamp — sorting on the clock would silently swap them.
      const order = new Map(window.map((e, i) => [e.sha, i]));
      merged.sort((a, b) => (order.get(a.sha) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.sha) ?? Number.MAX_SAFE_INTEGER));
      entries = merged.slice(0, limit);
      via = byTrailer.length > 0 ? 'trailer+path' : 'path';
    }
  }
  return {
    kind,
    id,
    domain: location.domain,
    ...(location.name ? { name: location.name } : {}),
    paths: location.paths,
    head: entries[0] ? toCommit(entries[0]) : null,
    history: entries.map(toCommit),
    truncated: entries.length < limit && exhausted,
    via,
  };
}

/** The registration for a kind, or a typed refusal naming the gap (never a fake `not_found`). */
function registrationFor(kind: GitObjectKind): Registration {
  const reg = registry().get(kind);
  if (!reg) {
    const layout = GIT_OBJECT_LAYOUT[kind];
    const why =
      layout.writer.state === 'backlog'
        ? layout.writer.reason
        : layout.writer.state === 'landing'
          ? `its writer (${layout.writer.via}) lands with stream ${layout.writer.stream}, and no tab has called registerGitObject('${kind}', …) yet`
          : `its tab has not called registerGitObject('${kind}', …) in instrumentation.ts`;
    throw new GitObjectError(`versioning is not wired for '${kind}' yet — ${why}`, 501, 'kind_not_wired');
  }
  return reg;
}

async function locate(user: CurrentUser, kind: GitObjectKind, id: string): Promise<GitObjectLocation> {
  if (!isGitObjectKind(kind)) notFound(String(kind), id);
  const reg = registrationFor(kind);
  let location: GitObjectLocation | null = null;
  try {
    location = await reg.resolve(user, id);
  } catch {
    // A tab's governed read THROWS for an object the caller may not see. That is the same answer
    // as "it does not exist", and it must read identically from outside (G5).
    location = null;
  }
  // `null` is the ONE gate: not found, or not visible. An object WITHOUT paths or without a repo
  // is still a found object — it simply has no history yet, which the reads say honestly.
  if (!location) notFound(kind, id);
  return location;
}

/**
 * `objectGitInfo(kind, id)` — the head commit and recent history of ANY object kind, gated.
 * `head` is non-null for every object that has files in the tree (checklist G3).
 */
export async function objectGitInfo(user: CurrentUser, kind: GitObjectKind, id: string, opts: GitInfoOptions = {}): Promise<ObjectGitInfo> {
  const location = await locate(user, kind, id);
  return gitInfoForPaths(kind, id, location, opts);
}

export type ObjectVersion = {
  kind: GitObjectKind;
  id: string;
  domain: string;
  sha: string;
  /** The commit itself, so a caller can show who made this version and why. */
  commit: ObjectCommit | null;
  files: FileAtCommit[];
  /** False when the object had NO files at that commit — an honest answer, not an error. */
  present: boolean;
  /** True when the version holds more files than one read returns. */
  truncated: boolean;
};

/** An object whose domain has no repository cannot have a version — say so, do not invent one. */
function assertHasRepo(kind: GitObjectKind, id: string, location: GitObjectLocation): string {
  if (!location.domain) {
    throw new GitObjectError(`${kind} '${id}' has no domain repository yet, so it has no versions`, 409, 'no_repository');
  }
  return location.domain;
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;

function assertSha(sha: string): string {
  const s = String(sha ?? '').trim().toLowerCase();
  if (!SHA_RE.test(s)) throw new GitObjectError(`'${s.slice(0, 60)}' is not a commit sha`, 400, 'bad_request');
  return s;
}

/** `getVersion(kind, id, sha)` — the object's files exactly as they were at that commit. */
export async function getVersion(user: CurrentUser, kind: GitObjectKind, id: string, sha: string, opts: GitStoreOptions = {}): Promise<ObjectVersion> {
  const location = await locate(user, kind, id);
  assertHasRepo(kind, id, location);
  const ref = assertSha(sha);
  const reposDir = opts.reposDir ?? config.reposDir;
  const at = await readFilesAt(location.domain, ref, location.paths, { reposDir });
  const entry = (await log(location.domain, { reposDir, limit: MAX_LOG_DEPTH })).find((e) => e.sha === at.sha) ?? null;
  return {
    kind,
    id,
    domain: location.domain,
    sha: at.sha,
    commit: entry ? toCommit(entry) : null,
    files: at.files,
    present: at.files.length > 0,
    truncated: at.truncated,
  };
}

export type ObjectDiff = {
  kind: GitObjectKind;
  id: string;
  domain: string;
  a: string;
  b: string;
  files: FileDiff[];
  /** Every file patch concatenated — what `git apply` would take. */
  patch: string;
  /** True when the two commits are byte-identical for this object. */
  identical: boolean;
};

/** `diffVersions(kind, id, a, b)` — a unified diff of the object between two commits. */
export async function diffVersions(
  user: CurrentUser,
  kind: GitObjectKind,
  id: string,
  shaA: string,
  shaB: string,
  opts: GitStoreOptions & { context?: number } = {},
): Promise<ObjectDiff> {
  const location = await locate(user, kind, id);
  assertHasRepo(kind, id, location);
  const a = assertSha(shaA);
  const b = assertSha(shaB);
  const reposDir = opts.reposDir ?? config.reposDir;
  const result = await diffPaths(location.domain, a, b, location.paths, { reposDir, ...(opts.context !== undefined ? { context: opts.context } : {}) });
  return { kind, id, domain: location.domain, a: result.a, b: result.b, files: result.files, patch: result.patch, identical: result.files.length === 0 };
}

export type RestoreResult = {
  kind: GitObjectKind;
  id: string;
  domain: string;
  /** The commit the version was read FROM. */
  restoredFrom: string;
  /** The NEW commit the writer produced (never a rewrite of history). */
  sha: string;
  changed: boolean;
  files: number;
};

/**
 * `restoreVersion(kind, id, sha)` — re-apply an old version THROUGH the kind's normal writer, so
 * every invariant, validation and approval on the normal path still applies and the result is ONE
 * NEW COMMIT on `main`. The OS never rewrites a human's history (D24).
 *
 * A kind whose tab has not registered a restorer is refused with `restore_unsupported` — the
 * refusal is deliberate and tested: a half-applied restore is worse than none. The owner/scope
 * gate runs FIRST, so an object the caller cannot see still answers the identical `not_found`.
 */
export async function restoreVersion(user: CurrentUser, kind: GitObjectKind, id: string, sha: string, opts: GitStoreOptions = {}): Promise<RestoreResult> {
  const location = await locate(user, kind, id);
  assertHasRepo(kind, id, location);
  const reg = registrationFor(kind);
  const ref = assertSha(sha);
  const reposDir = opts.reposDir ?? config.reposDir;
  const at = await readFilesAt(location.domain, ref, location.paths, { reposDir });
  if (at.files.length === 0) {
    throw new GitObjectError(`${kind} '${id}' has no files at ${at.sha.slice(0, 7)} — there is nothing to restore`, 409, 'nothing_to_restore');
  }
  if (at.truncated) {
    throw new GitObjectError(
      `${kind} '${id}' at ${at.sha.slice(0, 7)} holds more files than one version read returns — restoring part of a version is worse than refusing`,
      409,
      'version_too_large',
    );
  }
  if (!reg.restore) {
    throw new GitObjectError(
      `restoring a ${kind} is not available yet: its tab has not registered a writer for restore, and the OS will not re-apply a version except through the object's normal write path`,
      501,
      'restore_unsupported',
    );
  }
  const result = await reg.restore(user, id, { sha: at.sha, files: at.files, location });
  return { kind, id, domain: location.domain, restoredFrom: at.sha, sha: result.sha, changed: result.changed, files: at.files.length };
}


// ---------------------------------------------------------------- releases ---

/** One release tag of an object (`app/<slug>/v1.2.0`), normalised for the UI. */
export type ObjectRelease = { tag: string; sha: string; at?: string; author?: string; message?: string };

export type ObjectReleases = {
  kind: GitObjectKind;
  id: string;
  domain: string;
  /** False ⇒ the surface renders NOTHING: "no releases" and "releases are not available" differ. */
  available: boolean;
  /** Why it is unavailable, in the operator's words. Empty when it is available. */
  reason: string;
  releases: ObjectRelease[];
};

type UnknownTag = { tag?: unknown; name?: unknown; sha?: unknown; oid?: unknown; at?: unknown; author?: unknown; message?: unknown };

function normaliseTag(raw: UnknownTag): ObjectRelease {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    tag: text(raw.tag) || text(raw.name),
    sha: text(raw.sha) || text(raw.oid),
    ...(text(raw.at) ? { at: text(raw.at) } : {}),
    ...(text(raw.author) ? { author: text(raw.author) } : {}),
    ...(text(raw.message) ? { message: text(raw.message) } : {}),
  };
}

/**
 * The release tags of one object, gated exactly like its history.
 *
 * DELIBERATELY TOLERANT OF A MISSING TAG API: the annotated-tag half of
 * `core/infra/git-store.ts` is another stream's, so this looks it up at run time and answers
 * `available: false` with the reason when it is absent — rather than failing to compile against
 * an export that does not exist yet, or showing an empty "Releases" panel that reads as "this
 * app has never been released".
 */
export async function objectReleases(user: CurrentUser, kind: GitObjectKind, id: string, opts: GitStoreOptions = {}): Promise<ObjectReleases> {
  const location = await locate(user, kind, id);
  const base = { kind, id, domain: location.domain };
  if (!location.domain) return { ...base, available: false, reason: 'this object has no domain repository yet', releases: [] };
  if (!location.tagPrefix) {
    return { ...base, available: false, reason: `a ${GIT_OBJECT_LAYOUT[kind].label} does not publish release tags`, releases: [] };
  }
  const store = (await import('@core/infra/git-store')) as unknown as Record<string, unknown>;
  const listTags = typeof store.listTags === 'function' ? (store.listTags as (domain: string, prefix: string, o?: GitStoreOptions) => Promise<UnknownTag[]>) : null;
  if (!listTags) {
    return { ...base, available: false, reason: 'the annotated-tag API is not in this build yet, so releases cannot be read', releases: [] };
  }
  const reposDir = opts.reposDir ?? config.reposDir;
  const tags = await listTags(location.domain, location.tagPrefix, { reposDir });
  return { ...base, available: true, reason: '', releases: tags.map(normaliseTag).filter((r) => r.tag.length > 0) };
}
