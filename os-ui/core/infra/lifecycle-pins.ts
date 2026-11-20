/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    THE PIN — what is live, recorded durably and readable in an engineer's clone
 * USER STORY: As an IT reviewer I want "what is running" to be a specific, nameable,
 *             reproducible version rather than "whatever the head happens to be", and I want to
 *             be able to read it by cloning the repo — without needing write access and without
 *             the OS being able to pretend it is something else.
 * ARCHITECTURE:
 *   - THE PIN IS A GIT TAG (WP-51, artifact contract A15). `live/<kind>/<id>` is an annotated tag
 *     in the object's domain or personal repo, moved on go-live and deleted on retire; every
 *     go-live also adds an immutable `version/<kind>/<id>/<n>`; a draft under test carries
 *     `testing/<kind>/<id>`. The index is READ from those tags (`lifecycle-refs.ts`) — there is no
 *     second store of lifecycle status, so a clone shows exactly what the OS shows.
 *   - `os/lifecycle/pins.yml` (its own reserved subtree) is a readable summary REGENERATED from
 *     the tags after every write. A row written before the tags existed is still honoured, marked
 *     `untagged`, until `scripts/ops/lifecycle-tags-migrate.mjs` gives it its tag.
 *   - A WRITER, so it obeys the September-2026 rule: never write on the strength of an unread
 *     index. A repo root that cannot be read makes every write a 503.
  */
import 'server-only';
import yaml from 'js-yaml';

import { osMirror } from '@core/infra/os-mirror';
import { config } from '@core/kernel/config';
import {
  commitSubtree,
  appendTrailers,
  authorFor,
  reserveSubtree,
  readBlob,
  mainSha,
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import {
  pinKey,
  parsePinKey,
  liveTagName,
  type LifecycleIndex,
  type LifecycleKind,
  type Pin,
  type TestMarker,
} from '@core/kernel/object-lifecycle';
import { deleteLiveRef, deleteTestingRef, readLifecycleRefs, writeLiveRefs, writeTestingRef } from '@core/infra/lifecycle-refs';

/** The reserved subtree the pin file owns, and the file inside it. */
export const LIFECYCLE_PREFIX = 'os/lifecycle';
export const LIFECYCLE_PIN_PATH = 'os/lifecycle/pins.yml';

/** Declare the subtree ours, so the whole-tree dbt generator keeps the pin file. */
export function reserveLifecycleSubtree(): void {
  reserveSubtree(LIFECYCLE_PREFIX);
}

// ------------------------------------------------------------- the index ---

/**
 * `source` records HOW the index was read, which is the difference between "nothing is live" and
 * "we could not find out" — the September-2026 lesson. A WRITER refuses unless it is `git`; a
 * read degrades to an empty index, as every read path should.
 *
 * There is NO second store for lifecycle status (WP-51): the index is read from the annotated
 * tags `live/*` and `testing/*` in the bare repos — the same refs `git clone` shows. The cache
 * below only saves re-reading the tags on every request: it is dropped on every OS write and
 * expires after {@link INDEX_TTL_MS}, so a tag changed outside this process is seen too.
 */
type PinSource = 'cold' | 'git' | 'none';
type PinState = {
  cache: LifecycleIndex | null;
  cacheDir: string;
  readAt: number;
  migrated: boolean;
  /** The migration latch read from the mirror: true / false, or null when it could not be read. */
  latch: boolean | null;
  source: PinSource;
  untaggedWarned: boolean;
  /** Test seam only: the repo root `hydrateForTests` pointed the store at. */
  testDir: string;
};
const STATE_KEY = Symbol.for('soa.lifecycle.pins');
function state(): PinState {
  const g = globalThis as unknown as Record<symbol, PinState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null, cacheDir: '', readAt: 0, migrated: false, latch: null, source: 'cold', untaggedWarned: false, testDir: '' };
  return g[STATE_KEY]!;
}

/** The repo root: the caller's, else the test seam's, else the configured one. */
function dirOf(deps: { reposDir?: string } = {}): string {
  return deps.reposDir ?? (state().testDir || config.reposDir);
}

/** The repo root the lifecycle reads and writes (for a caller that commits beside a pin). */
export function lifecycleReposDir(deps: { reposDir?: string } = {}): string {
  return dirOf(deps);
}

/** How long a read of the tags is reused before the repos are read again. */
export const INDEX_TTL_MS = 5_000;

/**
 * The durable mirror now holds ONE document: the latch that the one-time "everything existing is
 * Live" migration has run (it must not re-run on an empty tenant and pin new drafts). Lifecycle
 * STATUS is never stored here — the old `pin-*` / `test-*` documents are ignored.
 */
const mirror = osMirror({
  index: 'os-lifecycle-pins',
  createBody: { mappings: { properties: { key: { type: 'keyword' }, at: { type: 'date' } } } },
});

/** The sentinel document that records that the one-time migration has run. */
const MIGRATION_DOC = 'meta-migration';

/** Read the migration latch once per process. */
async function readLatch(): Promise<boolean | null> {
  const s = state();
  if (s.latch !== null) return s.latch;
  const docs = await mirror.hydrate(2000);
  if (!docs) return null;
  s.latch = (docs as { key?: string }[]).some((d) => d?.key === MIGRATION_DOC);
  return s.latch;
}

/**
 * The whole index, read from git: every `live/<kind>/<id>` tag is a pin and every
 * `testing/<kind>/<id>` tag is a test marker. A row of a committed `os/lifecycle/pins.yml` that
 * has NO tag yet (written before WP-51, see `scripts/ops/lifecycle-tags-migrate.mjs`) is kept
 * as a pin with `untagged: true`, so the day this ships nothing silently stops being Live.
 */
export async function lifecycleIndex(deps: { reposDir?: string } = {}): Promise<LifecycleIndex> {
  const s = state();
  const reposDir = dirOf(deps);
  if (s.cache && s.cacheDir === reposDir && Date.now() - s.readAt < INDEX_TTL_MS) return s.cache;
  const read = await readLifecycleRefs({ reposDir });
  const pins: Record<string, Pin> = {};
  const tests: Record<string, TestMarker> = {};
  if (!read) {
    s.source = 'none';
    console.error('[lifecycle] the domain repos could not be read — the index is empty and every pin WRITE is refused until they can');
  } else {
    Object.assign(pins, read.pins);
    Object.assign(tests, read.tests);
    let untagged = 0;
    let pinFiles = 0;
    for (const repo of read.repos) {
      let text: string;
      try {
        text = await readBlob(repo, undefined, LIFECYCLE_PIN_PATH, { reposDir });
      } catch {
        continue; // no pin file — a fact, not a failure
      }
      pinFiles += 1;
      // Only a pre-WP-51 file (version 1), or a row the generator itself carried as `tagged:
      // false`, can stand in for a missing tag. In a version-2 file a row whose tag is gone is
      // NOT live: the tag was deleted, and the tag is the truth.
      const legacyFile = pinFileVersion(text) < PIN_FILE_VERSION;
      for (const row of parsePinFile(text)) {
        const key = pinKey(row.kind, row.id);
        if (pins[key]) continue;
        if (!legacyFile && row.tagged !== false) continue;
        pins[key] = { ref: row.ref, at: row.at, by: row.by, domain: repo, untagged: true, ...(row.path ? { path: row.path } : {}) };
        untagged += 1;
      }
    }
    if (untagged > 0 && !s.untaggedWarned) {
      s.untaggedWarned = true;
      console.error(`[lifecycle] ${untagged} live pin(s) are recorded in os/lifecycle/pins.yml but have no live/* tag yet — run scripts/ops/lifecycle-tags-migrate.mjs (dry-run) to see the tags they need`);
    }
    s.source = 'git';
    const latch = await readLatch();
    // Git evidence of a past migration (a tag or a pin file) latches it as well as the mirror doc.
    s.migrated = latch === true || Object.keys(read.pins).length > 0 || pinFiles > 0;
  }
  s.cache = { pins, tests };
  s.cacheDir = reposDir;
  s.readAt = Date.now();
  return s.cache;
}

/** Drop the cached read, so the next read sees the refs just written. */
function invalidate(): void {
  state().readAt = 0;
}

/**
 * Hydration state. `hydrated` means the repos ANSWERED — not that they had tags. Everything that
 * WRITES must check this first.
 */
export function pinsHydrationState(): 'cold' | 'hydrated' | 'offline' {
  const s = state();
  if (!s.cache) return 'cold';
  return s.source === 'git' ? 'hydrated' : 'offline';
}

/** Whether the one-time "everything existing is Live" migration has run for this tenant. */
export function pinsMigrated(): boolean {
  return state().migrated;
}

/** Record that the migration has run, durably, so a restart does not re-run or re-decide. */
function markMigrated(): void {
  const s = state();
  s.migrated = true;
  s.latch = true;
  mirror.writeThrough(MIGRATION_DOC, { key: MIGRATION_DOC, at: new Date().toISOString() });
}

/** The 503 every pin WRITE is gated on. */
function assertPinsWritable(): void {
  const st = pinsHydrationState();
  if (st === 'hydrated') return;
  const e = new Error(
    st === 'cold'
      ? 'the lifecycle pin index has not been read yet — try again in a moment'
      : 'the lifecycle refs could not be read (the domain repositories did not answer), so the OS will not write a pin it cannot reconcile',
  ) as Error & { status: number };
  e.status = 503;
  throw e;
}

/** The pin for one object, or undefined. */
export async function livePin(kind: string, id: string): Promise<Pin | undefined> {
  return (await lifecycleIndex()).pins[pinKey(kind, id)];
}

export type SetPinResult = {
  pin: Pin;
  /** The git tag that now carries the pin (`written` is true once it is in the repo). */
  tag: { name: string; written: boolean; version?: string };
  commit: CommitResult | null;
};

/** Writer deps, injected so the whole path is testable against a bare repo in a temp dir. */
export type PinWriteDeps = {
  reposDir?: string;
  committer?: (
    domain: string,
    prefix: string,
    files: Map<string, string>,
    opts: CommitTreeOptions,
  ) => Promise<CommitResult>;
  /** Skip the `os/lifecycle/pins.yml` summary commit (the tags are still written). */
  commit?: boolean;
  /** `ui:<route>` or `mcp:<tool>` — which door went live. */
  surface?: string;
  /**
   * The commit that holds the object's definition, written at go-live by its tab's own git
   * writer (`LifecycleAdapter.commitDefinition`). The live tag names it (`OS-Definition: rendered`).
   */
  definitionCommit?: string;
};

/**
 * The pin commit's subject + trailers. Built here rather than through git-store's
 * `commitMessage`, whose `area` union is `data | agents`; the SHAPE is identical, so
 * `parseTrailers` reads it back exactly the same way.
 */
export function pinCommitMessage(domain: string, action: string, object: string, surface: string): string {
  const one = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return appendTrailers(`lifecycle(${one(domain)}): ${one(action)} ${one(object)} — via ${one(surface)}`, {
    'OS-Action': one(action),
    'OS-Object': one(object),
    'OS-Surface': one(surface),
    'OS-Request-Id': `lifecycle-${Date.now().toString(36)}`,
  });
}

/** Make sure a repo has a commit a tag can name: an empty repo gets its pin file first. */
async function ensureTaggable(domain: string, index: LifecycleIndex, by: Actor, deps: PinWriteDeps): Promise<CommitResult | null> {
  const reposDir = dirOf(deps);
  if (await mainSha(domain, { reposDir })) return null;
  return commitPinFile(domain, index, by, 'init', 'lifecycle', deps, true);
}

type Actor = { id: string; name?: string | null; email?: string | null };

/**
 * Pin `ref` as what runs for this object: move the annotated tag `live/<kind>/<id>`, add the
 * immutable `version/<kind>/<id>/<n>`, then regenerate `os/lifecycle/pins.yml` from the tags.
 * The ONLY way a live pin is created — there is no setter that takes a lifecycle word.
 */
export async function setLivePin(
  kind: LifecycleKind,
  id: string,
  ref: string,
  by: Actor,
  domain: string,
  deps: PinWriteDeps = {},
  path?: string,
): Promise<SetPinResult> {
  await lifecycleIndex({ reposDir: deps.reposDir });
  assertPinsWritable();
  const reposDir = dirOf(deps);
  const { author } = authorFor(by);
  const draftIndex = state().cache!;
  await ensureTaggable(domain, draftIndex, by, deps);
  const written = await writeLiveRefs(
    domain,
    { kind, id, ref, tagger: author, actorId: by.id, action: 'go-live', surface: deps.surface, ...(path ? { path } : {}), ...(deps.definitionCommit ? { commit: deps.definitionCommit } : {}) },
    { reposDir },
  );
  invalidate();
  const index = await lifecycleIndex({ reposDir: deps.reposDir });
  const pin = index.pins[pinKey(kind, id)] ?? { ref, at: new Date(written.live.timestamp * 1000).toISOString(), by: by.id, domain, ...(path ? { path } : {}) };
  const commit = deps.commit === false ? null : await commitPinFile(domain, index, by, 'go-live', `${kind}:${id}`, deps);
  invalidate();
  return { pin, tag: { name: written.live.name, written: true, version: written.version.name }, commit };
}

/** Unpin: delete `live/<kind>/<id>`. Run stops showing the object; NOTHING else is deleted. */
export async function clearLivePin(
  kind: LifecycleKind,
  id: string,
  by: Actor,
  domain: string,
  deps: PinWriteDeps = {},
): Promise<{ removed: boolean; commit: CommitResult | null }> {
  const before = await lifecycleIndex({ reposDir: deps.reposDir });
  assertPinsWritable();
  const key = pinKey(kind, id);
  const had = Boolean(before.pins[key]);
  const repo = before.pins[key]?.domain || domain;
  await deleteLiveRef(repo, kind, id, { reposDir: dirOf(deps) });
  invalidate();
  const index = await lifecycleIndex({ reposDir: deps.reposDir });
  // A pre-WP-51 row (pins.yml only, no tag) disappears when the regenerated file omits it.
  if (index.pins[key]?.untagged) delete index.pins[key];
  const commit = deps.commit === false ? null : await commitPinFile(repo, index, by, 'retire', `${kind}:${id}`, deps);
  invalidate();
  return { removed: had, commit };
}

/**
 * Mark a draft as being tested — "run, build or preview the draft from Studio" is in flight.
 * The marker is the annotated tag `testing/<kind>/<id>`; nothing is committed for it.
 */
export async function markTesting(kind: LifecycleKind, id: string, ref: string, domain: string, by: Actor = { id: 'os' }, deps: { reposDir?: string } = {}): Promise<void> {
  const reposDir = dirOf(deps);
  const { author } = authorFor(by);
  await writeTestingRef(domain, { kind, id, ref, tagger: author, actorId: by.id, action: 'testing' }, { reposDir });
  invalidate();
}

/** Clear the in-flight test marker when the run settles. */
export async function clearTesting(kind: LifecycleKind, id: string, domain: string, deps: { reposDir?: string } = {}): Promise<void> {
  await deleteTestingRef(domain, kind, id, { reposDir: dirOf(deps) });
  invalidate();
}

/** Apply a migrated index wholesale (the one-time "everything existing is Live"). */
export async function applyMigratedIndex(
  next: LifecycleIndex,
  by: Actor,
  deps: PinWriteDeps = {},
): Promise<{ pinned: number; domains: string[] }> {
  const index = await lifecycleIndex({ reposDir: deps.reposDir });
  assertPinsWritable();
  const reposDir = dirOf(deps);
  const { author } = authorFor(by);
  const domains = new Set<string>();
  let pinned = 0;
  for (const [key, pin] of Object.entries(next.pins)) {
    if (index.pins[key]) continue;
    const parts = parsePinKey(key);
    if (!parts || !pin.domain) continue;
    await ensureTaggable(pin.domain, index, by, deps);
    await writeLiveRefs(pin.domain, { kind: parts.kind, id: parts.id, ref: pin.ref, tagger: author, actorId: by.id, action: 'migrate', ...(pin.path ? { path: pin.path } : {}) }, { reposDir });
    pinned += 1;
    domains.add(pin.domain);
  }
  invalidate();
  if (deps.commit !== false) {
    const fresh = await lifecycleIndex({ reposDir: deps.reposDir });
    for (const domain of domains) await commitPinFile(domain, fresh, by, 'migrate', 'lifecycle', deps);
    invalidate();
  }
  markMigrated();
  return { pinned, domains: [...domains].sort() };
}

/** Test seam: read the index from a temp `reposDir`. */
export async function hydrateForTests(deps: { reposDir?: string } = {}): Promise<LifecycleIndex> {
  state().testDir = deps.reposDir ?? '';
  return lifecycleIndex(deps);
}

/** Test seam: drop the in-process state so a test starts from nothing. */
export function __resetLifecyclePins(): void {
  const s = state();
  s.cache = null;
  s.cacheDir = '';
  s.readAt = 0;
  s.migrated = false;
  s.latch = null;
  s.source = 'cold';
  s.untaggedWarned = false;
  s.testDir = '';
  mirror.__reset();
}

// ------------------------------------------------------- the committed file ---

export type PinRow = {
  kind: string;
  id: string;
  ref: string;
  tag: string;
  at: string;
  by: string;
  /** The repo path of the pinned definition, for a git-backed kind (review L-2). */
  path?: string;
  /** False for a pre-WP-51 row that no `live/*` tag carries yet. */
  tagged?: boolean;
  /** What the tagged commit holds: `commit`, `rendered` or `not-in-git` (the tag's `OS-Definition`). */
  definition?: string;
};

/**
 * Read a committed pin file back. Since WP-51 the file is a SUMMARY regenerated from the
 * `live/*` tags (artifact contract A15c); it is read only for rows written before the tags
 * existed, so nothing that was Live silently stops being Live before the tag migration runs.
 *
 * Tolerant by design — an unparseable or hand-mangled file yields the rows it can read and drops
 * the rest, because refusing to boot over one bad row would be worse than running with fewer.
 */
export function parsePinFile(text: string): PinRow[] {
  let doc: unknown;
  try {
    doc = yaml.load(String(text ?? ''));
  } catch {
    return [];
  }
  const live = (doc as { live?: unknown })?.live;
  if (!Array.isArray(live)) return [];
  const out: PinRow[] = [];
  for (const row of live) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    const id = typeof r.id === 'string' ? r.id : '';
    const ref = typeof r.ref === 'string' ? r.ref : '';
    if (!kind || !id || !ref) continue;
    out.push({
      kind,
      id,
      ref,
      ...(r.tagged === false ? { tagged: false } : {}),
      tag: typeof r.tag === 'string' ? r.tag : liveTagName(kind, id),
      at: typeof r.at === 'string' ? r.at : '',
      by: typeof r.by === 'string' ? r.by : '',
      ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
    });
  }
  return out;
}

/** Version 2 (WP-51): the file is generated from the tags. Version 1 predates them. */
export const PIN_FILE_VERSION = 2;

/** The `version:` of a committed pin file (1 when absent or unreadable). */
export function pinFileVersion(text: string): number {
  try {
    const v = (yaml.load(String(text ?? '')) as { version?: unknown })?.version;
    return typeof v === 'number' ? v : 1;
  } catch {
    return 1;
  }
}

/** The rows one domain's pin file carries, sorted so the bytes are stable. */
export function pinRowsFor(domain: string, index: LifecycleIndex): PinRow[] {
  const rows: PinRow[] = [];
  for (const [key, pin] of Object.entries(index.pins ?? {})) {
    if (pin.domain !== domain) continue;
    const parts = parsePinKey(key);
    if (!parts) continue;
    rows.push({
      kind: parts.kind,
      id: parts.id,
      ref: pin.ref,
      tag: liveTagName(parts.kind, parts.id),
      at: pin.at,
      by: pin.by,
      ...(pin.path ? { path: pin.path } : {}),
      ...(pin.untagged ? { tagged: false } : {}),
      ...(pin.definition ? { definition: pin.definition } : {}),
    });
  }
  return rows.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
}

/**
 * The bytes of `os/lifecycle/pins.yml`. Deterministic (insertion-ordered keys, no refs) so a
 * re-render of the same state produces the same tree hash and therefore no empty commit.
 * The header says what the file is and that pushing it is refused — transparency never requires
 * write access, and write access is never the only way to see what the OS did.
 */
export function renderPinFile(domain: string, index: LifecycleIndex): string {
  const rows = pinRowsFor(domain, index);
  const header = [
    '# What is LIVE in this domain — a SUMMARY generated from the git tags.',
    '#',
    '# The source is the annotated tag live/<kind>/<id> of each row (see `tag`):',
    '#   git tag -l "live/*"              what is live',
    '#   git tag -l "testing/*"           what is being tested',
    '#   git tag -l "version/*"           every version that went live',
    '#   git show live/<kind>/<id>        who, when, and the commit it runs',
    '# A row with `tagged: false` predates the tags and is carried until it is migrated.',
    '# `definition` says what the tagged commit holds: `commit` (the pinned commit), `rendered`',
    '# (written at go-live by its tab), or `not-in-git` (this kind has no git writer yet, so',
    '# checking the tag out does NOT give you its definition).',
    '#',
    '# Lifecycle (Draft - Testing - Live) is a second axis beside audience (My - Domain -',
    '# Company): this file answers "which version is running", not "who may use it".',
    '# Everything that operates reads these refs: an agent schedule runs the pinned',
    '# definition and Run serves the pinned spec. Editing an object moves its draft and',
    '# leaves the pin alone until someone goes live again.',
    '#',
    '# This file is OS-owned: readable in every clone, and NOT pushable. A push that',
    '# changes it is rejected with "managed by the OS; change it in the UI or over the MCP".',
    '# Go live or retire in the UI, or over the MCP with go_live / retire.',
    '',
  ].join('\n');
  const body = yaml.dump(
    { version: PIN_FILE_VERSION, domain, live: rows },
    { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false, sortKeys: false },
  );
  return `${header}${body}`;
}

async function commitPinFile(
  domain: string,
  index: LifecycleIndex,
  actor: { id: string; name?: string | null; email?: string | null },
  action: string,
  object: string,
  deps: PinWriteDeps,
  rethrow = false,
): Promise<CommitResult | null> {
  const files = new Map<string, string>([[LIFECYCLE_PIN_PATH, renderPinFile(domain, index)]]);
  const { author, synthesized } = authorFor(actor);
  const commit = deps.committer ?? commitSubtree;
  try {
    return await commit(domain, LIFECYCLE_PREFIX, files, {
      author,
      message: pinCommitMessage(domain, action, object, deps.surface ?? 'os:lifecycle'),
      trailers: {
        'OS-Actor': actor.id,
        ...(synthesized ? { 'OS-Author-Email': 'synthesized' } : {}),
      },
      reposDir: dirOf(deps),
    });
  } catch (e) {
    // The tags are the operative pin; the committed file is the readable summary.
    // A repo that cannot be written is reported, never silently treated as a successful pin.
    if (rethrow) throw e;
    console.error(`[lifecycle] could not commit ${LIFECYCLE_PIN_PATH} for ${domain}:`, (e as Error).message);
    return null;
  }
}

// ============================================ the pin as a VERSIONED OBJECT ===
/**
 * `registerGitObject('lifecycle-pin', …)` — the reader half of this writer (checklist G3/G7).
 *
 * The pin file is the one git object whose writer lives in @core rather than a tab, so the
 * resolver lives beside the writer: there is no tab to register it, and inventing one would put
 * knowledge of `os/lifecycle/pins.yml` somewhere that does not own it. `instrumentation.ts` still
 * does the registering, so every kind is wired in one visible place.
 *
 * THE OBJECT ID IS THE PIN KEY (`<kind>:<id>`) — exactly what `setLivePin` stamps into
 * `OS-Object`, so the trailer lookup finds the pin's own commits and the path fallback finds the
 * domain's other pin commits. Gating: the pin file is readable by any member of its domain (an
 * admin sees every domain), and a pin the caller may not see answers `null`, which the generic
 * read turns into the same `not_found` as a pin that does not exist (G5).
 */
export type PinGitObjectUser = { id: string; domains: string[]; role: string };

export async function lifecyclePinGitObjectResolver(
  user: PinGitObjectUser,
  id: string,
): Promise<{ domain: string; paths: string[]; trailerId: string; name: string } | null> {
  const parsed = parsePinKey(id);
  if (!parsed) return null;
  let pin: Pin | undefined;
  try {
    pin = await livePin(parsed.kind, parsed.id);
  } catch {
    // An index that could not be read is not evidence that the pin is absent — but it is also not
    // evidence that it exists, and the caller gets the same `not_found` either way.
    return null;
  }
  if (!pin || !pin.domain) return null;
  if (user.role !== 'admin' && !(user.domains ?? []).includes(pin.domain)) return null;
  return { domain: pin.domain, paths: [LIFECYCLE_PIN_PATH], trailerId: pinKey(parsed.kind, parsed.id), name: `${parsed.kind}:${parsed.id}` };
}
