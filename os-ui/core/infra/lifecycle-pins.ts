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
 *   - The complexity of the whole lifecycle lives HERE, where nobody looks (simplicity contract
 *     §6). Two surfaces: a durable pin index (the standard globalThis + OpenSearch write-through
 *     mirror, so a laptop with no cluster works) and a committed YAML file per domain repo.
 *   - The committed file is `os/lifecycle/pins.yml` inside its OWN reserved subtree. A single
 *     `os/lifecycle.yml` is not representable with today's git-store exports without either
 *     reserving all of `os/` (which would change the dbt generator's delete semantics) or a
 *     read-merge-commit race against it — see deviation V-2 for the additive `commitPaths`
 *     export that makes the flat filename safe.
 *   - A WRITER, so it obeys the September-2026 rule: never commit on the strength of an
 *     unhydrated store. `setPin` writes its own index, which it has just hydrated, and the
 *     commit carries only lifecycle rows — it can never empty a tree.
 *   - The git TAG half of the pin needs S's `annotatedTag` in git-store (D17). Until that lands
 *     the pin is the YAML file plus the durable index, and `tagged: false` says so honestly
 *     rather than claiming a tag exists (deviation V-3).
 */
import 'server-only';
import { existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { osMirror } from '@core/infra/os-mirror';
import { config } from '@core/kernel/config';
import {
  commitSubtree,
  appendTrailers,
  authorFor,
  reserveSubtree,
  listRepos,
  readBlob,
  type CommitResult,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import {
  EMPTY_LIFECYCLE_INDEX,
  pinKey,
  parsePinKey,
  liveTagName,
  type LifecycleIndex,
  type LifecycleKind,
  type Pin,
  type TestMarker,
} from '@core/kernel/object-lifecycle';

/** The reserved subtree the pin file owns, and the file inside it. */
export const LIFECYCLE_PREFIX = 'os/lifecycle';
export const LIFECYCLE_PIN_PATH = 'os/lifecycle/pins.yml';

/** Declare the subtree ours, so the whole-tree dbt generator keeps the pin file. */
export function reserveLifecycleSubtree(): void {
  reserveSubtree(LIFECYCLE_PREFIX);
}

// ------------------------------------------------------------- durable index ---

type PinDoc = {
  key: string;
  kind: string;
  id: string;
  ref: string;
  at: string;
  by: string;
  domain: string;
  /** The repo path of the pinned definition, for a git-backed kind. */
  path?: string;
  /** A test marker, not a pin: set while a draft is being run from Studio. */
  test?: boolean;
};

/**
 * `source` records HOW the index was hydrated, which is the difference between "nothing is live"
 * and "we could not find out" — the September-2026 lesson. A WRITER refuses unless it is
 * `mirror` or `git`; a read degrades to an empty index, as every read path should.
 */
type PinSource = 'cold' | 'mirror' | 'git' | 'none';
type PinState = { cache: LifecycleIndex | null; migrated: boolean; source: PinSource };
const STATE_KEY = Symbol.for('soa.lifecycle.pins');
function state(): PinState {
  const g = globalThis as unknown as Record<symbol, PinState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null, migrated: false, source: 'cold' };
  return g[STATE_KEY]!;
}

const mirror = osMirror({
  index: 'os-lifecycle-pins',
  createBody: {
    mappings: {
      properties: {
        key: { type: 'keyword' },
        kind: { type: 'keyword' },
        id: { type: 'keyword' },
        ref: { type: 'keyword' },
        domain: { type: 'keyword' },
        by: { type: 'keyword' },
        at: { type: 'date' },
        test: { type: 'boolean' },
      },
    },
  },
});

function docId(key: string, test: boolean): string {
  return `${test ? 'test' : 'pin'}-${key.replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
}

/** The sentinel document that records that the one-time migration has run. */
const MIGRATION_DOC = 'meta-migration';

/**
 * The whole index, hydrated once.
 *
 * TWO sources, in order, because **git is the system of record and the mirror is a cache**:
 *   1. the durable mirror (`os-lifecycle-pins`);
 *   2. failing that, the committed `os/lifecycle/pins.yml` in every domain repo — the same bytes
 *      an engineer reads in a clone.
 * If neither answers, the index is EMPTY and `source` is `none`, so a reader degrades (as every
 * read path should) while every WRITER refuses (`assertPinsWritable`). An empty index from a
 * source that DID answer is a fact; an empty index from a dead source is not.
 */
export async function lifecycleIndex(): Promise<LifecycleIndex> {
  const s = state();
  if (s.cache) return s.cache;
  const pins: Record<string, Pin> = {};
  const tests: Record<string, TestMarker> = {};
  const docs = await mirror.hydrate(2000);
  if (docs) {
    for (const d of docs as PinDoc[]) {
      if (d && (d as { key?: string }).key === MIGRATION_DOC) {
        s.migrated = true;
        continue;
      }
      if (!d?.key || !d.ref) continue;
      if (d.test) tests[d.key] = { ref: d.ref, at: d.at };
      else pins[d.key] = { ref: d.ref, at: d.at, by: d.by, domain: d.domain, ...(d.path ? { path: d.path } : {}) };
    }
    s.source = 'mirror';
    // GIT IS THE SYSTEM OF RECORD. A mirror that answers but knows no pins is the dangerous
    // shape — an index rebuilt after data loss looks exactly like a tenant that never went live,
    // and the next pin write would render `live: []` and commit away every row the domain had.
    // So when the mirror has nothing, the committed pin files are read and adopted.
    if (Object.keys(pins).length === 0) {
      const fromGit = await hydrateFromRepos();
      const recovered = Object.entries(fromGit ?? {});
      if (recovered.length > 0) {
        for (const [key, pin] of recovered) pins[key] = pin;
        s.migrated = true;
        console.error(
          `[lifecycle] the pin mirror answered EMPTY but ${recovered.length} pin(s) are committed in the domain repos — adopted from os/lifecycle/pins.yml, because git is the system of record`,
        );
      }
    }
  } else {
    const fromGit = await hydrateFromRepos();
    if (fromGit) {
      for (const [key, pin] of Object.entries(fromGit)) pins[key] = pin;
      s.source = 'git';
      s.migrated = Object.keys(fromGit).length > 0;
      console.error(
        `[lifecycle] the pin mirror is unreachable — hydrated ${Object.keys(fromGit).length} pin(s) from the committed os/lifecycle/pins.yml instead (git is the system of record)`,
      );
    } else {
      s.source = 'none';
      console.error('[lifecycle] NEITHER the pin mirror NOR the domain repos answered — the index is empty and every pin WRITE is refused until one does');
    }
  }
  s.cache = { pins, tests };
  return s.cache;
}

/**
 * Read every domain's committed pin file. `null` when the repos could not be listed AT ALL —
 * which is the distinction the whole gate rests on.
 *
 * `listRepos` answers `[]` both for "a readable root with no repos" (a fresh tenant — a FACT)
 * and for "the directory is not there" (an unmounted volume on a fresh pod — NOT a fact). Only
 * the first may unlock a write, so the root's existence is checked explicitly: otherwise a pod
 * whose repo volume had not attached yet would render a pin file from an empty index and commit
 * away every row the domain had. That is the September-2026 shape, in a new place.
 */
async function hydrateFromRepos(deps: { reposDir?: string } = {}): Promise<Record<string, Pin> | null> {
  const reposDir = deps.reposDir ?? config.reposDir;
  if (!reposDir || !existsSync(reposDir)) return null;
  let repos: { name: string }[];
  try {
    repos = await listRepos({ reposDir });
  } catch {
    return null; // the repo root itself is unreadable — "we could not find out"
  }
  const out: Record<string, Pin> = {};
  for (const r of repos) {
    let text: string;
    try {
      text = await readBlob(r.name, undefined, LIFECYCLE_PIN_PATH, { reposDir });
    } catch {
      continue; // this domain has nothing live — a fact, not a failure
    }
    for (const row of parsePinFile(text)) {
      out[pinKey(row.kind, row.id)] = { ref: row.ref, at: row.at, by: row.by, domain: r.name, ...(row.path ? { path: row.path } : {}) };
    }
  }
  return out;
}

/**
 * Hydration state. `hydrated` means a source ANSWERED (the mirror, or the repos) — not that it
 * returned rows. Everything that WRITES must check this first, because an empty index from a
 * dead mirror is indistinguishable from a tenant that has nothing live, and committing a pin
 * file rendered from it would silently un-live everything.
 */
export function pinsHydrationState(): 'cold' | 'hydrated' | 'offline' {
  const s = state();
  if (!s.cache) return 'cold';
  return s.source === 'mirror' || s.source === 'git' ? 'hydrated' : 'offline';
}

/** Whether the one-time "everything existing is Live" migration has run for this tenant. */
export function pinsMigrated(): boolean {
  return state().migrated;
}

/** Record that the migration has run, durably, so a restart does not re-run or re-decide. */
function markMigrated(): void {
  state().migrated = true;
  mirror.writeThrough(MIGRATION_DOC, { key: MIGRATION_DOC, at: new Date().toISOString() });
}

/** The 503 every pin WRITE is gated on. */
function assertPinsWritable(): void {
  const st = pinsHydrationState();
  if (st === 'hydrated') return;
  const e = new Error(
    st === 'cold'
      ? 'the lifecycle pin index has not been read yet — try again in a moment'
      : 'the lifecycle pin index could not be read (neither the durable mirror nor the domain repos answered), so the OS will not write a pin it cannot reconcile',
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
  /** The git tag the pin WOULD carry. False until S's tag API lands (deviation V-3). */
  tag: { name: string; written: boolean };
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
  /** Skip the git half entirely (unit tests of the index alone). */
  commit?: boolean;
  /** `ui:<route>` or `mcp:<tool>` — which door went live. */
  surface?: string;
};

/**
 * The pin commit's subject + trailers. Built here rather than through git-store's
 * `commitMessage`, whose `area` union is `data | agents` and belongs to other streams tonight;
 * the SHAPE is identical, so `parseTrailers` reads it back exactly the same way.
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

/**
 * Pin `ref` as what runs for this object, and record it in the domain's repo.
 * The ONLY way a live pin is created — there is no setter that takes a lifecycle word.
 */
export async function setLivePin(
  kind: LifecycleKind,
  id: string,
  ref: string,
  by: { id: string; name?: string | null; email?: string | null },
  domain: string,
  deps: PinWriteDeps = {},
  path?: string,
): Promise<SetPinResult> {
  const index = await lifecycleIndex();
  assertPinsWritable();
  const key = pinKey(kind, id);
  const pin: Pin = { ref, at: new Date().toISOString(), by: by.id, domain, ...(path ? { path } : {}) };
  index.pins[key] = pin;
  mirror.writeThrough(docId(key, false), { key, kind, id, ref, at: pin.at, by: by.id, domain, ...(path ? { path } : {}) });
  const commit = deps.commit === false ? null : await commitPinFile(domain, index, by, 'go-live', `${kind}:${id}`, deps);
  return { pin, tag: { name: liveTagName(kind, id), written: false }, commit };
}

/** Unpin. Run stops showing the object; NOTHING is deleted. */
export async function clearLivePin(
  kind: LifecycleKind,
  id: string,
  by: { id: string; name?: string | null; email?: string | null },
  domain: string,
  deps: PinWriteDeps = {},
): Promise<{ removed: boolean; commit: CommitResult | null }> {
  const index = await lifecycleIndex();
  assertPinsWritable();
  const key = pinKey(kind, id);
  const had = Boolean(index.pins[key]);
  delete index.pins[key];
  mirror.deleteThrough(docId(key, false));
  const commit = deps.commit === false ? null : await commitPinFile(domain, index, by, 'retire', `${kind}:${id}`, deps);
  return { removed: had, commit };
}

/**
 * Mark a draft as being tested — "run, build or preview the draft from Studio" is in flight.
 * NOT a managed state: there is nothing to administer and nothing is committed for it.
 */
export async function markTesting(kind: LifecycleKind, id: string, ref: string): Promise<void> {
  const index = await lifecycleIndex();
  const key = pinKey(kind, id);
  const at = new Date().toISOString();
  (index.tests ??= {})[key] = { ref, at };
  mirror.writeThrough(docId(key, true), { key, kind, id, ref, at, by: 'test', domain: '', test: true });
}

/** Clear the in-flight test marker when the run settles. */
export async function clearTesting(kind: LifecycleKind, id: string): Promise<void> {
  const index = await lifecycleIndex();
  const key = pinKey(kind, id);
  if (index.tests) delete index.tests[key];
  mirror.deleteThrough(docId(key, true));
}

/** Apply a migrated index wholesale (the one-time "everything existing is Live"). */
export async function applyMigratedIndex(
  next: LifecycleIndex,
  by: { id: string; name?: string | null; email?: string | null },
  deps: PinWriteDeps = {},
): Promise<{ pinned: number; domains: string[] }> {
  const index = await lifecycleIndex();
  assertPinsWritable();
  const domains = new Set<string>();
  let pinned = 0;
  for (const [key, pin] of Object.entries(next.pins)) {
    if (index.pins[key]) continue;
    const parts = parsePinKey(key);
    if (!parts) continue;
    index.pins[key] = pin;
    pinned += 1;
    domains.add(pin.domain);
    mirror.writeThrough(docId(key, false), {
      key,
      kind: parts.kind,
      id: parts.id,
      ref: pin.ref,
      at: pin.at,
      by: pin.by,
      domain: pin.domain,
    });
  }
  if (deps.commit !== false) {
    for (const domain of domains) {
      if (!domain) continue;
      await commitPinFile(domain, index, by, 'migrate', 'lifecycle', deps);
    }
  }
  markMigrated();
  return { pinned, domains: [...domains].sort() };
}

/**
 * Test seam: hydrate with the git fallback pointed at a temp `reposDir`. Production always reads
 * `config.reposDir`; a test cannot set an env var after the module has loaded, so the override is
 * explicit and used only here.
 */
export async function hydrateForTests(deps: { reposDir?: string } = {}): Promise<LifecycleIndex> {
  const s = state();
  if (s.cache) return s.cache;
  const pins: Record<string, Pin> = {};
  const docs = await mirror.hydrate(2000);
  if (docs) {
    s.source = 'mirror';
  } else {
    const fromGit = await hydrateFromRepos(deps);
    if (fromGit) {
      for (const [key, pin] of Object.entries(fromGit)) pins[key] = pin;
      s.source = 'git';
      s.migrated = Object.keys(fromGit).length > 0;
    } else {
      s.source = 'none';
    }
  }
  s.cache = { pins, tests: {} };
  return s.cache;
}

/** Test seam: drop the in-process index so a test starts from nothing. */
export function __resetLifecyclePins(): void {
  const s = state();
  s.cache = null;
  s.migrated = false;
  s.source = 'cold';
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
};

/**
 * Read a committed pin file back. This is the half that makes `os/lifecycle/pins.yml`
 * authoritative rather than decorative: when the durable mirror is unreachable the OS hydrates
 * from these bytes, so git stays the system of record and the mirror stays a cache.
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
      tag: typeof r.tag === 'string' ? r.tag : liveTagName(kind, id),
      at: typeof r.at === 'string' ? r.at : '',
      by: typeof r.by === 'string' ? r.by : '',
      ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
    });
  }
  return out;
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
    '# What is LIVE in this domain — the pin the OS runs from.',
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
    { version: 1, domain, live: rows },
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
      reposDir: deps.reposDir ?? config.reposDir,
    });
  } catch (e) {
    // The durable index is the operative pin; the committed file is the transparency copy.
    // A repo that cannot be written is reported, never silently treated as a successful pin.
    console.error(`[lifecycle] could not commit ${LIFECYCLE_PIN_PATH} for ${domain}:`, (e as Error).message);
    return null;
  }
}

/** The empty index, for a caller that wants the shape without touching the store. */
export const EMPTY_INDEX: LifecycleIndex = EMPTY_LIFECYCLE_INDEX;

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
