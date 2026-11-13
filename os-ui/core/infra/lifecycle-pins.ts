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
import yaml from 'js-yaml';

import { osMirror } from '@core/infra/os-mirror';
import { config } from '@core/kernel/config';
import {
  commitSubtree,
  appendTrailers,
  authorFor,
  reserveSubtree,
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

type PinState = { cache: LifecycleIndex | null; migrated: boolean };
const STATE_KEY = Symbol.for('soa.lifecycle.pins');
function state(): PinState {
  const g = globalThis as unknown as Record<symbol, PinState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { cache: null, migrated: false };
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

/** The whole index, hydrated once. A dead mirror yields an EMPTY index, never a throw. */
export async function lifecycleIndex(): Promise<LifecycleIndex> {
  const s = state();
  if (s.cache) return s.cache;
  const pins: Record<string, Pin> = {};
  const tests: Record<string, TestMarker> = {};
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const d of docs as PinDoc[]) {
    if (!d?.key || !d.ref) continue;
    if (d.test) tests[d.key] = { ref: d.ref, at: d.at };
    else pins[d.key] = { ref: d.ref, at: d.at, by: d.by, domain: d.domain, ...(d.path ? { path: d.path } : {}) };
  }
  s.cache = { pins, tests };
  return s.cache;
}

/** Whether the durable mirror actually answered — the gate a one-time migration must check. */
export function pinsHydrationState(): 'cold' | 'hydrated' | 'offline' {
  if (!state().cache) return 'cold';
  return mirror.healthy() ? 'hydrated' : 'offline';
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
  return { pinned, domains: [...domains].sort() };
}

/** Test seam: drop the in-process index so a test starts from nothing. */
export function __resetLifecyclePins(): void {
  const s = state();
  s.cache = null;
  s.migrated = false;
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
};

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
