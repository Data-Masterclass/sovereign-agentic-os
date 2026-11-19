/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '@core/kernel/config';

/**
 * The ONE durable-mirror core every in-process store shares (approvals, audit,
 * artifacts, apps, connections, datasets, domains, users, pillars, prefs,
 * role-config, agent-memory). Each store keeps its authoritative
 * in-process Map — this helper only handles the best-effort OpenSearch mirror:
 * probe, index bootstrap, hydration and fire-and-forget write/delete-through.
 *
 * THE BUG THIS FIXES (the artifact-loss-on-deploy incident): the previous
 * copy-pasted per-store pattern pinged `GET /<index>/_count` and treated ANY
 * non-ok answer as "mirror down". On a fresh cluster the index doesn't exist,
 * so the ping 404s → the store marked the mirror dead forever → writeThrough
 * no-oped → the index was NEVER created → every os-ui pod roll wiped all state
 * since the last roll. Correct semantics, implemented once here:
 *
 *   • `_count` ok            → mirror healthy.
 *   • `_count` 404           → cluster reachable, index missing → CREATE the
 *                              index (store-provided body, mappings unchanged)
 *                              → healthy. This is the bootstrap fix.
 *   • network error / 5xx    → mirror down — but only until the next lazy
 *                              re-probe: a write while unhealthy re-probes at
 *                              most once per `reprobeMs`, so a mirror that
 *                              comes up after boot self-heals without timers.
 *
 * Every path is graceful: an unreachable OpenSearch NEVER throws into a
 * request; the store simply stays in-memory. Kept free of `server-only`/Next
 * imports (only `config` + global `fetch`) so it is directly unit-testable.
 */

/**
 * HYDRATION SHORTFALLS — the honest interim for the store hydration caps. A store loads at most
 * `size` docs from its index at boot (500–5000 per store); when the index holds MORE, the rest are
 * absent from the in-process Map, so lists and searches silently miss them. Until the stores move
 * to a real database (the structural fix), every such load is logged loudly and recorded here, and
 * `/api/status` shows it as a health warning. A later full load clears the record.
 */
export type HydrationShortfall = { index: string; loaded: number; total: number; at: string };

const SHORTFALLS = Symbol.for('sovereign-os.os-mirror.shortfalls');

function shortfallMap(): Map<string, HydrationShortfall> {
  const g = globalThis as unknown as Record<symbol, Map<string, HydrationShortfall> | undefined>;
  return (g[SHORTFALLS] ??= new Map());
}

function totalOf(total: { value?: number } | number | undefined): number | undefined {
  return typeof total === 'number' ? total : total?.value;
}

/** Record (or clear) one load's shortfall; a short load is also logged as an error. */
function noteHydration(index: string, loaded: number, total: number | undefined): void {
  if (typeof total !== 'number' || total <= loaded) {
    shortfallMap().delete(index);
    return;
  }
  shortfallMap().set(index, { index, loaded, total, at: new Date().toISOString() });
  console.error(`[os-mirror] ${index}: loaded ${loaded} of ${total} records — ${total - loaded} are missing from this process (the store's hydration cap). Lists and searches over this store are INCOMPLETE.`);
}

/** Every store whose last load was cut short — the health warning `/api/status` reports. */
export function hydrationShortfalls(): HydrationShortfall[] {
  return [...shortfallMap().values()];
}

export type OsMirror = {
  readonly index: string;
  /** Current best knowledge of mirror health (false until first probe). */
  healthy(): boolean;
  /** Probe the mirror (dedupes concurrent calls); creates the index on 404. */
  probe(): Promise<boolean>;
  /** Probe, then `match_all` up to `size` docs. `null` → mirror unreachable;
   *  `[]` → reachable but empty (a fresh index hydrates to nothing). */
  hydrate(size?: number): Promise<unknown[] | null>;
  /**
   * Like `hydrate`, but says whether the answer is the WHOLE index. `complete` is true only when
   * the search itself succeeded on every shard, did not time out, and returned as many docs as it
   * says exist — so "this id is not in `docs`" then means "this doc is not in the mirror".
   * A failed search answers `{ docs: [], complete: false }` (never mistaken for an empty index);
   * `null` → mirror unreachable. This is what lets a reader process DROP what another deleted.
   */
  list(size?: number): Promise<{ docs: unknown[]; complete: boolean } | null>;
  /** One doc's `_source`, or null when missing/unreachable. Does NOT probe. */
  getDoc(id: string): Promise<unknown | null>;
  /** Atomic single-use claim: an AWAITED delete that reports who won the race.
   *  'won'         → this caller deleted an existing doc (authoritative single-use);
   *  'lost'        → the doc was already gone (another caller won / never existed);
   *  'unreachable' → mirror error/timeout — the caller must NOT treat it as claimed.
   *  Unlike `deleteThrough` this is NOT fire-and-forget: it lets a store gate a
   *  single-use action (e.g. refresh-token rotation) on the mirror's OWN atomic
   *  delete instead of read-then-fire-and-forget-delete (which can resurrect). */
  claim(id: string): Promise<'won' | 'lost' | 'unreachable'>;
  /** An AWAITED delete with bounded retry, for a store that must not tell the user a record is
   *  gone before the shared store agrees. `ok:true` only when OpenSearch confirmed it:
   *  'deleted' (it held the doc) or 'absent' (404 — already gone, or never mirrored). Anything
   *  else — unreachable, timeout, 5xx after every attempt — is `ok:false` with the reason, and
   *  the caller must keep the record. Writes queued while the mirror was down go out first. */
  deleteConfirmed(id: string, opts?: { attempts?: number; backoffMs?: number }): Promise<DeleteOutcome>;
  /** Fire-and-forget upsert. While unhealthy, lazily re-probes (throttled) and,
   *  if the mirror healed, persists THIS doc. Earlier dropped writes are NOT
   *  replayed — the in-process store stays authoritative until the next roll. */
  writeThrough(id: string, doc: unknown): void;
  /** Fire-and-forget delete (same lazy-heal behavior as writeThrough). */
  deleteThrough(id: string): void;
  /**
   * Fire-and-forget PARTIAL update: replace only the top-level fields in `set` and remove those
   * in `unset`; every other field of the stored doc is left as it is. Two processes that each
   * own a disjoint set of a record's fields can therefore write the same record without either
   * putting its stale copy of the other's fields back. Without `upsert` a missing doc stays
   * missing (OpenSearch answers 404) — a partial write never creates or resurrects a record;
   * with `upsert` that doc is stored when none exists. Same queue/lazy-heal as writeThrough.
   */
  patchThrough(id: string, patch: MirrorPatch, opts?: { upsert?: unknown }): void;
  /** Test seam: forget probe state — simulates a fresh process. */
  __reset(): void;
};

/** A partial update: top-level fields to replace, and top-level fields to remove. */
export type MirrorPatch = { set: Record<string, unknown>; unset: string[] };

/** The painless script behind `patchThrough` — top-level replace (not a deep merge) + removals. */
export const PATCH_SCRIPT = 'ctx._source.putAll(params.set); for (def k : params.unset) { ctx._source.remove(k); }';

export type DeleteOutcome =
  | { ok: true; result: 'deleted' | 'absent' }
  | { ok: false; reason: string };

type MirrorState = {
  healthy: boolean;
  probed: boolean;
  lastProbeAt: number;
  probing: Promise<boolean> | null;
};

/** Re-probe an unhealthy mirror at most this often (lazy, on write). */
const DEFAULT_REPROBE_MS = 60_000;

// Pinned to globalThis per index so all separately-bundled Next.js route
// handlers share ONE health state per mirror (and it survives dev HMR).
function mirrorState(index: string): MirrorState {
  const key = Symbol.for(`soa.os-mirror.${index}`);
  const g = globalThis as unknown as Record<symbol, MirrorState | undefined>;
  if (!g[key]) g[key] = { healthy: false, probed: false, lastProbeAt: 0, probing: null };
  return g[key]!;
}

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function osMirror(opts: {
  index: string;
  /** Index-creation body (settings/mappings) used verbatim on bootstrap.
   *  Omitted → `{}` (dynamic mappings, same as OpenSearch auto-create). */
  createBody?: Record<string, unknown>;
  reprobeMs?: number;
}): OsMirror {
  const { index } = opts;
  const reprobeMs = opts.reprobeMs ?? DEFAULT_REPROBE_MS;
  const st = () => mirrorState(index);
  let reconciled = false; // once-per-process: heal an EXISTING index's updatable settings/mappings.

  // For an index that ALREADY exists, `createBody` (used only at CREATE time) never applied. The
  // two settings we care about — `index.mapping.total_fields.limit` and mapping `dynamic` — ARE
  // live-updatable (unlike a field's TYPE), so reconcile them once, best-effort. This heals an
  // index that was auto-created with the default 1000-field limit + dynamic mappings and has since
  // been blowing up on docs with large/variable JSON (the "published app disappears" class).
  async function reconcileExisting(): Promise<void> {
    if (reconciled || !opts.createBody) return;
    reconciled = true;
    const body = opts.createBody as { settings?: unknown; mappings?: unknown };
    if (body.settings) {
      await osFetch(`/${index}/_settings`, { method: 'PUT', body: JSON.stringify(body.settings) });
    }
    if (body.mappings && typeof body.mappings === 'object' && 'dynamic' in (body.mappings as object)) {
      const dyn = (body.mappings as { dynamic?: unknown }).dynamic;
      await osFetch(`/${index}/_mapping`, { method: 'PUT', body: JSON.stringify({ dynamic: dyn }) });
    }
  }

  async function doProbe(): Promise<boolean> {
    const s = st();
    s.lastProbeAt = Date.now();
    const ping = await osFetch(`/${index}/_count`);
    if (ping && ping.ok) {
      s.healthy = true;
      void reconcileExisting(); // best-effort, never blocks the probe
    } else if (ping && ping.status === 404) {
      // Cluster reachable, index missing → create it (the bootstrap fix).
      const created = await osFetch(`/${index}`, {
        method: 'PUT',
        body: JSON.stringify(opts.createBody ?? {}),
      });
      // 400 = resource_already_exists (a concurrent creator won the race).
      s.healthy = Boolean(created && (created.ok || created.status === 400));
    } else {
      // Network error / timeout / 5xx / auth failure — mirror down for now.
      s.healthy = false;
    }
    s.probed = true;
    return s.healthy;
  }

  function probe(): Promise<boolean> {
    const s = st();
    if (!s.probing) {
      s.probing = doProbe().finally(() => {
        s.probing = null;
      });
    }
    return s.probing;
  }

  async function hydrate(size = 1000): Promise<unknown[] | null> {
    if (!(await probe())) return null;
    const res = await osFetch(`/${index}/_search?size=${size}`, {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} }, track_total_hits: true }),
    });
    if (!res || !res.ok) return [];
    try {
      const data = (await res.json()) as { hits?: { total?: { value?: number } | number; hits?: { _source?: unknown }[] } };
      const docs = (data?.hits?.hits ?? []).map((h) => h._source).filter((d) => d !== undefined && d !== null);
      noteHydration(index, docs.length, totalOf(data?.hits?.total));
      return docs;
    } catch {
      return [];
    }
  }

  async function list(size = 1000): Promise<{ docs: unknown[]; complete: boolean } | null> {
    if (!(await probe())) return null;
    const res = await osFetch(`/${index}/_search?size=${size}`, {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} }, track_total_hits: true }),
    });
    if (!res || !res.ok) return { docs: [], complete: false };
    try {
      const data = (await res.json()) as {
        timed_out?: boolean;
        _shards?: { total?: number; successful?: number; failed?: number };
        hits?: { total?: { value?: number; relation?: string } | number; hits?: { _source?: unknown }[] };
      };
      const hits = data?.hits?.hits;
      if (!Array.isArray(hits)) return { docs: [], complete: false };
      const total = typeof data.hits?.total === 'number' ? { value: data.hits.total, relation: 'eq' } : data.hits?.total;
      const shards = data._shards;
      const complete =
        data.timed_out === false &&
        !!shards && shards.failed === 0 && typeof shards.total === 'number' && shards.successful === shards.total &&
        !!total && total.relation === 'eq' && total.value === hits.length;
      const docs = hits.map((h) => h._source).filter((d) => d !== undefined && d !== null);
      noteHydration(index, docs.length, total?.value);
      return { docs, complete };
    } catch {
      return { docs: [], complete: false };
    }
  }

  async function getDoc(id: string): Promise<unknown | null> {
    // A by-id GET must distinguish "genuinely absent" (404) from a TRANSIENT
    // failure (5xx / auth blip / timeout-with-response). Conflating the two made a
    // momentary OpenSearch hiccup surface as a false "not found" (the intermittent
    // "commit → App not found"). So: 404 and an unreachable cluster return null
    // immediately (offline-degrade, no wasted retries); a transient non-404 error
    // is retried a couple times before we give up. Still NEVER throws.
    for (let attempt = 0; ; attempt++) {
      const res = await osFetch(`/${index}/_doc/${id}`);
      if (!res) return null; // cluster unreachable → graceful null
      if (res.status === 404) return null; // genuinely absent
      if (res.ok) {
        try {
          const body = (await res.json()) as { _source?: unknown };
          return body?._source ?? null;
        } catch {
          return null;
        }
      }
      // Transient non-404 error: retry up to 3 attempts, then degrade to null.
      if (attempt >= 2) return null;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }

  async function claim(id: string): Promise<'won' | 'lost' | 'unreachable'> {
    const res = await osFetch(`/${index}/_doc/${id}?refresh=true`, { method: 'DELETE' });
    if (!res) return 'unreachable'; // network error / timeout → cannot prove single-use
    if (res.status === 404) return 'lost'; // already deleted / never existed
    if (!res.ok) return 'unreachable'; // 5xx / auth failure → do NOT assume claimed
    try {
      const body = (await res.json()) as { result?: string };
      // OpenSearch DELETE returns result:"deleted" (won) or "not_found" (lost).
      return body?.result === 'not_found' ? 'lost' : 'won';
    } catch {
      return 'won'; // 2xx with an unreadable body — the delete succeeded
    }
  }

  async function deleteConfirmed(id: string, o: { attempts?: number; backoffMs?: number } = {}): Promise<DeleteOutcome> {
    const attempts = Math.max(1, o.attempts ?? 3);
    const backoffMs = o.backoffMs ?? 100;
    const s = st();
    if (!(s.probed && s.healthy) && !(await probe())) {
      return { ok: false, reason: 'the shared store (OpenSearch) is unreachable' };
    }
    flushPending(); // an older queued write for this id must not land AFTER the delete
    let reason = 'no answer';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * attempt));
      const res = await osFetch(`/${index}/_doc/${encodeURIComponent(id)}?refresh=true`, { method: 'DELETE' });
      if (!res) { reason = 'no answer (network error or timeout)'; continue; }
      if (res.status === 404) return { ok: true, result: 'absent' };
      if (res.ok) return { ok: true, result: 'deleted' };
      reason = `HTTP ${res.status}`;
    }
    return { ok: false, reason: `the shared store did not confirm the delete (${reason}, ${attempts} attempts)` };
  }

  // Writes that arrive while the mirror is unhealthy are QUEUED in order and
  // replayed on the next successful probe — NEVER silently dropped. The old
  // throttled path returned without sending, which opened a real write-loss
  // hole: an edit made during an unhealthy window lived only in this pod's
  // memory, and the next rollout hydrated the new pod from the mirror WITHOUT
  // it (seen live: a freshly defined metric vanished after a deploy). Bounded
  // so a long outage can't grow memory unboundedly; overflow drops the OLDEST
  // write and says so loudly — an operator signal, not a silent hole.
  const PENDING_MAX = 1000;
  const pending: Array<() => void> = [];
  function flushPending(): void {
    while (pending.length) pending.shift()!();
  }

  /** Send now if healthy; otherwise queue + lazily re-probe (throttled), replaying on heal. */
  function sendThrough(send: () => void): void {
    const s = st();
    if (s.probed && s.healthy) {
      flushPending(); // anything queued during an outage goes first, in order
      send();
      return;
    }
    pending.push(send);
    if (pending.length > PENDING_MAX) {
      pending.shift();
      console.warn(`[os-mirror:${index}] pending-write queue overflowed — oldest write dropped (mirror unhealthy too long)`);
    }
    // Re-probe at most once per reprobeMs; a probe already in flight (or the one
    // started here) flushes the whole queue on success.
    if (s.probed && !s.probing && Date.now() - s.lastProbeAt < reprobeMs) return;
    void probe().then((ok) => {
      if (ok) flushPending();
    });
  }

  function writeThrough(id: string, doc: unknown): void {
    const body = JSON.stringify(doc);
    sendThrough(() => {
      void osFetch(`/${index}/_doc/${id}?refresh=true`, { method: 'PUT', body });
    });
  }

  function deleteThrough(id: string): void {
    sendThrough(() => {
      void osFetch(`/${index}/_doc/${id}?refresh=true`, { method: 'DELETE' });
    });
  }

  function patchThrough(id: string, patch: MirrorPatch, o?: { upsert?: unknown }): void {
    const body = JSON.stringify({
      script: { lang: 'painless', source: PATCH_SCRIPT, params: { set: patch.set, unset: patch.unset } },
      ...(o?.upsert !== undefined ? { upsert: o.upsert } : {}),
    });
    sendThrough(() => {
      void osFetch(`/${index}/_update/${id}?refresh=true&retry_on_conflict=3`, { method: 'POST', body });
    });
  }

  return {
    index,
    healthy: () => st().healthy,
    probe,
    hydrate,
    list,
    getDoc,
    claim,
    deleteConfirmed,
    writeThrough,
    deleteThrough,
    patchThrough,
    __reset: () => {
      const s = st();
      s.healthy = false;
      s.probed = false;
      s.lastProbeAt = 0;
      s.probing = null;
      pending.length = 0;
    },
  };
}
