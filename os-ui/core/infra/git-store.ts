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
 *   - `push` to a mirror resolves the token through the secrets helper at call time and never
 *     logs, returns or persists it; errors are scrubbed before they leave this module.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { config } from '@core/kernel/config';
import { tarArchive } from '@core/infra/tar';

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
 * The git author for an acting user. A user without an e-mail gets `<id>@os.local`, and the
 * caller must say so in the commit (`OS-Author-Email: synthesized`) — never a silent invention.
 */
export function authorFor(user: { id: string; name?: string | null; email?: string | null }): { author: GitAuthor; synthesized: boolean } {
  const name = oneLine(user.name ?? '') || user.id;
  const email = oneLine(user.email ?? '');
  if (email) return { author: { name, email }, synthesized: false };
  return { author: { name, email: `${user.id}@os.local` }, synthesized: true };
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
    if (head && prefixes.length > 0) {
      for (const [p, leaf] of await entriesAt(gitdir, head)) {
        if (prefixes.some((pre) => p.startsWith(pre)) && !files.has(p)) leaves.set(p, leaf);
      }
    }
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
    if (head) {
      for (const [p, leaf] of await entriesAt(gitdir, head)) {
        if (!p.startsWith(pre)) leaves.set(p, leaf);
      }
    }
    for (const [p, content] of files) leaves.set(p, { content });
    return commitLeaves(gitdir, head, leaves, opts);
  });
}

// -------------------------------------------------------------------- reads ---

/** Newest first. An empty repo (no commits yet) yields `[]`. */
export async function log(domain: string, opts: GitStoreOptions & { limit?: number } = {}): Promise<LogEntry[]> {
  if (!repoExists(domain, opts)) return [];
  const gitdir = repoPath(domain, opts);
  if (!(await headSha(gitdir))) return [];
  const entries = await git.log({ fs, gitdir, ref: MAIN, depth: Math.max(1, Math.min(opts.limit ?? 50, 500)) });
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
      http,
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
