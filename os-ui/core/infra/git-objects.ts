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
 *
 * KNOWN BLIND SPOT (review L-5, backlog). A resolver derives its path selectors from the object's
 * CURRENT placement, so the path fallback only finds commits under where the object lives NOW. A
 * rename or a lane move (Personal → Shared) changes the directory, so commits made under the OLD
 * path are invisible to the fallback — they are still found by the `OS-Object` trailer, which is
 * the identity, so a user's own history is complete; what can be missing is the OLD-path portion
 * of a PLATFORM-attributed history (a boot reconcile before a rename). The fix is a path history
 * (`--follow`-style, or recording previous paths in `index.yml`); until then `via` reports how the
 * answer was found and `truncated` never claims completeness.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import {
  logPaths,
  readFilesAt,
  diffPaths,
  log,
  commitAt,
  parseTrailers,
  scrubSecrets,
  MAX_LOG_DEPTH,
  type LogEntry,
  type FileAtCommit,
  type FileDiff,
  type GitStoreOptions,
  type RepoSummary,
} from '@core/infra/git-store';
import { trailersNameObject } from '@core/infra/git-trailers';
import type { MirrorSignal } from '@core/infra/git-mirror';

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
    // Night-2 merge: stream M landed the semantic emitter, which writes
    // `models/semantic/<model>.yml` (personal lane `models/personal/<uid>/semantic/`) through the
    // SAME dbt commit module as a dataset, stamping `OS-Object: metric:<datasetId>.<measure>`
    // (`metricObjectId`). NOTE: no tab has called `registerGitObject('metric', …)` yet, so the
    // generic reads still answer the typed `kind_not_wired` for this kind — committed writer,
    // unwired reader, and both facts are visible rather than averaged into one.
    writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'night 2, stream M' },
  },
  dashboard: {
    kind: 'dashboard',
    label: 'dashboard-as-code',
    paths: ['dashboards/index.yml', 'dashboards/<slug>/'],
    personalLane: 'dashboards/personal/<uid>/<slug>/',
    // Night-2 merge: stream D landed the writer, so the row is flipped. The resolver resolves the
    // slug through the committed `dashboards/index.yml` (`pathsForDashboard`) — slug != id.
    writer: { state: 'committed', via: 'tabs/dashboards/lib/git/commit.ts', since: 'night 2, stream D' },
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
    // Night-2 merge: `apps/<slug>/.app/release.json` is NOT a path tonight — `release_software`
    // did not land, so declaring it would describe a file nothing writes.
    paths: ['apps/<slug>/'],
    personalLane: null,
    writer: { state: 'committed', via: 'tabs/software/lib/git-commit.ts', since: 'night 2, stream S' },
  },
  'lifecycle-pin': {
    kind: 'lifecycle-pin',
    label: 'lifecycle pin',
    // Night-2 merge: V landed the writer, and the PATH is not what this row guessed. A single
    // `os/lifecycle.yml` is not representable with today's git-store exports, so V commits
    // `os/lifecycle/pins.yml` inside its own reserved subtree (`LIFECYCLE_PIN_PATH`), and the
    // writer is `core/infra/lifecycle-pins.ts` — `core/kernel/lifecycle.ts` reaches no commit
    // primitive. Both corrected here rather than left describing a file nothing writes.
    paths: ['os/lifecycle/pins.yml'],
    personalLane: null,
    writer: { state: 'committed', via: 'core/infra/lifecycle-pins.ts', since: 'night 2, stream V' },
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

/**
 * Does this commit's trailer block name `id`? `OS-Object` is `<id>` or `<id> (<name>)`; a
 * WHOLE-SUBTREE commit additionally lists every id it carried in `OS-Objects` (space-separated,
 * stream X's R1), and the match there is on a whole token — `sys_abc` must never match
 * `sys_abcd`.
 *
 * NIGHT-2 MERGE (G x X): the rule itself is NOT here. `core/infra/git-trailers.ts`
 * `trailersNameObject` is the single trailer predicate every read-back uses — this function is the
 * message-to-trailers adapter in front of it, and nothing else. It previously carried its own copy
 * of the rule, which split on a single space where X's splits on any whitespace run; one of the
 * two would have drifted.
 */
function trailerNames(message: string, id: string): boolean {
  return trailersNameObject(parseTrailers(message), id);
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
    // Review L-4: the window is already in memory — the fallback must not pay for a second walk.
    const byPath = await logPaths(location.domain, location.paths, { reposDir, limit, scan, window });
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
  /** True when the version holds more files or bytes than one read returns. */
  truncated: boolean;
  /** Why it was cut: the file count, the byte budget, or not at all. */
  truncatedBy: 'files' | 'bytes' | null;
  /** Bytes of the files returned. */
  bytes: number;
  /** True when the secret scrub altered any file below (see `redactedPaths`). */
  redacted: boolean;
  /** Which files were altered, and by which pattern — so the change is never silent. */
  redactedPaths: { path: string; kinds: string[] }[];
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

/**
 * `getVersion(kind, id, sha)` — the object's files exactly as they were at that commit, with
 * anything secret-shaped REDACTED (review M-1) and binary blobs named rather than decoded.
 *
 * The scrub is at this boundary on purpose: this is the governed read-out that hands repository
 * bytes to a browser or an AI client, while `restoreVersion` re-applies the RAW bytes through the
 * object's writer, so a redaction can never be written back into the tree.
 */
export async function getVersion(user: CurrentUser, kind: GitObjectKind, id: string, sha: string, opts: GitStoreOptions = {}): Promise<ObjectVersion> {
  const location = await locate(user, kind, id);
  assertHasRepo(kind, id, location);
  const ref = assertSha(sha);
  const reposDir = opts.reposDir ?? config.reposDir;
  const at = await readFilesAt(location.domain, ref, location.paths, { reposDir });
  // Review M-5: ONE commit read by sha, instead of walking up to 2000 commits to find it.
  const entry = await commitAt(location.domain, at.sha, { reposDir });
  const redactedPaths: { path: string; kinds: string[] }[] = [];
  const files = at.files.map((f) => {
    if (f.binary) return f;
    const scrubbed = scrubSecrets(f.content);
    if (scrubbed.redactions > 0) redactedPaths.push({ path: f.path, kinds: scrubbed.kinds });
    return { ...f, content: scrubbed.text };
  });
  return {
    kind,
    id,
    domain: location.domain,
    sha: at.sha,
    commit: entry ? toCommit(entry) : null,
    files,
    present: at.files.length > 0,
    truncated: at.truncated,
    truncatedBy: at.truncatedBy,
    bytes: at.bytes,
    redacted: redactedPaths.length > 0,
    redactedPaths,
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
  /** True when the secret scrub altered any patch above (review M-1). */
  redacted: boolean;
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
  const result = await diffPaths(location.domain, a, b, location.paths, {
    reposDir,
    redact: true, // the governed read-out never emits secret-shaped bytes (review M-1)
    ...(opts.context !== undefined ? { context: opts.context } : {}),
  });
  return {
    kind,
    id,
    domain: location.domain,
    a: result.a,
    b: result.b,
    files: result.files,
    patch: result.patch,
    identical: result.files.length === 0,
    redacted: result.redacted,
  };
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
  // Review L-1: the UNSUPPORTED refusal comes FIRST. Reading a whole version off the disk only to
  // refuse it afterwards was work (and a failure surface) for an answer already known.
  if (!reg.restore) {
    throw new GitObjectError(
      `restoring a ${kind} is not available yet: its tab has not registered a writer for restore, and the OS will not re-apply a version except through the object's normal write path`,
      501,
      'restore_unsupported',
    );
  }
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
  // A binary blob reads back with an EMPTY content (review M-3), so re-applying it would WRITE a
  // zero-byte file over an image or a wheel. Refuse: a restore that silently truncates a file is
  // worse than no restore.
  const binary = at.files.filter((f) => f.binary).map((f) => f.path);
  if (binary.length > 0) {
    throw new GitObjectError(
      `${kind} '${id}' at ${at.sha.slice(0, 7)} contains binary file(s) the OS cannot re-apply without truncating them (${binary.slice(0, 3).join(', ')})`,
      409,
      'binary_in_version',
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


// --------------------------------------------- operator surfaces (H-2) ---

/** The object id inside an `OS-Object` trailer (`<id> (<name>)` → `<id>`). */
export function trailerObjectId(trailer: string): string {
  return String(trailer ?? '').trim().split(' ')[0] ?? '';
}

/**
 * Which object, if any, this commit trailer names THAT THIS CALLER MAY SEE. Used by the operator
 * commit log so it cannot become a way to enumerate other people's Personal object names: every
 * registered kind's resolver is asked (each running the tab's own governed read as the caller),
 * and an id nothing resolves is NOT shown.
 *
 * FAILS CLOSED, and says so to its caller rather than quietly dropping rows: a kind whose
 * resolver is not registered yet cannot be checked, so its commits are counted as hidden.
 */
export async function resolveTrailerForUser(user: CurrentUser, trailer: string): Promise<{ kind: GitObjectKind; id: string } | null> {
  const id = trailerObjectId(trailer);
  if (!id) return null;
  for (const kind of registeredGitObjectKinds()) {
    const reg = registry().get(kind);
    if (!reg) continue;
    try {
      const location = await reg.resolve(user, id);
      if (location) return { kind, id };
    } catch {
      /* a tab's read throws for an object the caller may not see — that is a "no" */
    }
  }
  return null;
}


// ----------------------------------------- the operator payloads (H-1/H-2) ---

/** One repository row for the operator view: the git summary plus its mirror health record. */
export type RepositoryOverviewRow = RepoSummary & { mirror: MirrorSignal | null };

export type RepositoriesOverview = {
  repos: RepositoryOverviewRow[];
  layout: (Omit<GitObjectLayout, 'kind'> & { kind: GitObjectKind })[];
};

export type OverviewDeps = GitStoreOptions & {
  /** Injected for tests; defaults to the mirror store's lazy hydration. */
  hydrate?: () => Promise<void>;
  /** Injected for tests; defaults to the mirror store's health records. */
  signals?: () => MirrorSignal[];
  /** Injected for tests; defaults to the git store's own summaries. */
  summaries?: () => Promise<RepoSummary[]>;
};

/**
 * Every domain repository with its head, its commit count and its mirror verdict.
 *
 * HYDRATE FIRST (review H-1). The mirror records load lazily from the durable index, so reading
 * them on a cold pod without awaiting that returned NOTHING — and "nothing" renders as "no
 * push-mirror configured", a false all-clear on the one surface that exists to show push
 * failures. The await is the whole point of this function, which is why it is here and tested
 * rather than inline in a route.
 */
export async function repositoriesOverview(deps: OverviewDeps = {}): Promise<RepositoriesOverview> {
  const mirror = deps.hydrate && deps.signals ? null : await import('@core/infra/git-mirror');
  // THE ORDER IS THE FIX: hydrate, THEN read. Never the other way round.
  await (deps.hydrate ?? mirror!.ensureMirrorsHydrated)();
  const rows = await (deps.summaries ?? (async () => {
    const { repoSummaries } = await import('@core/infra/git-store');
    return repoSummaries(deps);
  }))();
  const mirrors = new Map((deps.signals ?? mirror!.mirrorSignals)().map((m) => [m.domain, m]));
  return {
    repos: rows.map((r) => ({ ...r, mirror: mirrors.get(r.domain) ?? null })),
    layout: GIT_OBJECT_KINDS.map((k) => GIT_OBJECT_LAYOUT[k]),
  };
}

export type RepositoryCommitRow = {
  sha: string;
  subject: string;
  author: string;
  at: string;
  action: string;
  surface: string;
  object: string;
  kind: GitObjectKind;
  reason: string;
};

export type RepositoryCommitLog = {
  domain: string;
  commits: RepositoryCommitRow[];
  /** How many commits in the window were NOT listed because their object did not resolve. */
  hidden: number;
  /** Why, when any were — never a quietly shorter list. */
  note: string;
};

/**
 * One repository's commit log, filtered to the commits whose object THIS CALLER can resolve
 * (review H-2).
 *
 * The role gate (admin) is the route's; this is the second, independent gate: `domain` arrives
 * from a query string and a commit subject carries the object's slug, which for a Personal object
 * is somebody's own artefact name. A commit whose `OS-Object` resolves to nothing the caller may
 * see is counted, not silently dropped.
 */
export async function repositoryCommitLog(
  user: CurrentUser,
  domain: string,
  opts: GitStoreOptions & { limit?: number } = {},
): Promise<RepositoryCommitLog> {
  const reposDir = opts.reposDir ?? config.reposDir;
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const entries = await log(domain, { reposDir, limit });
  const commits: RepositoryCommitRow[] = [];
  let hidden = 0;
  for (const e of entries) {
    const trailer = e.trailers['OS-Object'] ?? '';
    const resolved = trailer ? await resolveTrailerForUser(user, trailer) : null;
    if (!resolved) {
      hidden++;
      continue;
    }
    commits.push({
      sha: e.sha,
      subject: e.subject,
      author: e.author.name,
      at: new Date(e.timestamp * 1000).toISOString(),
      action: e.trailers['OS-Action'] ?? '',
      surface: e.trailers['OS-Surface'] ?? '',
      object: trailer,
      kind: resolved.kind,
      reason: e.trailers['OS-Reason'] ?? '',
    });
  }
  return {
    domain,
    commits,
    hidden,
    note:
      hidden > 0
        ? `${hidden} of ${entries.length} commits are not listed: their object could not be resolved for you — either you cannot see it, or its object kind has no resolver registered yet (see docs/components/git.md).`
        : '',
  };
}
