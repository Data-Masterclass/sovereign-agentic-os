/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Git store — one bare repository per domain, written in-process by the OS
 * USER STORY: As a data or AI engineer I want everything the OS builds for my domain (dbt project,
 *             agent systems) to land in a real git repository, committed as me, with a message that
 *             names the action and where it came from — so I can read, export and mirror it like any
 *             repo, and nothing I build lives only inside the OS.
 * ARCHITECTURE:
 *   - isomorphic-git (MIT, pure JS) over node:fs. Bare repos under `config.reposDir`
 *     (`OS_REPOS_DIR`, default /repos — the `os-repos` PVC; tests pass a temp dir).
 *   - `commitTree` writes the WHOLE desired tree (content-addressed, so unchanged blobs cost
 *     nothing) and commits ONLY when the root tree hash changed — regeneration is idempotent.
 *   - Author = the acting user; committer = `Sovereign OS`. Message = `<area>(<domain>): <action>
 *     <object> — via <surface>` + git trailers (OS-Action / OS-Object / OS-Surface / OS-Request-Id).
 *   - In-process per-repo mutex (os-ui is single-replica; one RWO writer — see the concept §2.1).
 *   - Lives in @core because BOTH the Data and the Agents tab commit through it (a tab may not
 *     import another tab). It knows nothing about datasets or systems: paths + strings in.
 *   - SUBTREE OWNERSHIP (Part D): one repo per domain holds two generated worlds — the dbt
 *     project at the root and `agents/` — written by two independent generators. `commitSubtree`
 *     replaces exactly one prefix and keeps the rest of the tree; `reserveSubtree` lets a subtree
 *     owner declare its prefix so a WHOLE-TREE writer (`commitTree`) cannot clobber it. Both are
 *     generic: the registry holds path prefixes, never a tab's vocabulary.
 *   - DESTRUCTIVE-DELTA GUARD (Part D review H-1): a commit marked `OS-Reason: boot-reconcile`
 *     that would delete more than half of the files it already tracks in its own scope is REFUSED
 *     (`DestructiveReconcileError`) and logged. Boot-time generators read a store that can hydrate
 *     EMPTY without throwing, and an empty generated tree committed by a reconcile is indisputably
 *     a bad read, not a deletion. A human-initiated commit is never subject to it.
 *   - `push` to a mirror resolves the token through the secrets helper at call time and never
 *     logs, returns or persists it; errors are scrubbed before they leave this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { config } from '@core/kernel/config';
import { tarArchive } from '@core/infra/tar';
import { currentSurface } from '@core/infra/request-surface';

export const MAIN = 'refs/heads/main';
export const COMMITTER = { name: 'Sovereign OS', email: 'os@sovereign.local' } as const;

export type GitAuthor = { name: string; email: string };
export type GitStoreOptions = { reposDir?: string };
export type CommitResult = { sha: string; changed: boolean };
export type LogEntry = {
  sha: string;
  subject: string;
  message: string;
  author: GitAuthor;
  committer: GitAuthor;
  /** Unix seconds. */
  timestamp: number;
  parents: string[];
  tree: string;
  trailers: Record<string, string>;
};
export type TreeEntry = { path: string; oid: string; mode: string };
export type MirrorConfig = { url: string; tokenSecretRef: { name: string; key: string } };
export type PushResult = { ok: true; sha: string } | { ok: false; error: string };

export class GitStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GitStoreError';
    this.status = status;
  }
}

// ----------------------------------------------------------------- naming ---

const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `<reposDir>/<domain>.git`. A domain must be a safe single path segment (no `/`, no `..`). */
export function repoPath(domain: string, opts: GitStoreOptions = {}): string {
  if (!DOMAIN_RE.test(domain) || domain.includes('..')) {
    throw new GitStoreError(`invalid repository name '${domain}'`);
  }
  return path.join(opts.reposDir ?? config.reposDir, `${domain}.git`);
}

/** A repo-relative file path: no leading slash, no `.`/`..` segments, no empty segments. */
function assertRepoPath(p: string): string {
  const parts = p.split('/');
  if (p.startsWith('/') || parts.some((s) => s === '' || s === '.' || s === '..')) {
    throw new GitStoreError(`invalid path in tree: '${p}'`);
  }
  return p;
}

// ------------------------------------------------------------------ mutex ---

const LOCK_KEY = Symbol.for('soa.git-store.locks');
function locks(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  if (!g[LOCK_KEY]) g[LOCK_KEY] = new Map();
  return g[LOCK_KEY]!;
}

/** Serialise writers per repository path (in-process). */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks().get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks().set(key, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    if (locks().get(key) === run.catch(() => undefined)) locks().delete(key);
  }
}

// ------------------------------------------------------------------- repos ---

export function repoExists(domain: string, opts: GitStoreOptions = {}): boolean {
  return fs.existsSync(path.join(repoPath(domain, opts), 'HEAD'));
}

/**
 * Every repository under `reposDir` with its `main` head (null when it has no commit yet). The
 * git protocol cannot enumerate repositories, so this is the index the Dagster `repo-sync` sidecar
 * polls (engine rebuild B2, deviation B1-8). Sorted by name; a missing directory is an empty list.
 */
export async function listRepos(opts: GitStoreOptions = {}): Promise<{ name: string; head: string | null }[]> {
  const dir = opts.reposDir ?? config.reposDir;
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; head: string | null }[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.git')) continue;
    const name = entry.slice(0, -'.git'.length);
    if (!DOMAIN_RE.test(name) || name.includes('..') || !fs.existsSync(path.join(dir, entry, 'HEAD'))) continue;
    out.push({ name, head: await headSha(path.join(dir, entry)) });
  }
  return out;
}

/** Open the domain's bare repo, creating it (branch `main`) on first use. */
export async function openOrInit(domain: string, opts: GitStoreOptions = {}): Promise<{ gitdir: string }> {
  const gitdir = repoPath(domain, opts);
  if (!fs.existsSync(path.join(gitdir, 'HEAD'))) {
    fs.mkdirSync(gitdir, { recursive: true });
    await git.init({ fs, dir: gitdir, gitdir, bare: true, defaultBranch: 'main' });
  }
  return { gitdir };
}

async function headSha(gitdir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir, ref: MAIN });
  } catch {
    return null;
  }
}

/** Resolve `main` / `HEAD` / a full or abbreviated sha to a commit oid. */
async function resolveCommit(gitdir: string, ref: string | undefined): Promise<string> {
  const r = (ref ?? 'main').trim();
  if (/^[0-9a-f]{40}$/i.test(r)) return r.toLowerCase();
  if (/^[0-9a-f]{4,39}$/i.test(r)) {
    try {
      return await git.expandOid({ fs, gitdir, oid: r.toLowerCase() });
    } catch {
      /* fall through to a ref lookup */
    }
  }
  // Only `main` / `HEAD` / a sha are addressable (review L1): the repos have one branch, and a
  // caller-supplied ref must never reach the filesystem-backed ref resolver as a path.
  if (r !== 'main' && r !== 'HEAD') throw new GitStoreError(`ref '${r.slice(0, 60)}' is not addressable (use main, HEAD or a commit sha)`, 400);
  try {
    return await git.resolveRef({ fs, gitdir, ref: r === 'main' ? MAIN : r });
  } catch {
    throw new GitStoreError(`ref '${r}' not found`, 404);
  }
}

// --------------------------------------------------------------- messages ---

export type CommitMessageInput = {
  area: 'data' | 'agents';
  domain: string;
  action: string;
  object: string;
  /** `ui:<route>` or `mcp:<tool>`. */
  surface: string;
  requestId: string;
  /** Optional stable id for the OS-Object trailer (`<id> (<name>)`); defaults to `object`. */
  objectId?: string;
  /**
   * The agent run this write happened inside, for the `OS-Run-Id` trailer. Omitted ⇒ taken from
   * the ambient request scope (`core/infra/request-surface`), which is how a NESTED granted-tool
   * call inside a run gets attributed without every writer threading a run id through its
   * signature. Outside a run there is no trailer at all — never a fabricated one.
   */
  runId?: string;
};

const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/;

function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** `data(sales): build gold order_customer — via mcp:build_gold_join` + the OS trailers. */
export function commitMessage(input: CommitMessageInput): string {
  const subject = `${input.area}(${input.domain}): ${oneLine(input.action)} ${oneLine(input.object)} — via ${oneLine(input.surface)}`;
  return appendTrailers(subject, {
    'OS-Action': oneLine(input.action),
    'OS-Object': oneLine(input.objectId ?? input.object),
    'OS-Surface': oneLine(input.surface),
    'OS-Request-Id': oneLine(input.requestId),
    // Part D review L-3: a granted tool called by an agent run commits inside the run's scope,
    // so the commit says WHICH run caused it. Empty ⇒ `appendTrailers` drops the line.
    'OS-Run-Id': oneLine(input.runId ?? currentSurface()?.runId ?? ''),
  });
}

/** Append `Key: value` trailers, joining an existing trailing block when present. */
export function appendTrailers(message: string, trailers: Record<string, string>): string {
  const lines = Object.entries(trailers)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `${k}: ${oneLine(v)}`);
  const body = message.replace(/\s+$/, '');
  if (lines.length === 0) return body + '\n';
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].split('\n');
  const endsWithTrailers = paragraphs.length > 1 && last.every((l) => TRAILER_RE.test(l));
  return (endsWithTrailers ? body + '\n' : body + '\n\n') + lines.join('\n') + '\n';
}

/** The trailer block of a commit message (last paragraph of `Key: value` lines). */
export function parseTrailers(message: string): Record<string, string> {
  const paragraphs = message.replace(/\s+$/, '').split(/\n\s*\n/);
  if (paragraphs.length < 2) return {};
  const last = paragraphs[paragraphs.length - 1].split('\n');
  const out: Record<string, string> = {};
  for (const l of last) {
    const m = l.match(TRAILER_RE);
    if (!m) return {};
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * The local part of a synthesized address: the principal id reduced to a safe mailbox token.
 * Part D review L-2: an id that is ALREADY e-mail-shaped (`amir@acme.com`) produced the malformed
 * `amir@acme.com@os.local`, which git writes verbatim and every mail-aware tool mis-parses. Only
 * the part before the first `@` is kept, and anything outside the safe set becomes `-`.
 */
function mailboxToken(id: string): string {
  const local = String(id ?? '').split('@')[0];
  const safe = local.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return safe || 'unknown';
}

/**
 * The git author for an acting user. A user without an e-mail gets `<id>@os.local`, and the
 * caller must say so in the commit (`OS-Author-Email: synthesized`) — never a silent invention.
 */
export function authorFor(user: { id: string; name?: string | null; email?: string | null }): { author: GitAuthor; synthesized: boolean } {
  const name = oneLine(user.name ?? '') || user.id;
  const email = oneLine(user.email ?? '');
  if (email) return { author: { name, email }, synthesized: false };
  return { author: { name, email: `${mailboxToken(user.id)}@os.local` }, synthesized: true };
}

// ------------------------------------------------------- subtree ownership ---

const RESERVE_KEY = Symbol.for('soa.git-store.reserved-subtrees');
function reserved(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[RESERVE_KEY]) g[RESERVE_KEY] = new Set();
  return g[RESERVE_KEY]!;
}

/** `agents` / `agents/` → `agents/`. Throws on an unsafe or empty prefix. */
function normalizePrefix(prefix: string): string {
  const p = String(prefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) throw new GitStoreError('a subtree needs a path prefix');
  assertRepoPath(p);
  return `${p}/`;
}

/**
 * Declare `prefix` the property of another writer. A WHOLE-TREE commit (`commitTree`) then keeps
 * every existing path under it that its own file map does not mention, instead of deleting it.
 * Idempotent; registered at boot by the subtree's owner (os-ui is single-process per replica).
 */
export function reserveSubtree(prefix: string): void {
  reserved().add(normalizePrefix(prefix));
}

/** The reserved prefixes, sorted (each ends in `/`). */
export function reservedSubtrees(): string[] {
  return [...reserved()].sort();
}

/** Test hook. */
export function __clearReservedSubtrees(): void {
  reserved().clear();
}

// ------------------------------------------------------------------ commit ---

/** A tree leaf: new content to write, or an existing blob kept verbatim. */
type Leaf = { content: string; oid?: undefined; mode?: string } | { oid: string; content?: undefined; mode?: string };
type Dir = { files: Map<string, Leaf>; dirs: Map<string, Dir> };

function buildDirTree(files: Map<string, Leaf>): Dir {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [p, leaf] of files) {
    assertRepoPath(p);
    const parts = p.split('/');
    let cur = root;
    for (const seg of parts.slice(0, -1)) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    const leafName = parts[parts.length - 1];
    if (cur.dirs.has(leafName)) throw new GitStoreError(`'${p}' is both a file and a directory`);
    cur.files.set(leafName, leaf);
  }
  return root;
}

async function writeDir(gitdir: string, dir: Dir): Promise<string> {
  const entries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
  for (const [name, leaf] of dir.files) {
    if (dir.dirs.has(name)) throw new GitStoreError(`'${name}' is both a file and a directory`);
    const oid = leaf.oid ?? (await git.writeBlob({ fs, gitdir, blob: new Uint8Array(Buffer.from(leaf.content ?? '', 'utf8')) }));
    entries.push({ mode: leaf.mode ?? '100644', path: name, oid, type: 'blob' });
  }
  for (const [name, sub] of dir.dirs) {
    const oid = await writeDir(gitdir, sub);
    entries.push({ mode: '040000', path: name, oid, type: 'tree' });
  }
  // git orders tree entries by name, directories compared as `name/`.
  entries.sort((a, b) => {
    const an = a.type === 'tree' ? `${a.path}/` : a.path;
    const bn = b.type === 'tree' ? `${b.path}/` : b.path;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return git.writeTree({ fs, gitdir, tree: entries });
}

export type CommitTreeOptions = GitStoreOptions & {
  author: GitAuthor;
  /** Subject (+ optional body). Trailers from `commitMessage` may already be included. */
  message: string;
  /** Extra trailers appended to the message's trailer block. */
  trailers?: Record<string, string>;
  /** Unix seconds for author + committer time (default: now). */
  timestamp?: number;
};

/** Every blob of a commit, as repo-relative path → `{oid, mode}`. */
async function entriesAt(gitdir: string, commitOid: string): Promise<Map<string, Leaf>> {
  const out = new Map<string, Leaf>();
  const walk = async (treeOid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const e of tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else out.set(p, { oid: e.oid, mode: e.mode });
    }
  };
  const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
  await walk(commit.tree, '');
  return out;
}

// ----------------------------------------------- destructive-delta guard ---

/** The `OS-Reason` value that marks a commit as an automatic catch-up, not a person's action. */
export const RECONCILE_REASON = 'boot-reconcile';
/**
 * A reconcile may remove at most this FRACTION of the files it already tracks in the part of the
 * tree it owns — and even then only while it CREATES nothing (see {@link assertNotDestructive}).
 * Above it, the commit is refused: a generator that wants to delete most of its own world and put
 * nothing in its place is far more likely to be reading an EMPTY store (the Sept-2026 login outage
 * shape: a mirror blip hydrates the registry to nothing WITHOUT throwing) than to be recording a
 * real mass deletion. A real one is still recorded — by the write path, as the person who did it.
 */
export const RECONCILE_MAX_DELETE_RATIO = 0.5;

/** The typed refusal of a reconcile commit that would delete most of its own tree. */
export class DestructiveReconcileError extends GitStoreError {
  readonly code = 'destructive_reconcile';
  readonly domain: string;
  readonly scope: string;
  readonly deleted: number;
  readonly tracked: number;
  constructor(domain: string, scope: string, deleted: string[], tracked: number) {
    super(
      `refusing a ${RECONCILE_REASON} commit for '${domain}': it would delete ${deleted.length} of ${tracked} tracked file(s) under ${scope} ` +
        `(more than ${Math.round(RECONCILE_MAX_DELETE_RATIO * 100)}%) and add none — e.g. ${deleted.slice(0, 3).join(', ')}. ` +
        'A generator that empties its own tree is treated as a bad read (an unhydrated store), not as a deletion. ' +
        'Nothing was committed and nothing was pushed.',
      409,
    );
    this.name = 'DestructiveReconcileError';
    this.domain = domain;
    this.scope = scope;
    this.deleted = deleted.length;
    this.tracked = tracked;
  }
}

/** Is this commit an automatic catch-up (`OS-Reason: boot-reconcile`), from either trailer source? */
function isReconcileCommit(opts: CommitTreeOptions): boolean {
  const explicit = opts.trailers?.['OS-Reason'];
  if (typeof explicit === 'string' && explicit.trim() === RECONCILE_REASON) return true;
  return parseTrailers(opts.message)['OS-Reason'] === RECONCILE_REASON;
}

/**
 * Refuse a RECONCILE commit that would delete more than {@link RECONCILE_MAX_DELETE_RATIO} of the
 * files already tracked in its own scope (`tracked`: the subtree for `commitSubtree`, everything
 * outside the reserved subtrees for `commitTree`) AND would create nothing in their place.
 *
 * BOTH conditions matter. A reconcile that replaces one system's files with another's deletes a
 * large share and is perfectly legitimate — the catch-up it exists for. A reconcile that deletes a
 * large share and adds NOT ONE path is generating from an empty registry: every file it still
 * writes is one it already had. That is the outage shape, and it is refused.
 *
 * A human-initiated commit is never subject to this — a person deleting their last system still
 * gets the removal committed, as themselves.
 */
function assertNotDestructive(domain: string, scope: string, tracked: string[], files: Map<string, string>, opts: CommitTreeOptions): void {
  if (!isReconcileCommit(opts) || tracked.length === 0) return;
  const deleted = tracked.filter((p) => !files.has(p));
  if (deleted.length <= tracked.length * RECONCILE_MAX_DELETE_RATIO) return;
  const known = new Set(tracked);
  if ([...files.keys()].some((p) => !known.has(p))) return; // it is REPLACING, not emptying
  const err = new DestructiveReconcileError(domain, scope, deleted, tracked.length);
  console.error(`[git-store] ${err.message}`);
  throw err;
}

/** Write the merged tree and commit iff its hash differs from HEAD's. Call inside the repo lock. */
async function commitLeaves(gitdir: string, head: string | null, files: Map<string, Leaf>, opts: CommitTreeOptions): Promise<CommitResult> {
  const tree = await writeDir(gitdir, buildDirTree(files));
  if (head) {
    const { commit } = await git.readCommit({ fs, gitdir, oid: head });
    if (commit.tree === tree) return { sha: head, changed: false };
  }
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const message = appendTrailers(opts.message, opts.trailers ?? {});
  const sha = await git.writeCommit({
    fs,
    gitdir,
    commit: {
      message,
      tree,
      parent: head ? [head] : [],
      author: { ...opts.author, timestamp, timezoneOffset: 0 },
      committer: { ...COMMITTER, timestamp, timezoneOffset: 0 },
    },
  });
  await git.writeRef({ fs, gitdir, ref: MAIN, value: sha, force: true });
  return { sha, changed: true };
}

/**
 * Write `files` as the complete tree of `main` and commit iff the tree hash changed.
 * Returns the resulting head (`changed: false` ⇒ the existing head, nothing written).
 *
 * Paths under a {@link reserveSubtree} prefix that `files` does not itself mention are KEPT from
 * the current head: a whole-tree generator owns everything except another writer's declared
 * subtree. With no reservation this is exactly "the tree is what you passed".
 */
export async function commitTree(domain: string, files: Map<string, string>, opts: CommitTreeOptions): Promise<CommitResult> {
  const { gitdir } = await openOrInit(domain, opts);
  return withLock(gitdir, async () => {
    const head = await headSha(gitdir);
    const leaves = new Map<string, Leaf>();
    const prefixes = reservedSubtrees();
    const existing = head ? await entriesAt(gitdir, head) : new Map<string, Leaf>();
    for (const [p, leaf] of existing) {
      if (prefixes.some((pre) => p.startsWith(pre)) && !files.has(p)) leaves.set(p, leaf);
    }
    // A whole-tree writer owns everything EXCEPT another writer's reserved subtree, so that is
    // the scope the destructive-delta guard measures.
    assertNotDestructive(domain, 'the project tree', [...existing.keys()].filter((p) => !prefixes.some((pre) => p.startsWith(pre))), files, opts);
    for (const [p, content] of files) leaves.set(p, { content });
    return commitLeaves(gitdir, head, leaves, opts);
  });
}

/**
 * Replace exactly the subtree `prefix` with `files` and keep every other path at its current
 * blob. An empty `files` therefore DELETES the subtree — which is how an archive or a delete is
 * recorded. Every key must sit under `prefix`. Commits iff the resulting tree hash changed.
 */
export async function commitSubtree(domain: string, prefix: string, files: Map<string, string>, opts: CommitTreeOptions): Promise<CommitResult> {
  const pre = normalizePrefix(prefix);
  for (const p of files.keys()) {
    if (!p.startsWith(pre)) throw new GitStoreError(`'${p}' is outside the subtree '${pre}'`);
  }
  const { gitdir } = await openOrInit(domain, opts);
  return withLock(gitdir, async () => {
    const head = await headSha(gitdir);
    const leaves = new Map<string, Leaf>();
    const mine: string[] = [];
    if (head) {
      for (const [p, leaf] of await entriesAt(gitdir, head)) {
        if (p.startsWith(pre)) mine.push(p);
        else leaves.set(p, leaf);
      }
    }
    assertNotDestructive(domain, `'${pre}'`, mine, files, opts);
    for (const [p, content] of files) leaves.set(p, { content });
    return commitLeaves(gitdir, head, leaves, opts);
  });
}

// -------------------------------------------------------------------- reads ---

/**
 * How deep ONE log read may walk. A domain repo mixes the dbt project's commits with every agent
 * system's, so a per-object history has to scan more than it returns; 2000 bounds the walk while
 * leaving room for a busy domain (Part D review L-1).
 */
export const MAX_LOG_DEPTH = 2000;

/** Newest first. An empty repo (no commits yet) yields `[]`. */
export async function log(domain: string, opts: GitStoreOptions & { limit?: number } = {}): Promise<LogEntry[]> {
  if (!repoExists(domain, opts)) return [];
  const gitdir = repoPath(domain, opts);
  if (!(await headSha(gitdir))) return [];
  const entries = await git.log({ fs, gitdir, ref: MAIN, depth: Math.max(1, Math.min(opts.limit ?? 50, MAX_LOG_DEPTH)) });
  return entries.map((e) => ({
    sha: e.oid,
    subject: e.commit.message.split('\n')[0],
    message: e.commit.message,
    author: { name: e.commit.author.name, email: e.commit.author.email },
    committer: { name: e.commit.committer.name, email: e.commit.committer.email },
    timestamp: e.commit.author.timestamp,
    parents: e.commit.parent,
    tree: e.commit.tree,
    trailers: parseTrailers(e.commit.message),
  }));
}

/** One file at a ref (`main`, `HEAD`, a sha), as UTF-8. 404 when missing. */
export async function readBlob(domain: string, ref: string | undefined, filepath: string, opts: GitStoreOptions = {}): Promise<string> {
  if (!repoExists(domain, opts)) throw new GitStoreError(`no repository for '${domain}'`, 404);
  const gitdir = repoPath(domain, opts);
  const oid = await resolveCommit(gitdir, ref);
  try {
    const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: assertRepoPath(filepath) });
    return Buffer.from(blob).toString('utf8');
  } catch (e) {
    if (e instanceof GitStoreError) throw e;
    throw new GitStoreError(`'${filepath}' not found at ${ref ?? 'main'}`, 404);
  }
}

/** Every file (recursively) at a ref, sorted by path. */
export async function listTree(domain: string, ref: string | undefined, opts: GitStoreOptions = {}): Promise<TreeEntry[]> {
  if (!repoExists(domain, opts)) return [];
  const gitdir = repoPath(domain, opts);
  if (!(await headSha(gitdir))) return [];
  const oid = await resolveCommit(gitdir, ref);
  const out: TreeEntry[] = [];
  const walk = async (treeOid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const e of tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else out.push({ path: p, oid: e.oid, mode: e.mode });
    }
  };
  const { commit } = await git.readCommit({ fs, gitdir, oid });
  await walk(commit.tree, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A tar of the whole tree at a ref (file mtimes = the commit time, so the archive is stable). */
export async function archive(domain: string, ref: string | undefined, opts: GitStoreOptions = {}): Promise<{ sha: string; tar: Buffer }> {
  if (!repoExists(domain, opts)) throw new GitStoreError(`no repository for '${domain}'`, 404);
  const gitdir = repoPath(domain, opts);
  const sha = await resolveCommit(gitdir, ref);
  const { commit } = await git.readCommit({ fs, gitdir, oid: sha });
  const entries = await listTree(domain, sha, opts);
  const files = [];
  for (const e of entries) {
    const { blob } = await git.readBlob({ fs, gitdir, oid: e.oid });
    files.push({ path: e.path, content: blob, mtime: commit.committer.timestamp });
  }
  return { sha, tar: tarArchive(files) };
}

// --------------------------------------------------------------------- push ---

/** Replace every occurrence of the secret in a message — a push error must never carry the token. */
function scrub(message: string, secret: string | null): string {
  if (!secret) return message;
  return message.split(secret).join('***');
}

export type PushDeps = GitStoreOptions & {
  /** Resolve the mirror token from its Secret reference. Defaults to the secrets helper. */
  resolveToken?: (ref: { name: string; key: string }) => Promise<string | null> | string | null;
  /**
   * The isomorphic-git HTTP transport. Defaults to `isomorphic-git/http/node`. Injected by the
   * tests as a FAKE transport (a real remote needs a git smart-HTTP server — checklist X2's
   * `kind` half), so the credential handling and the error scrubbing are still measured here.
   */
  http?: typeof http;
};

/**
 * Push `main` to a mirror. The token is resolved from its Secret REFERENCE at call time, used
 * once as the HTTP password and scrubbed from any error. Never logged, never returned.
 */
export async function push(domain: string, mirror: MirrorConfig, deps: PushDeps = {}): Promise<PushResult> {
  if (!/^https?:\/\//.test(mirror.url)) return { ok: false, error: 'mirror url must be http(s)' };
  if (!repoExists(domain, deps)) return { ok: false, error: `no repository for '${domain}'` };
  const gitdir = repoPath(domain, deps);
  const head = await headSha(gitdir);
  if (!head) return { ok: false, error: 'nothing to push (no commits)' };
  const resolve = deps.resolveToken ?? (async (ref: { name: string; key: string }) => {
    const { getSecretServerSide } = await import('@core/infra/secrets');
    return getSecretServerSide(ref);
  });
  const token = await resolve(mirror.tokenSecretRef);
  if (!token) return { ok: false, error: `mirror token secret '${mirror.tokenSecretRef.name}/${mirror.tokenSecretRef.key}' is not set` };
  try {
    const res = await git.push({
      fs,
      http: deps.http ?? http,
      gitdir,
      url: mirror.url,
      ref: MAIN,
      remoteRef: MAIN,
      onAuth: () => ({ username: 'x-access-token', password: token }),
    });
    if (res.ok === false || (res.error && res.error.length > 0)) {
      return { ok: false, error: scrub(String(res.error ?? 'push rejected'), token) };
    }
    return { ok: true, sha: head };
  } catch (e) {
    return { ok: false, error: scrub(e instanceof Error ? e.message : String(e), token) };
  }
}

// =============================================================================
// === G READ BLOCK (night 2) — read-at-commit · path-scoped log · unified diff
// =============================================================================
// Appended as ONE delimited section (plan: stream G owns the read/diff half of this
// file, stream S owns the tag half). Everything above is untouched and no existing
// export's signature changed. These are the primitives `core/infra/git-objects.ts`
// needs to answer "what is this object's history, what did it look like at that
// commit, and what changed between two of them" — generic over paths, knowing
// nothing about datasets, metrics, dashboards, systems or apps.
//
// WHY A PATH-SCOPED LOG AT ALL: the per-object history was keyed on the `OS-Object`
// trailer only, and boot-reconcile commits carry PLATFORM attribution
// (`OS-Object: <domain>`), so a trailer-only lookup answers `null` for an object
// whose files are plainly in the tree (night-1 follow-up F3-1). `logPaths` is the
// fallback that makes `git.head` non-null for anything with files.

/** How deep a path-scoped log walks by default (bounded like {@link MAX_LOG_DEPTH}). */
export const DEFAULT_PATH_SCAN = 200;
/** Most files one object-version read returns before it reports itself truncated. */
export const MAX_VERSION_FILES = 500;

/** A repo path selector: `a/b/` (a directory prefix) or `a/b.yml` (one exact file). */
export type PathSelector = string;

/** Does `filepath` fall under this selector? A trailing `/` means "everything under". */
export function pathMatches(filepath: string, selector: PathSelector): boolean {
  const s = String(selector ?? '').replace(/^\/+/, '');
  if (!s) return false;
  if (s.endsWith('/')) return filepath.startsWith(s);
  return filepath === s || filepath.startsWith(`${s}/`);
}

/** Does `filepath` fall under ANY of the selectors? */
export function pathMatchesAny(filepath: string, selectors: PathSelector[]): boolean {
  return selectors.some((s) => pathMatches(filepath, s));
}

/** The oid a path resolves to inside one commit's tree — a blob or a subtree. Null when absent. */
async function oidAtPath(gitdir: string, commitOid: string, selector: PathSelector, cache: Map<string, string | null>): Promise<string | null> {
  const key = `${commitOid} ${selector}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const segments = String(selector ?? '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s.length > 0);
  let result: string | null = null;
  try {
    const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
    let oid: string = commit.tree;
    for (const segment of segments) {
      const { tree } = await git.readTree({ fs, gitdir, oid });
      const entry = tree.find((e) => e.path === segment);
      if (!entry) {
        oid = '';
        break;
      }
      oid = entry.oid;
    }
    result = oid === '' ? null : oid;
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}

/** The content signature of a set of selectors inside one commit (`-` per absent selector). */
async function signatureAt(gitdir: string, commitOid: string, selectors: PathSelector[], cache: Map<string, string | null>): Promise<string> {
  const parts: string[] = [];
  for (const s of selectors) parts.push(`${s}=${(await oidAtPath(gitdir, commitOid, s, cache)) ?? '-'}`);
  return parts.join('|');
}

export type PathLogOptions = GitStoreOptions & {
  /** Most entries returned (default 10, capped 100). */
  limit?: number;
  /** How far back the repo log is walked while looking for them (default 200, capped MAX_LOG_DEPTH). */
  scan?: number;
};

export type PathLogResult = {
  entries: LogEntry[];
  /** True when the scan window ran out before `limit` matching commits were found. */
  truncated: boolean;
  /** How many commits were actually examined. */
  scanned: number;
};

/**
 * `git log -- <paths>`: the commits in which the content under ANY of `selectors` differs from
 * the first parent's (a root commit counts when the path exists in it). Newest first, bounded.
 *
 * HONEST ABOUT ITS WINDOW: one domain repo mixes the dbt project, the agent systems, the
 * dashboards and every app, so a per-object log has to scan far more than it returns. `truncated`
 * says when the window ended before `limit` matches appeared — it never implies completeness.
 */
export async function logPaths(domain: string, selectors: PathSelector[], opts: PathLogOptions = {}): Promise<PathLogResult> {
  const clean = selectors.map((s) => String(s ?? '').replace(/^\/+/, '')).filter((s) => s.length > 0);
  if (clean.length === 0) return { entries: [], truncated: false, scanned: 0 };
  if (!repoExists(domain, opts)) return { entries: [], truncated: false, scanned: 0 };
  const gitdir = repoPath(domain, opts);
  if (!(await headSha(gitdir))) return { entries: [], truncated: false, scanned: 0 };
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const scan = Math.max(limit, Math.min(opts.scan ?? DEFAULT_PATH_SCAN, MAX_LOG_DEPTH));
  const all = await log(domain, { ...opts, limit: scan });
  const cache = new Map<string, string | null>();
  const out: LogEntry[] = [];
  for (const entry of all) {
    const mine = await signatureAt(gitdir, entry.sha, clean, cache);
    const parent = entry.parents[0];
    const theirs = parent ? await signatureAt(gitdir, parent, clean, cache) : null;
    const present = mine.split('|').some((p) => !p.endsWith('=-'));
    if (parent ? mine !== theirs : present) out.push(entry);
    if (out.length >= limit) break;
  }
  return { entries: out, truncated: out.length < limit && all.length >= scan, scanned: all.length };
}

export type FileAtCommit = { path: string; content: string };
export type FilesAtResult = {
  sha: string;
  files: FileAtCommit[];
  /** True when more than {@link MAX_VERSION_FILES} files matched and the list was cut. */
  truncated: boolean;
};

/**
 * Read every file under `selectors` AT one commit (read-at-commit). `[]` is the honest answer for
 * a commit in which the object had no files — never an error and never substituted content.
 */
export async function readFilesAt(domain: string, ref: string | undefined, selectors: PathSelector[], opts: GitStoreOptions = {}): Promise<FilesAtResult> {
  if (!repoExists(domain, opts)) throw new GitStoreError(`no repository for '${domain}'`, 404);
  const gitdir = repoPath(domain, opts);
  const sha = await resolveCommit(gitdir, ref);
  const clean = selectors.map((s) => String(s ?? '').replace(/^\/+/, '')).filter((s) => s.length > 0);
  const entries = (await listTree(domain, sha, opts)).filter((e) => pathMatchesAny(e.path, clean));
  const truncated = entries.length > MAX_VERSION_FILES;
  const files: FileAtCommit[] = [];
  for (const e of entries.slice(0, MAX_VERSION_FILES)) {
    const { blob } = await git.readBlob({ fs, gitdir, oid: e.oid });
    files.push({ path: e.path, content: Buffer.from(blob).toString('utf8') });
  }
  return { sha, files, truncated };
}

// ------------------------------------------------------------ unified diff ---

/** Beyond this many line-pairs the LCS is skipped and the file is reported as one replacement. */
export const MAX_DIFF_CELLS = 400_000;

function splitLines(text: string): { lines: string[]; noEol: boolean } {
  const s = String(text ?? '');
  if (s === '') return { lines: [], noEol: false };
  const noEol = !s.endsWith('\n');
  const lines = s.split('\n');
  if (!noEol) lines.pop();
  return { lines, noEol };
}

type DiffOp = { t: ' ' | '-' | '+'; line: string };

/** The edit script between two line arrays (LCS backtrack), or null when it is too large. */
function editScript(a: string[], b: string[]): DiffOp[] | null {
  if (a.length * b.length > MAX_DIFF_CELLS) return null;
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ t: '-', line: a[i] });
      i++;
    } else {
      ops.push({ t: '+', line: b[j] });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ t: '-', line: a[i] });
  for (; j < m; j++) ops.push({ t: '+', line: b[j] });
  return ops;
}

export type UnifiedDiffOptions = {
  /** `--- a/<aLabel>` (default `a`). */
  aLabel?: string;
  /** `+++ b/<bLabel>` (default `b`). */
  bLabel?: string;
  /** Context lines around each hunk (default 3). */
  context?: number;
};

/**
 * A unified diff of two texts. `''` when they are identical, so a caller can test for "no change"
 * without parsing. No new dependency: the OS vendors no diff library for forty lines of LCS.
 */
export function unifiedDiff(aText: string, bText: string, opts: UnifiedDiffOptions = {}): string {
  if (aText === bText) return '';
  const a = splitLines(aText);
  const b = splitLines(bText);
  const context = Math.max(0, Math.min(opts.context ?? 3, 20));
  const header = `--- a/${opts.aLabel ?? 'a'}\n+++ b/${opts.bLabel ?? 'b'}\n`;
  const ops = editScript(a.lines, b.lines);
  if (!ops) {
    // Too large to diff line-by-line. Say so rather than returning a wrong or empty patch.
    return header + `@@ -1,${a.lines.length} +1,${b.lines.length} @@ file too large to diff line-by-line (${a.lines.length} x ${b.lines.length} lines)\n`;
  }
  const changed = ops.map((o) => o.t !== ' ');
  const hunks: string[] = [];
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  const advance = (op: DiffOp): void => {
    if (op.t !== '+') aLine++;
    if (op.t !== '-') bLine++;
  };
  // Lines already inside a hunk: a later hunk's leading context may never repeat them, or the
  // patch would carry the same line twice and `git apply` would reject it.
  let emitted = 0;
  while (k < ops.length) {
    if (!changed[k]) {
      advance(ops[k]);
      k++;
      continue;
    }
    // Walk back over the leading context, then forward until more than `context` quiet lines.
    let start = k;
    let backA = aLine;
    let backB = bLine;
    for (let c = 0; c < context && start > emitted && !changed[start - 1]; c++) {
      start--;
      backA--;
      backB--;
    }
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context) {
      quiet = changed[end] ? 0 : quiet + 1;
      end++;
    }
    // Keep EXACTLY `context` lines after the last change in this hunk (git's own shape).
    let lastChange = k;
    for (let x = k; x < end; x++) if (changed[x]) lastChange = x;
    end = Math.min(ops.length, lastChange + 1 + context);
    emitted = end;
    const body = ops.slice(start, end);
    const aCount = body.filter((o) => o.t !== '+').length;
    const bCount = body.filter((o) => o.t !== '-').length;
    hunks.push(
      `@@ -${aCount === 0 ? 0 : backA},${aCount} +${bCount === 0 ? 0 : backB},${bCount} @@\n` + body.map((o) => `${o.t}${o.line}`).join('\n'),
    );
    for (let x = k; x < end; x++) advance(ops[x]);
    k = end;
  }
  return header + hunks.join('\n') + '\n';
}

export type FileDiff = {
  path: string;
  status: 'added' | 'modified' | 'removed';
  /** The unified patch for this file (never empty — an unchanged file is not listed). */
  patch: string;
};

export type DiffResult = {
  a: string;
  b: string;
  files: FileDiff[];
  /** Every file patch concatenated — what an engineer would pipe into `git apply`. */
  patch: string;
};

/**
 * The unified diff of everything under `selectors` between two commits. Unchanged files are
 * omitted; `files: []` means the object is byte-identical at both commits, which is a real answer.
 */
export async function diffPaths(
  domain: string,
  refA: string,
  refB: string,
  selectors: PathSelector[],
  opts: GitStoreOptions & { context?: number } = {},
): Promise<DiffResult> {
  const a = await readFilesAt(domain, refA, selectors, opts);
  const b = await readFilesAt(domain, refB, selectors, opts);
  const left = new Map(a.files.map((f) => [f.path, f.content]));
  const right = new Map(b.files.map((f) => [f.path, f.content]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const files: FileDiff[] = [];
  for (const p of paths) {
    const before = left.get(p);
    const after = right.get(p);
    if (before === after) continue;
    const patch = unifiedDiff(before ?? '', after ?? '', { aLabel: p, bLabel: p, context: opts.context });
    if (!patch) continue;
    files.push({ path: p, status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified', patch });
  }
  return { a: a.sha, b: b.sha, files, patch: files.map((f) => f.patch).join('') };
}

/** One repository's summary for an operator view: head commit, commit count, last author. */
export type RepoSummary = {
  domain: string;
  head: string | null;
  /** Commits on `main`, counted up to {@link MAX_LOG_DEPTH} (`countTruncated` says when capped). */
  commits: number;
  countTruncated: boolean;
  lastAuthor: string | null;
  lastSubject: string | null;
  /** ISO-8601 of the head commit's author time. */
  lastAt: string | null;
};

/** Summarise every repository on the PVC (operator read; no file contents, no credentials). */
export async function repoSummaries(opts: GitStoreOptions = {}): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (const repo of await listRepos(opts)) {
    const entries = await log(repo.name, { ...opts, limit: MAX_LOG_DEPTH });
    const head = entries[0] ?? null;
    out.push({
      domain: repo.name,
      head: repo.head,
      commits: entries.length,
      countTruncated: entries.length >= MAX_LOG_DEPTH,
      lastAuthor: head ? head.author.name : null,
      lastSubject: head ? head.subject : null,
      lastAt: head ? new Date(head.timestamp * 1000).toISOString() : null,
    });
  }
  return out;
}
