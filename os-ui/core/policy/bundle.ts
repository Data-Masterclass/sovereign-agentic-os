/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The `os-data` OPA bundle: every policy document os-ui used to push, compiled into one
 *             bundle that OPA downloads, activates atomically and persists itself.
 * USER STORY: As a user I want my grants to survive every OPA restart, even while os-ui is down,
 *             and never to be replaced by a partial or empty set because a store was not loaded.
 * ARCHITECTURE:
 *   - Upstream contract: https://www.openpolicyagent.org/docs/management-bundles (bundle service,
 *     `.manifest` revision + roots, ETag / If-None-Match → 304, `persist` +
 *     `persistence_directory`). OPA polls `GET /api/opa/bundles/os-data.tar.gz` every 5–15 s.
 *   - `compileOsData()` = the chart's seed files (`OS_OPA_SEED`, rendered by the chart helper that
 *     also renders the push-mode OPA's seed files) + every `bundled` restore source run in CAPTURE mode (`opa-publish.ts`): the very
 *     code the push path runs, so the bundle holds exactly what the pushes held.
 *   - GUARDS (`bundle-guards.ts`), against what OPA has active: fewer tables, a missing internal
 *     table, or a drop above `opa.dataBundle.maxDropPercent` is refused until an admin
 *     acknowledges that exact content (Platform Admin → `/api/platform-admin/opa-bundle`). The
 *     revision is `<seq>-<hash>`, seq strictly increasing; a bundle older than the revision an OPA
 *     reports active (its If-None-Match) is never served to it.
 *   - COMPLETE OR NOTHING. A source that fails or reports its store unloaded, a missing seed, or a
 *     result with zero grant principals or zero governance principals rejects the compile. The
 *     last good bundle keeps being served (same bytes, same ETag), and OPA keeps its last good
 *     activation. Before the first good compile the route answers 503, so a cold OPA stays
 *     unready and every decision fails closed.
 *   - Recompiled when a bundled document changes (`onBundledWrite`, debounced) and on a 60 s
 *     resync. The route never calls OPA and never calls a decision, so there is no start-up loop.
 *   - A refusal carries WHAT it would remove and add (`diffStats`, ids only), the threshold, and
 *     `since` — the start of the current refusal incident, kept across repeated refusals until a
 *     compile passes. `onOsDataBundleEvent` tells a listener (registered by the admin tab at boot,
 *     since the kernel never imports a tab) when a NEW refusal starts or a refusal ends, so the
 *     admin tab can audit it and raise the alert without this module knowing either exists.
 *   - Interim (design 04 §5.2): the sources read os-ui's stores, so os-ui stays one replica until
 *     they move to Postgres.
 */
import { createHash } from 'node:crypto';
import { config } from '@core/kernel/config';
import { scheduleEvery } from '@core/reconcile/runtime';
import { bundledOpaStateSources } from '@core/policy/opa-reconcile';
import { OS_DATA_ROOTS, onBundledWrite, opaPathSegments } from '@core/policy/opa-publish';
import { captureOpaWrites } from '@core/policy/opa-capture';
import { canonicalJson, tarGz } from '@core/policy/bundle-tar';
import { diffStats, guardReasons, revisionSeq, statsOf, type BundleDiff, type BundleStats } from '@core/policy/bundle-guards';
import { readOpaData } from '@core/policy/opa-publish';

export type OpaBundle = {
  name: string;
  /** os-data: `<seq>-<hash>` (seq strictly increasing); os-grants: `grant_rev`. */
  revision: string;
  /** Content hash of the data (os-data); equal content → equal hash. */
  hash?: string;
  seq?: number;
  stats?: BundleStats;
  /** The compiled data (os-data), kept to rebuild the file with its sequence number. */
  data?: Record<string, unknown>;
  etag: string;
  bytes: Buffer;
  compiledAt: string;
  detail: string;
};

export type CompileResult = { ok: true; bundle: OpaBundle } | { ok: false; detail: string };

type Tree = Record<string, unknown>;

// ---------------------------------------------------------------- os_data.users (10 F7) --

type DirectoryUser = { id: string; domains: string[]; role: string; disabled?: boolean; attrs?: Record<string, unknown> };
export type OsDataUser = { domains: Record<string, string>; tenant_role: string; active: boolean; attrs: Record<string, string> };

/** `os_data.users[uid]`. Only allow-listed attribute keys (chart `opa.dataBundle.abacAttributes`) pass. */
export function compileOsDataUsers(users: DirectoryUser[], allow: string[]): Record<string, OsDataUser> {
  const keys = new Set(allow);
  const out: Record<string, OsDataUser> = {};
  for (const u of users) {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(u.attrs ?? {})) if (keys.has(k) && v != null) attrs[k] = String(v);
    out[u.id] = {
      domains: Object.fromEntries([...new Set(u.domains)].sort().map((d) => [d, u.role])),
      tenant_role: u.role,
      active: !u.disabled,
      attrs,
    };
  }
  return out;
}

// ---------------------------------------------------------------- the bundle file --

/** The tar.gz for `data` under `roots`, its revision being the hash of the canonical data. */
export function buildBundle(name: string, data: Tree, roots: readonly string[], revision?: string): OpaBundle {
  const json = canonicalJson(data);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 20);
  const rev = revision ?? hash;
  const manifest = canonicalJson({ revision: rev, roots: [...roots] });
  return {
    name,
    revision: rev,
    hash,
    etag: `"${rev}"`,
    bytes: tarGz([{ name: '.manifest', content: manifest }, { name: 'data.json', content: json }]),
    compiledAt: new Date().toISOString(),
    detail: '',
  };
}

async function readSeed(): Promise<Tree> {
  const raw = config.opaSeed;
  if (!raw) throw new Error('OS_OPA_SEED is not set — the chart seed (seed_grants, requires_approval, governance) would be missing');
  const doc = JSON.parse(raw) as unknown;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('OS_OPA_SEED is not a JSON object');
  return doc as Tree;
}

/** Keep exactly the documents under `roots`; anything else in the tree is an error. */
function pickRoots(tree: Tree, roots: readonly string[]): Tree {
  const out: Tree = {};
  const rootSegs = roots.map((r) => opaPathSegments(r));
  const walk = (node: unknown, path: string[]): void => {
    const at = rootSegs.find((r) => r.length === path.length && r.every((s, i) => s === path[i]));
    if (at) {
      let o: Tree = out;
      for (const seg of path.slice(0, -1)) o = (o[seg] ??= {}) as Tree;
      o[path[path.length - 1]] = node;
      return;
    }
    const prefix = rootSegs.some((r) => r.length > path.length && path.every((s, i) => s === r[i]));
    if (!prefix || !node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`document data.${path.join('.')} is outside the os-data bundle roots`);
    }
    for (const [k, v] of Object.entries(node as Tree)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(tree)) walk(v, [k]);
  return out;
}

/** Compile the os-data bundle. Never throws; a failure names what was refused. */
export async function compileOsData(): Promise<CompileResult> {
  let seed: Tree;
  try {
    seed = await readSeed();
  } catch (err) {
    return { ok: false, detail: `seed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sources = bundledOpaStateSources();
  if (sources.length === 0) return { ok: false, detail: 'no bundled policy-state sources are registered' };
  const { result: outcomes, tree } = await captureOpaWrites(seed, async () => {
    const out: { name: string; ok: boolean; detail: string }[] = [];
    for (const s of sources) {
      try {
        const r = await s.restore();
        out.push({ name: s.name, ...r });
      } catch (err) {
        out.push({ name: s.name, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  });
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) return { ok: false, detail: `refused (incomplete source): ${failed.map((f) => `${f.name}: ${f.detail}`).join('; ')}` };
  let data: Tree;
  try {
    data = pickRoots(tree, OS_DATA_ROOTS);
  } catch (err) {
    return { ok: false, detail: `refused: ${err instanceof Error ? err.message : String(err)}` };
  }
  const stats = statsOf(data);
  // Never go to zero (no baseline needed): an empty grant map or principal map is a store that did
  // not load. The baseline guards run in recompileOsData, against what OPA has active.
  const zero = guardReasons(stats, null, 100);
  if (zero.length) return { ok: false, detail: `refused: ${zero.join('; ')}` };
  const bundle = buildBundle('os-data', data, OS_DATA_ROOTS);
  bundle.stats = stats;
  bundle.data = data;
  bundle.detail = `${stats.grants} grant principal(s), ${stats.principals} governance principal(s), ${stats.tables.length} table(s); ${outcomes.map((o) => `${o.name}: ${o.detail}`).join('; ')}`;
  return { ok: true, bundle };
}

// ---------------------------------------------------------------- last-good cache --

export type BundleCounts = { grants: number; principals: number; tables: number };
/** A compile the baseline guards refused. Ids only: no names, no e-mail addresses. */
export type Refusal = {
  /** The refused content's hash — what an admin acknowledges, exactly. */
  hash: string;
  /** The refused content's counts, and the baseline's it was judged against. */
  stats: BundleCounts;
  baseStats: BundleCounts | null;
  reasons: string[];
  /** The latest refusal of this content. */
  at: string;
  /** The start of this refusal incident: the first refusal since the last compile that passed. */
  since: string;
  /** The threshold the drop reasons were judged by (chart `opa.dataBundle.maxDropPercent`). */
  maxDropPercent: number;
  /** Exactly what would be removed and added (bounded lists + totals); null without a baseline with ids. */
  diff: BundleDiff | null;
};
type Ack = { hash: string; by: string; reason: string; at: string };

/** A refusal started (a NEW content hash refused), or a refused incident ended with a good compile. */
export type OsDataBundleEvent =
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'recovered'; revision: string; refusedSince: string; refusedHash: string; acknowledged: boolean };

function countsOf(x: BundleStats): BundleCounts {
  return { grants: x.grants, principals: x.principals, tables: x.tables.length };
}
type State = {
  last: OpaBundle | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** A compile the baseline guards refused; an admin may acknowledge exactly this content. */
  refused: Refusal | null;
  ack: Ack | null;
  /** The acknowledgement the last passing compile consumed (for the recovered event). */
  ackConsumed: boolean;
  /** When the last compile attempt finished, whatever its outcome. */
  checkedAt: string | null;
  listeners: Set<(e: OsDataBundleEvent) => void>;
  /** The highest os-data sequence any OPA has reported active (If-None-Match, status). */
  highestSeenSeq: number;
  inflight: Promise<CompileResult> | null;
  pending: ReturnType<typeof setTimeout> | null;
  stop: (() => void) | null;
};
const KEY = Symbol.for('soa.policy.os-data-bundle');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { last: null, lastError: null, lastErrorAt: null, refused: null, ack: null, ackConsumed: false, checkedAt: null, listeners: new Set(), highestSeenSeq: 0, inflight: null, pending: null, stop: null });
}

/** Listen for refusal starts and ends. Returns the unsubscribe. A throwing listener is logged, never fatal. */
export function onOsDataBundleEvent(fn: (e: OsDataBundleEvent) => void): () => void {
  const s = st();
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

function emit(e: OsDataBundleEvent): void {
  for (const fn of st().listeners) {
    try {
      fn(e);
    } catch (err) {
      console.error(`[os-ui] os-data bundle: event listener failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Record an os-data revision an OPA has active (from its If-None-Match or its status report). */
export function noteActiveOsDataRevision(revision: string | null | undefined): void {
  const seq = revisionSeq(revision);
  const s = st();
  if (seq !== null && seq > s.highestSeenSeq) s.highestSeenSeq = seq;
}

/**
 * The baseline a new compile is judged against: what OPA has ACTIVE (read from OPA, so an os-ui
 * restart does not forget it), else the last good bundle this process served, else none.
 */
async function baseline(): Promise<BundleStats | null> {
  const [g, p, t, rev] = await Promise.all([
    readOpaData('grants'), readOpaData('governance/principals'), readOpaData('governance/tables'),
    // OPA keeps each active bundle's manifest at data.system.bundles[<name>].manifest.
    readOpaData('system/bundles/os-data/manifest/revision'),
  ]);
  if (rev.defined) noteActiveOsDataRevision(String(rev.value));
  if (g.reachable && p.reachable && t.reachable && g.defined) {
    return statsOf({ grants: g.value, governance: { principals: p.value, tables: t.value } });
  }
  return st().last?.stats ?? null;
}

async function compileGuarded(): Promise<CompileResult> {
  const s = st();
  const r = await compileOsData();
  if (!r.ok) return r;
  const cand = r.bundle;
  // An acknowledgement is for exactly the content the admin reviewed, NOW. Any compile of other
  // content drops it, so content that changes and later comes back is judged (and reviewed) again.
  if (s.ack && s.ack.hash !== cand.hash) {
    console.warn(`[os-ui] os-data bundle: acknowledgement of ${s.ack.hash} by ${s.ack.by} dropped — the compiled content is now ${cand.hash}`);
    s.ack = null;
  }
  const base = await baseline();
  // Same content as the bundle already served: nothing new, keep its revision (so a pod that is
  // behind stays behind until its content really changes, and never out-numbers the active one).
  if (s.last && s.last.hash === cand.hash) return { ok: true, bundle: s.last };
  const maxDropPercent = config.opaMaxDropPercent;
  const reasons = guardReasons(cand.stats!, base, maxDropPercent);
  s.ackConsumed = false;
  if (reasons.length) {
    if (s.ack && s.ack.hash === cand.hash) {
      console.warn(`[os-ui] os-data bundle: guard override acknowledged by ${s.ack.by} (${s.ack.reason}) — ${reasons.join('; ')}`);
      s.ack = null;
      s.ackConsumed = true;
    } else {
      const now = new Date().toISOString();
      const prev = s.refused;
      s.refused = {
        hash: cand.hash!,
        stats: countsOf(cand.stats!),
        baseStats: base ? countsOf(base) : null,
        reasons,
        at: now,
        since: prev?.since ?? now,
        maxDropPercent,
        diff: diffStats(cand.stats!, base),
      };
      if (!prev || prev.hash !== cand.hash) emit({ kind: 'refused', refusal: s.refused });
      return { ok: false, detail: `refused (needs an admin acknowledgement of ${cand.hash}): ${reasons.join('; ')}` };
    }
  }
  const seq = Math.max(s.last?.seq ?? 0, s.highestSeenSeq) + 1;
  const b = buildBundle('os-data', cand.data!, OS_DATA_ROOTS, `${seq}-${cand.hash}`);
  Object.assign(b, { seq, stats: cand.stats, data: cand.data, detail: cand.detail });
  return { ok: true, bundle: b };
}

/** Recompile now (single-flight). A failure or a refusal keeps the last good bundle. */
export function recompileOsData(reason: string): Promise<CompileResult> {
  const s = st();
  if (!s.inflight) {
    s.inflight = compileGuarded()
      .then((r) => {
        s.checkedAt = new Date().toISOString();
        if (r.ok) {
          if (s.last?.revision !== r.bundle.revision) console.info(`[os-ui] os-data bundle: revision ${r.bundle.revision} (${reason}) — ${r.bundle.detail}`);
          s.last = r.bundle;
          s.lastError = null;
          s.lastErrorAt = null;
          const ended = s.refused;
          s.refused = null;
          // The refusal is over: an acknowledgement not consumed by this compile must not wait for later.
          s.ack = null;
          if (ended) emit({ kind: 'recovered', revision: r.bundle.revision, refusedSince: ended.since, refusedHash: ended.hash, acknowledged: s.ackConsumed });
          s.ackConsumed = false;
        } else {
          s.lastError = r.detail;
          s.lastErrorAt = new Date().toISOString();
          console.error(`[os-ui] os-data bundle: NOT recompiled (${reason}) — ${r.detail}; serving ${s.last ? `last good revision ${s.last.revision}` : 'nothing (OPA stays unready)'}`);
        }
        return r;
      })
      .finally(() => {
        s.inflight = null;
      });
  }
  return s.inflight;
}

/** The compile the guards refused, for the admin's acknowledgement. */
export function refusedOsDataBundle(): Refusal | null {
  return st().refused;
}

/** An admin accepts exactly the refused content `hash` once; the next compile of it passes. */
export function acknowledgeOsDataBundle(hash: string, by: string, reason: string): { ok: boolean; detail: string } {
  const s = st();
  if (!s.refused || s.refused.hash !== hash) return { ok: false, detail: `no refused bundle with content ${hash}` };
  s.ack = { hash, by, reason, at: new Date().toISOString() };
  console.warn(`[os-ui] os-data bundle: ${by} acknowledged refused content ${hash} (${reason}) — ${s.refused.reasons.join('; ')}`);
  return { ok: true, detail: 'acknowledged; recompiling' };
}

/**
 * Whether this process may serve its bundle to an OPA whose active revision is `ifNoneMatch`:
 * never an OLDER bundle than the one that OPA has active (an os-ui pod that is behind, e.g. the
 * old pod during a rolling update).
 */
export function olderThanActive(b: OpaBundle, ifNoneMatch: string | null): boolean {
  noteActiveOsDataRevision(ifNoneMatch);
  const active = revisionSeq(ifNoneMatch);
  if (active === null || b.seq === undefined) return false;
  if (b.hash && (ifNoneMatch ?? '').includes(`-${b.hash}`)) return false; // same content: a 304
  return b.seq < active;
}

/** The bundle to serve: the last good one, compiling once if there is none yet. */
export async function currentOsDataBundle(): Promise<OpaBundle | null> {
  const s = st();
  if (!s.last) await recompileOsData('first-request');
  return s.last;
}

export type OsDataBundleStatus = {
  revision: string | null;
  /** When the served revision was compiled (its last content change). */
  compiledAt: string | null;
  /** When the last compile attempt finished, whatever its outcome. */
  checkedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  refused: Refusal | null;
  /** The configured drop threshold, also when nothing is refused. */
  maxDropPercent: number;
  /** After how many minutes a refusal is raised as an alert (chart `opa.dataBundle.refusalAlertMinutes`). */
  refusalAlertMinutes: number;
};

export function osDataBundleStatus(): OsDataBundleStatus {
  const s = st();
  return {
    revision: s.last?.revision ?? null,
    compiledAt: s.last?.compiledAt ?? null,
    checkedAt: s.checkedAt,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
    refused: s.refused,
    maxDropPercent: config.opaMaxDropPercent,
    refusalAlertMinutes: config.opaRefusalAlertMinutes,
  };
}

/** Start the change listener and the resync (web process, bundle mode). Idempotent. */
export function startOsDataBundle(opts: { resyncMs?: number; debounceMs?: number } = {}): () => void {
  const s = st();
  if (s.stop) return s.stop;
  const debounceMs = opts.debounceMs ?? 250;
  const off = onBundledWrite(() => {
    if (s.pending) return;
    s.pending = setTimeout(() => {
      s.pending = null;
      void recompileOsData('change');
    }, debounceMs);
    s.pending.unref?.();
  });
  const stopResync = scheduleEvery('opa-bundle.os-data', opts.resyncMs ?? 60_000, () => recompileOsData('resync'));
  void recompileOsData('boot');
  s.stop = () => {
    off();
    stopResync();
    if (s.pending) clearTimeout(s.pending);
    s.pending = null;
    s.stop = null;
  };
  return s.stop;
}

/** Test hook: make this process hold `b` as its served bundle (e.g. a pod that is behind). */
export function __setServedOsDataBundleForTest(b: OpaBundle): void {
  st().last = b;
}

/** Test hook. */
export function __resetOsDataBundle(): void {
  const s = st();
  s.stop?.();
  s.last = null;
  s.lastError = null;
  s.lastErrorAt = null;
  s.refused = null;
  s.ack = null;
  s.ackConsumed = false;
  s.checkedAt = null;
  s.listeners.clear();
  s.highestSeenSeq = 0;
  s.inflight = null;
}

// ---------------------------------------------------------------- HTTP --

/** The documented bundle-service response: 304 on a matching If-None-Match, else the bytes + ETag. */
export function bundleHttpResponse(b: OpaBundle, ifNoneMatch: string | null, contentType = 'application/gzip'): Response {
  const headers = { ETag: b.etag, 'Content-Type': contentType, 'Cache-Control': 'no-store' };
  if (ifNoneMatch && ifNoneMatch.split(',').map((x) => x.trim()).includes(b.etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(b.bytes), { status: 200, headers });
}
