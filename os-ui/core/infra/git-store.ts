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

// ======================= === S TAG BLOCK === (stream S, night-2) ===========================
// Delimited for a textual merge: stream G appends its read/diff block as `=== G READ BLOCK ===`
// ABOVE this one. Neither block changes an existing export's signature. Do not interleave them.
// ===========================================================================================
// TAGS AND RELEASES — stream S's additive block (night-2, D17/S-R2.1).
//
// Appended at the end of the file ON PURPOSE: stream G owns the read/diff block and this one
// changes NO existing export's signature. Everything below is new.
//
// WHY: `main` is the only long-lived ref, and a RELEASE is an annotated tag
// `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>` pointing at the reviewed commit. Tag namespacing by
// slug is what makes one-repo-per-domain work — `listTags(domain, 'app/invoices/v')` IS that
// app's release history. A tag is IMMUTABLE here: re-tagging the same name is a typed 409,
// because "the release that is running" must not be re-pointable (12-factor V / OpenGitOps
// "versioned and immutable"). Nothing in this block rewrites history.
// ===========================================================================================

/** `refs/tags/<name>`. */
export function tagRef(name: string): string {
  return `refs/tags/${name}`;
}

/**
 * A tag name the OS will write: path-ish segments of `[A-Za-z0-9._-]`, no `..`, no leading or
 * trailing `/`, no `@{`, not ending in `.lock` — the subset of git's `check-ref-format` rules
 * that matters here, applied BEFORE anything reaches the ref store.
 */
const TAG_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function assertTagName(name: string): string {
  const n = String(name ?? '').trim();
  const segments = n.split('/');
  const ok =
    n.length > 0 &&
    n.length <= 200 &&
    !n.includes('..') &&
    !n.includes('@{') &&
    segments.length <= 8 &&
    segments.every((s) => TAG_SEGMENT_RE.test(s) && !s.endsWith('.lock'));
  if (!ok) throw new GitStoreError(`invalid tag name '${n.slice(0, 60)}'`);
  return n;
}

export type TagEntry = {
  name: string;
  /** The commit the tag resolves to. */
  commit: string;
  /** The tag object's own oid (annotated tags only). */
  oid: string;
  message: string;
  tagger: GitAuthor;
  /** Unix seconds. */
  timestamp: number;
};

export type AnnotatedTagOptions = GitStoreOptions & {
  /** The release's author — the acting user, exactly like a commit. */
  tagger: GitAuthor;
  /** The release manifest / notes. Trailers may already be included. */
  message: string;
  /** Extra trailers appended to the message's trailer block. */
  trailers?: Record<string, string>;
  /** `main`, `HEAD` or a sha (default: `main`). */
  ref?: string;
  /** Unix seconds (default: now). */
  timestamp?: number;
};

/**
 * Create an ANNOTATED tag at `ref`. Returns the tag object's oid and the commit it names.
 * A tag that already exists is a 409 — an immutable release id is the whole point, so this
 * never moves a tag and never force-writes a ref.
 */
export async function annotatedTag(domain: string, name: string, opts: AnnotatedTagOptions): Promise<TagEntry> {
  const tag = assertTagName(name);
  if (!repoExists(domain, opts)) throw new GitStoreError(`no repository for '${domain}'`, 404);
  const gitdir = repoPath(domain, opts);
  return withLock(gitdir, async () => {
    const existing = await tagOid(gitdir, tag);
    if (existing) throw new GitStoreError(`tag '${tag}' already exists — a release is immutable`, 409);
    const commit = await resolveCommit(gitdir, opts.ref);
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const message = appendTrailers(opts.message, opts.trailers ?? {});
    await git.annotatedTag({
      fs,
      gitdir,
      ref: tag,
      object: commit,
      message,
      tagger: { ...opts.tagger, timestamp, timezoneOffset: 0 },
    });
    // `annotatedTag` returns void, so read the ref back for the tag object's own oid.
    const oid = (await tagOid(gitdir, tag)) ?? '';
    if (!oid) throw new GitStoreError(`tag '${tag}' was not written`, 500);
    return { name: tag, commit, oid, message, tagger: opts.tagger, timestamp };
  });
}

async function tagOid(gitdir: string, tag: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir, ref: tagRef(tag) });
  } catch {
    return null;
  }
}

/** Read one tag. `null` when it does not exist. A lightweight tag reports the commit as its oid. */
export async function resolveTag(domain: string, name: string, opts: GitStoreOptions = {}): Promise<TagEntry | null> {
  const tag = assertTagName(name);
  if (!repoExists(domain, opts)) return null;
  const gitdir = repoPath(domain, opts);
  const oid = await tagOid(gitdir, tag);
  if (!oid) return null;
  try {
    const { tag: t } = await git.readTag({ fs, gitdir, oid });
    return {
      name: tag,
      commit: t.object,
      oid,
      message: t.message ?? '',
      tagger: { name: t.tagger?.name ?? '', email: t.tagger?.email ?? '' },
      timestamp: t.tagger?.timestamp ?? 0,
    };
  } catch {
    // A lightweight tag points straight at the commit: report it honestly rather than throwing.
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    return {
      name: tag,
      commit: oid,
      oid,
      message: commit.message.split('\n')[0],
      tagger: { name: commit.author.name, email: commit.author.email },
      timestamp: commit.author.timestamp,
    };
  }
}

/**
 * Every tag whose name starts with `prefix` (omit it for all), NEWEST FIRST by tagger time and
 * then by name descending, so `listTags(d, 'app/invoices/v')` reads as a release history.
 * An unreadable tag is skipped, never faked.
 */
export async function listTags(domain: string, prefix = '', opts: GitStoreOptions & { limit?: number } = {}): Promise<TagEntry[]> {
  if (!repoExists(domain, opts)) return [];
  const gitdir = repoPath(domain, opts);
  let names: string[] = [];
  try {
    names = await git.listTags({ fs, gitdir });
  } catch {
    return [];
  }
  const out: TagEntry[] = [];
  for (const n of names) {
    if (prefix && !n.startsWith(prefix)) continue;
    try {
      const t = await resolveTag(domain, n, opts);
      if (t) out.push(t);
    } catch {
      /* an unreadable tag is omitted — never reported as a release */
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, MAX_LOG_DEPTH));
  return out.slice(0, limit);
}

/** The oid of `path` (a blob OR a subtree) in a commit's tree — `null` when it is absent. */
async function oidAtPath(gitdir: string, commitOid: string, filepath: string): Promise<string | null> {
  try {
    const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
    let treeOid = commit.tree;
    const parts = filepath.split('/');
    for (let i = 0; i < parts.length; i++) {
      const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
      const entry = tree.find((e) => e.path === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry.oid;
      if (entry.type !== 'tree') return null;
      treeOid = entry.oid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * PATH-SCOPED log: the commits that CHANGED `path` (a file or a directory prefix), newest
 * first. Computed by comparing the oid of `path` against the first parent's — which is exactly
 * `git log -- <path>` for this repo shape (one branch, no merges) and needs no rename
 * detection. The walk is bounded by {@link MAX_LOG_DEPTH} like every other read here; when the
 * bound is hit the result says so rather than pretending to be complete.
 */
export async function logPath(
  domain: string,
  filepath: string,
  opts: GitStoreOptions & { limit?: number; depth?: number } = {},
): Promise<{ entries: LogEntry[]; truncated: boolean }> {
  const want = Math.max(1, opts.limit ?? 50);
  const all = await log(domain, { ...opts, limit: Math.max(want, Math.min(opts.depth ?? MAX_LOG_DEPTH, MAX_LOG_DEPTH)) });
  if (all.length === 0) return { entries: [], truncated: false };
  const path = assertRepoPath(String(filepath ?? '').replace(/\/+$/, ''));
  const gitdir = repoPath(domain, opts);
  const entries: LogEntry[] = [];
  let scanned = 0;
  for (const e of all) {
    scanned++;
    const mine = await oidAtPath(gitdir, e.sha, path);
    const parent = e.parents[0] ? await oidAtPath(gitdir, e.parents[0], path) : null;
    if (mine !== parent) entries.push(e);
    if (entries.length >= want) break;
  }
  return { entries, truncated: scanned >= all.length && all.length >= MAX_LOG_DEPTH };
}
// ======================= === END S TAG BLOCK === ==========================================

// ======================= === S READ-BACK BLOCK === (stream S, night-2 review M-5) ==========
// A BOUNDED read of one subtree at a ref, in `@core` so a tab (or the admin tab's MCP module)
// can read another tab's committed files WITHOUT importing that tab — the import
// `tabs/admin/mcp` → `tabs/software/lib` was a tab→tab edge the structure ratchet cannot see,
// because it was a dynamic `import()`. Generic: paths and strings in, no tab vocabulary.
// ===========================================================================================

/** Caps for {@link readSubtree}, so one read can never pull an unbounded tree into memory. */
export const MAX_SUBTREE_FILES = 500;
export const MAX_SUBTREE_BYTES = 8 * 1024 * 1024;

export type SubtreeRead = {
  /** Paths RELATIVE to the prefix, sorted. */
  files: { path: string; content: string }[];
  /** The commit that last changed this prefix (`''` when the prefix has no history). */
  sha: string;
  /** True when a cap stopped the read — the caller must SAY so rather than imply completeness. */
  truncated: boolean;
};

/**
 * Read every file under `prefix` at `ref`, with the prefix stripped, plus the sha of the commit
 * that last CHANGED that prefix. `null` when the repository or the prefix does not exist — never
 * an empty result that reads like an empty tree.
 *
 * Bounded by {@link MAX_SUBTREE_FILES} and {@link MAX_SUBTREE_BYTES}: one `listTree` walk plus
 * at most that many blob reads, and `truncated: true` when a cap bit.
 */
export async function readSubtree(
  domain: string,
  prefix: string,
  opts: GitStoreOptions & { ref?: string } = {},
): Promise<SubtreeRead | null> {
  if (!repoExists(domain, opts)) return null;
  const pre = normalizePrefix(prefix);
  const gitdir = repoPath(domain, opts);
  if (!(await headSha(gitdir))) return null;
  const ref = opts.ref ?? 'main';
  const entries = (await listTree(domain, ref, opts)).filter((e) => e.path.startsWith(pre));
  if (entries.length === 0) return null;
  const files: SubtreeRead['files'] = [];
  let bytes = 0;
  let truncated = false;
  for (const e of entries) {
    if (files.length >= MAX_SUBTREE_FILES || bytes >= MAX_SUBTREE_BYTES) {
      truncated = true;
      break;
    }
    const content = await readBlob(domain, ref, e.path, opts);
    bytes += Buffer.byteLength(content, 'utf8');
    files.push({ path: e.path.slice(pre.length), content });
  }
  const mine = await logPath(domain, pre.replace(/\/$/, ''), { ...opts, limit: 1 });
  return { files, sha: mine.entries[0]?.sha ?? '', truncated };
}
// ======================= === END S READ-BACK BLOCK === ====================================
