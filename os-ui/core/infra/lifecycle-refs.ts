/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    The lifecycle as native git refs — `live/<kind>/<id>`, `testing/<kind>/<id>` and
 *             `version/<kind>/<id>/<n>` annotated tags in the domain and personal repos (WP-51)
 * USER STORY: As an engineer I want `git clone` + `git tag -l 'live/*'` to tell me exactly what
 *             the OS says is live, in testing, and which versions went live before — with no OS
 *             running and no second store that could disagree with git.
 * ARCHITECTURE:
 *   - Artifact contract A15: a pin IS an annotated tag. Draft is `main` (nothing per object);
 *     Testing is `testing/<kind>/<id>` while a draft is exercised; Live is `live/<kind>/<id>`
 *     (moved on every go-live, deleted on retire); every go-live also writes an IMMUTABLE
 *     `version/<kind>/<id>/<n>`, so the history of what ran is a plain `git tag -l`.
 *   - The tag message carries the OS-layer facts as git trailers (`OS-Ref`, `OS-Path`,
 *     `OS-Actor`) — the documented extension point of a tag message, parsed back with
 *     `git interpret-trailers --parse` or `git for-each-ref --format='%(trailers)'`.
 *   - `OS-Ref` keeps the OS's own version id (a commit sha for a git-backed kind, `rev:`/`spec:`
 *     content refs for the others). The tag itself always names a COMMIT of the repo: the pinned
 *     sha when the ref is one the repo has, otherwise `main` at go-live time.
 *   - The reader enumerates the bare repos on disk — the same bytes git-http and git-daemon serve.
 */
import 'server-only';
import { existsSync } from 'node:fs';

import {
  commitExists,
  deleteTag,
  listAllRepos,
  listTags,
  mainSha,
  parseTrailers,
  resolveTag,
  upsertAnnotatedTag,
  MAX_LOG_DEPTH,
  type GitAuthor,
  type GitStoreOptions,
  type TagEntry,
} from '@core/infra/git-store';
import { isLifecycleKind, pinKey, type LifecycleKind, type Pin, type TestMarker } from '@core/kernel/object-lifecycle';

export const LIVE_TAG_PREFIX = 'live/';
export const TESTING_TAG_PREFIX = 'testing/';
export const VERSION_TAG_PREFIX = 'version/';

export function liveTag(kind: string, id: string): string {
  return `${LIVE_TAG_PREFIX}${kind}/${id}`;
}
export function testingTag(kind: string, id: string): string {
  return `${TESTING_TAG_PREFIX}${kind}/${id}`;
}
export function versionTag(kind: string, id: string, n: number): string {
  return `${VERSION_TAG_PREFIX}${kind}/${id}/${n}`;
}

/** `live/agent/s1` → `{ kind: 'agent', id: 's1' }`; anything else → null. */
export function parseLifecycleTag(name: string, prefix: string): { kind: LifecycleKind; id: string } | null {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  const kind = rest.slice(0, i);
  const id = rest.slice(i + 1);
  if (!isLifecycleKind(kind) || !id || id.includes('/')) return null;
  return { kind, id };
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** The repo name a lifecycle row is filed under: the domain for a domain repo, else the repo. */
function ownerName(r: { kind: string; domain?: string; repo: string }): string {
  return r.kind === 'domain' && r.domain ? r.domain : r.repo;
}

function pinFromTag(t: TagEntry, repo: string): Pin {
  const tr = parseTrailers(t.message);
  const ref = tr['OS-Ref'] || t.commit;
  return {
    ref,
    at: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : '',
    by: tr['OS-Actor'] || t.tagger.email,
    domain: repo,
    ...(tr['OS-Path'] ? { path: tr['OS-Path'] } : {}),
    ...(isDefinition(tr['OS-Definition']) ? { definition: tr['OS-Definition'] } : {}),
  };
}

/**
 * What the tagged commit holds for the object (`OS-Definition`):
 *   - `commit`     — the pinned ref IS this commit (a git-backed kind, e.g. an agent system);
 *   - `rendered`   — the OS wrote the object's current definition with its tab's own git writer at
 *                    go-live, and the tag names that commit: `git checkout live/<kind>/<id>` is
 *                    exactly what is live;
 *   - `not-in-git` — the kind has no git writer yet (a store-only definition): the tag names `main`
 *                    at go-live, and the definition itself is NOT in the commit. Said, never implied.
 */
export type DefinitionState = 'commit' | 'rendered' | 'not-in-git';
function isDefinition(v: unknown): v is DefinitionState {
  return v === 'commit' || v === 'rendered' || v === 'not-in-git';
}

export type RepoLifecycle = {
  pins: Record<string, Pin>;
  tests: Record<string, TestMarker>;
  /** The repos that were read (canonical owner names). */
  repos: string[];
};

/**
 * Read every lifecycle tag in every repo under `reposDir`. `null` when the root could not be
 * read AT ALL — "we could not find out" is not "nothing is live" (the September-2026 rule).
 */
export async function readLifecycleRefs(opts: GitStoreOptions = {}): Promise<RepoLifecycle | null> {
  const reposDir = opts.reposDir;
  if (!reposDir || !existsSync(reposDir)) return null;
  let listing: Awaited<ReturnType<typeof listAllRepos>>;
  try {
    listing = await listAllRepos({ reposDir });
  } catch (e) {
    // `null` is the typed "could not find out": every caller refuses to WRITE on it.
    console.error(`[lifecycle] the repo root could not be listed: ${(e as Error).message}`);
    return null;
  }
  // A canonical directory wins over a stray legacy one, as `resolveRepo` reads it first.
  const byOwner = new Map<string, (typeof listing)[number]>();
  for (const r of listing) {
    const o = ownerName(r);
    const prev = byOwner.get(o);
    if (!prev || (prev.legacy && !r.legacy)) byOwner.set(o, r);
  }
  const out: RepoLifecycle = { pins: {}, tests: {}, repos: [] };
  for (const [owner] of [...byOwner].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out.repos.push(owner);
    const tags = await listTags(owner, '', { reposDir, limit: MAX_LOG_DEPTH });
    for (const t of tags) {
      const live = parseLifecycleTag(t.name, LIVE_TAG_PREFIX);
      if (live) {
        out.pins[pinKey(live.kind, live.id)] = pinFromTag(t, owner);
        continue;
      }
      const testing = parseLifecycleTag(t.name, TESTING_TAG_PREFIX);
      if (testing) {
        const p = pinFromTag(t, owner);
        out.tests[pinKey(testing.kind, testing.id)] = { ref: p.ref, at: p.at };
      }
    }
  }
  return out;
}

export type LifecycleTagInput = {
  kind: LifecycleKind;
  id: string;
  /** The OS ref being pinned (a sha, or a content ref). */
  ref: string;
  tagger: GitAuthor;
  actorId: string;
  action: 'go-live' | 'testing' | 'migrate';
  path?: string;
  surface?: string;
  /**
   * The commit that holds the object's definition, when the OS just wrote it (a tab's git writer
   * at go-live). It must be in the repo; it wins over the ref for choosing what the tag names.
   */
  commit?: string;
};

function tagMessage(input: LifecycleTagInput): { message: string; trailers: Record<string, string> } {
  const one = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return {
    message: `${one(input.action)} ${input.kind}:${input.id}`,
    trailers: {
      'OS-Action': one(input.action),
      'OS-Object': `${input.kind}:${input.id}`,
      'OS-Ref': one(input.ref),
      ...(input.path ? { 'OS-Path': one(input.path) } : {}),
      'OS-Actor': one(input.actorId),
      ...(input.surface ? { 'OS-Surface': one(input.surface) } : {}),
    },
  };
}

function withDefinition(t: { message: string; trailers: Record<string, string> }, definition: DefinitionState) {
  return { message: t.message, trailers: { ...t.trailers, 'OS-Definition': definition } };
}

/** The commit a lifecycle tag names, and what that commit holds for the object. */
async function tagTarget(repo: string, input: { ref: string; commit?: string }, opts: GitStoreOptions): Promise<{ commit: string; definition: DefinitionState }> {
  if (input.commit) {
    if (!(await commitExists(repo, input.commit, opts))) {
      const e = new Error(`the definition commit ${input.commit.slice(0, 12)} is not in '${repo}'`) as Error & { status: number };
      e.status = 409;
      throw e;
    }
    return { commit: input.commit.toLowerCase(), definition: 'rendered' };
  }
  const ref = input.ref;
  const head = await mainSha(repo, opts);
  if (!head) {
    const e = new Error(`'${repo}' has no commit yet, so there is nothing a lifecycle tag could name`) as Error & { status: number };
    e.status = 409;
    throw e;
  }
  // A sha this repo has is tagged itself; any other ref (a content ref, or a sha of another repo)
  // is recorded in `OS-Ref` and the tag names `main` as it was at that moment.
  if (SHA_RE.test(ref) && (await commitExists(repo, ref, opts))) return { commit: ref.toLowerCase(), definition: 'commit' };
  return { commit: head, definition: 'not-in-git' };
}

/**
 * Go live: move `live/<kind>/<id>` and add the next immutable `version/<kind>/<id>/<n>`.
 */
export async function writeLiveRefs(repo: string, input: LifecycleTagInput, opts: GitStoreOptions = {}): Promise<{ live: TagEntry; version: TagEntry }> {
  const { commit: target, definition } = await tagTarget(repo, input, opts);
  const { message, trailers } = withDefinition(tagMessage(input), definition);
  const live = await upsertAnnotatedTag(repo, liveTag(input.kind, input.id), { ...opts, tagger: input.tagger, message, trailers, ref: target });
  const prior = await listTags(repo, `${VERSION_TAG_PREFIX}${input.kind}/${input.id}/`, { ...opts, limit: MAX_LOG_DEPTH });
  const n = prior.reduce((m, t) => Math.max(m, Number(t.name.split('/').pop()) || 0), 0) + 1;
  const version = await upsertAnnotatedTag(repo, versionTag(input.kind, input.id, n), { ...opts, tagger: input.tagger, message, trailers, ref: target });
  return { live, version };
}

/** Retire: delete `live/<kind>/<id>`. Every `version/*` tag stays — nothing is deleted from history. */
export async function deleteLiveRef(repo: string, kind: string, id: string, opts: GitStoreOptions = {}): Promise<boolean> {
  return deleteTag(repo, liveTag(kind, id), opts);
}

/** A draft is being tested: point `testing/<kind>/<id>` at it. */
export async function writeTestingRef(repo: string, input: LifecycleTagInput, opts: GitStoreOptions = {}): Promise<TagEntry> {
  const { commit: target, definition } = await tagTarget(repo, input, opts);
  const { message, trailers } = withDefinition(tagMessage({ ...input, action: 'testing' }), definition);
  return upsertAnnotatedTag(repo, testingTag(input.kind, input.id), { ...opts, tagger: input.tagger, message, trailers, ref: target });
}

export async function deleteTestingRef(repo: string, kind: string, id: string, opts: GitStoreOptions = {}): Promise<boolean> {
  return deleteTag(repo, testingTag(kind, id), opts);
}

export type LiveRef = {
  tag: string;
  /** The commit the tag names — what a loader checks out. */
  commit: string;
  /** The OS ref recorded at go-live (`OS-Ref`). */
  osRef: string;
  path?: string;
  definition?: DefinitionState;
};

/**
 * Read `live/<kind>/<id>` STRAIGHT FROM GIT — the call every loader makes (artifact contract A15b,
 * C4). `null` when the repo has no such tag: the object is not live, whatever any summary says.
 */
export async function readLiveRef(repo: string, kind: string, id: string, opts: GitStoreOptions = {}): Promise<LiveRef | null> {
  const t = await resolveTag(repo, liveTag(kind, id), opts);
  if (!t) return null;
  const tr = parseTrailers(t.message);
  return {
    tag: t.name,
    commit: t.commit,
    osRef: tr['OS-Ref'] || t.commit,
    ...(tr['OS-Path'] ? { path: tr['OS-Path'] } : {}),
    ...(isDefinition(tr['OS-Definition']) ? { definition: tr['OS-Definition'] } : {}),
  };
}
