/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { opensearchFetch } from '@core/adapters/opensearch/client';

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
 * imports (only the one OpenSearch client, core/adapters/opensearch/client.ts, over global
 * `fetch`) so it is directly unit-testable.
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
  /**
   * The WHOLE index for a read-only check, with NO side effect: unlike `list` it never probes
   * (the probe creates a missing index and reconciles settings/mappings) — only `_count` and
   * `_search`. `null` → unreachable, missing, or not a complete read (never a partial answer).
   */
  readOnlyList(size?: number): Promise<unknown[] | null>;
  /**
   * The docs whose `updatedAt` is at or after `sinceIso` — the CHEAP read a process uses to pick
   * up what another process wrote, without listing the whole index (`mirror-refresh.ts`). `null`
   * → unreachable, an error, more changed docs than `size`, or `updatedAt` is not an indexed field
   * of this index (a range query would silently match nothing) — the caller then lists the whole
   * index instead. A doc without `updatedAt` is never returned here; the periodic full listing
   * covers it. Does NOT probe.
   */
  changedSince(sinceIso: string, size?: number): Promise<unknown[] | null>;
  /** One doc's `_source`, or null when missing/unreachable. Does NOT probe. */
  getDoc(id: string): Promise<unknown | null>;
  /** Like `getDoc`, but says WHY there is no doc: 'absent' (the mirror answered 404 — the record
   *  is not there, e.g. another process deleted it) or 'unreachable' (no answer, or an error
   *  after retries — nothing can be concluded). Does NOT probe. */
  read(id: string): Promise<MirrorRead>;
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
  /** CREATE-ONLY, awaited (OpenSearch `PUT <index>/_create/<id>`): writes the doc only when no doc
   *  with that id exists. 'created' · 'exists' (409 — an existing doc is NEVER overwritten) ·
   *  'unreachable' (no answer or any other status — nothing can be concluded). */
  createDoc(id: string, doc: unknown): Promise<'created' | 'exists' | 'unreachable'>;
  /** AWAITED upsert: `ok:true` only when OpenSearch confirmed the write (2xx). Anything else —
   *  unreachable, timeout, a non-2xx after every attempt — is `ok:false` with the reason, and the
   *  caller must not claim the change persisted. Writes queued while the mirror was down go first. */
  writeConfirmed(id: string, doc: unknown, opts?: { attempts?: number; backoffMs?: number }): Promise<{ ok: true } | { ok: false; reason: string }>;
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
  /**
   * Test seam: resolves once every fire-and-forget send this mirror started (and the probe it may be
   * waiting on) has answered. A test that swaps the HTTP backend awaits it first, so an earlier
   * test's write cannot land in the next test's backend (CI, Nov 2026: "2 docs for 1").
   */
  __settled(): Promise<void>;
};

/** A partial update: top-level fields to replace, and top-level fields to remove. */
export type MirrorPatch = { set: Record<string, unknown>; unset: string[] };

/** The painless script behind `patchThrough` — top-level replace (not a deep merge) + removals. */
export const PATCH_SCRIPT = 'ctx._source.putAll(params.set); for (def k : params.unset) { ctx._source.remove(k); }';

export type MirrorRead = { state: 'found'; doc: unknown } | { state: 'absent' } | { state: 'unreachable' };

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

/**
 * A whole-index read (hydrate / list) returns every record of a store in one response — live
 * `os-datasets` is ~0.7 MB and took 2.5–5.8 s on 2026-11-20 — so it gets far longer than the
 * 2.5 s a single-doc call gets. Under the old shared 2.5 s cap the search was ABORTED at boot and
 * (then) read as an empty index: the 0.9.21 boot loaded zero datasets with OpenSearch healthy.
 */
export const WHOLE_INDEX_TIMEOUT_MS = 30_000;
/** OpenSearch's default `index.max_result_window` — the deepest `from + size` a search may page. */
export const MAX_RESULT_WINDOW = 10_000;

async function osFetch(path: string, init?: RequestInit, timeoutMs = 2500): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await opensearchFetch(path, {
      timeoutMs,
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
    // Declared field mappings can be ADDED to an existing index (a new field, or a field that
    // dynamic mapping has not seen yet); a conflicting change is refused by OpenSearch and left as is.
    const props = (body.mappings as { properties?: unknown } | undefined)?.properties;
    if (props && typeof props === 'object') {
      await osFetch(`/${index}/_mapping`, { method: 'PUT', body: JSON.stringify({ properties: props }) });
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

  /**
   * Read the WHOLE index, or say it could not. Pages with `from`/`size` (sorted by `_doc`, stable)
   * up to OpenSearch's default `index.max_result_window` of 10 000 hits. A result is COMPLETE only
   * when every page answered 2xx, did not time out, every shard answered (`failed` 0 and
   * `successful` = `total`), `hits.total` is exact (`relation` "eq") and the hits collected equal
   * it. Anything else is `{ complete:false }` and is never read as the store's contents: a failed
   * load must not look like an empty or a smaller store (0.9.21: aborted loads cached the dataset
   * registry and the user directory as near-empty).
   */
  async function readWhole(size: number): Promise<{ docs: unknown[]; complete: boolean; why?: string }> {
    const pageSize = Math.min(Math.max(1, Math.floor(size) || 1000), MAX_RESULT_WINDOW);
    const out: unknown[] = [];
    for (let from = 0; ; from += pageSize) {
      if (from + pageSize > MAX_RESULT_WINDOW && from > 0) {
        return { docs: out, complete: false, why: `more than ${MAX_RESULT_WINDOW} records — needs search_after paging` };
      }
      const res = await osFetch(`/${index}/_search?size=${pageSize}${from > 0 ? `&from=${from}` : ''}`, {
        method: 'POST',
        body: JSON.stringify({ query: { match_all: {} }, sort: ['_doc'], track_total_hits: true }),
      }, WHOLE_INDEX_TIMEOUT_MS);
      if (!res) return { docs: out, complete: false, why: `no answer within ${WHOLE_INDEX_TIMEOUT_MS} ms` };
      if (!res.ok) return { docs: out, complete: false, why: `HTTP ${res.status}` };
      let data: {
        timed_out?: boolean;
        _shards?: { total?: number; successful?: number; failed?: number };
        hits?: { total?: { value?: number; relation?: string } | number; hits?: { _source?: unknown }[] };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch (err) {
        return { docs: out, complete: false, why: `unreadable answer (${String(err)})` };
      }
      const hits = data?.hits?.hits;
      if (!Array.isArray(hits)) return { docs: out, complete: false, why: 'no hits array' };
      if (data.timed_out === true) return { docs: out, complete: false, why: 'search timed out' };
      const sh = data._shards;
      if (sh && ((sh.failed ?? 0) > 0 || (typeof sh.total === 'number' && typeof sh.successful === 'number' && sh.successful < sh.total))) {
        return { docs: out, complete: false, why: `shards answered ${sh.successful ?? '?'} of ${sh.total ?? '?'} (failed ${sh.failed ?? 0})` };
      }
      const total = typeof data.hits?.total === 'number' ? { value: data.hits.total, relation: 'eq' } : data.hits?.total;
      if (total && total.relation && total.relation !== 'eq') return { docs: out, complete: false, why: `hits.total is a lower bound (${total.relation} ${total.value})` };
      for (const h of hits) if (h._source !== undefined && h._source !== null) out.push(h._source);
      const expected = total?.value;
      if (typeof expected !== 'number') return { docs: out, complete: true }; // single page, no total reported
      if (out.length >= expected) {
        noteHydration(index, out.length, expected);
        return out.length === expected ? { docs: out, complete: true } : { docs: out, complete: false, why: `got ${out.length} hits for a total of ${expected}` };
      }
      if (hits.length < pageSize) {
        noteHydration(index, out.length, expected);
        return { docs: out, complete: false, why: `loaded ${out.length} of ${expected}` };
      }
    }
  }

  // ONE in-flight whole-index load per mirror: concurrent callers (several stores hydrating at
  // boot) share it, so a slow or aborted second load can never overwrite a complete first one.
  let inflight: Promise<unknown[] | null> | null = null;

  function hydrate(size = 1000): Promise<unknown[] | null> {
    if (!inflight) {
      inflight = (async () => {
        if (!(await probe())) return null;
        const r = await readWhole(size);
        if (r.complete) return r.docs;
        console.error(`[os-mirror] ${index}: hydration NOT complete (${r.why}) — not treated as the store's contents; the store will retry`);
        return null;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  async function list(size = 1000): Promise<{ docs: unknown[]; complete: boolean } | null> {
    if (!(await probe())) return null;
    const r = await readWhole(size);
    return r.complete ? { docs: r.docs, complete: true } : { docs: [], complete: false };
  }

  async function readOnlyList(size = 1000): Promise<unknown[] | null> {
    const ping = await osFetch(`/${index}/_count`);
    if (!ping || !ping.ok) return null;
    const r = await readWhole(size);
    return r.complete ? r.docs : null;
  }

  // Is `updatedAt` an indexed field here? A range query on an unmapped field (an index created
  // with `dynamic:false`, e.g. os-apps before it declared the field) matches NOTHING without any
  // error — which would read as "nothing changed" forever. Checked until it is found mapped
  // (a mapping is never removed), and said once while it is not.
  let updatedAtMapped = false;
  let unmappedLogged = false;
  async function updatedAtIsMapped(): Promise<boolean | null> {
    if (updatedAtMapped) return true;
    const res = await osFetch(`/${index}/_mapping/field/updatedAt`);
    if (!res || !res.ok) return null;
    let data: Record<string, { mappings?: Record<string, unknown> }>;
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.warn(`[os-mirror] ${index}: unreadable field mapping (${String(err)})`);
      return null;
    }
    updatedAtMapped = Object.values(data ?? {}).some((m) => m?.mappings && 'updatedAt' in m.mappings);
    if (!updatedAtMapped && !unmappedLogged) {
      unmappedLogged = true;
      console.warn(`[os-mirror] ${index}: 'updatedAt' is not an indexed field — changes are read by listing the whole index`);
    }
    return updatedAtMapped;
  }

  async function changedSince(sinceIso: string, size = 500): Promise<unknown[] | null> {
    if ((await updatedAtIsMapped()) !== true) return null; // unmapped or unknown: the caller lists instead
    const res = await osFetch(`/${index}/_search?size=${size}`, {
      method: 'POST',
      body: JSON.stringify({ query: { range: { updatedAt: { gte: sinceIso } } }, track_total_hits: true }),
    });
    if (!res || !res.ok) return null;
    let data: { timed_out?: boolean; hits?: { total?: { value?: number } | number; hits?: { _source?: unknown }[] } };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.warn(`[os-mirror] ${index}: unreadable changes answer (${String(err)})`);
      return null;
    }
    const hits = data?.hits?.hits;
    if (!Array.isArray(hits) || data.timed_out === true) return null;
    const total = typeof data.hits?.total === 'number' ? data.hits.total : data.hits?.total?.value;
    if (typeof total === 'number' && total > hits.length) return null; // more than one page: list instead
    return hits.map((h) => h._source).filter((d) => d !== undefined && d !== null);
  }

  async function read(id: string): Promise<MirrorRead> {
    // A by-id GET must distinguish "genuinely absent" (404) from a TRANSIENT
    // failure (5xx / auth blip / timeout-with-response). Conflating the two made a
    // momentary OpenSearch hiccup surface as a false "not found" (the intermittent
    // "commit → App not found"). So: 404 and an unreachable cluster answer at once
    // (offline-degrade, no wasted retries); a transient non-404 error is retried a
    // couple times before we give up. Still NEVER throws.
    for (let attempt = 0; ; attempt++) {
      const res = await osFetch(`/${index}/_doc/${encodeURIComponent(id)}`);
      if (!res) return { state: 'unreachable' };
      if (res.status === 404) return { state: 'absent' };
      if (res.ok) {
        try {
          const body = (await res.json()) as { _source?: unknown };
          return body?._source != null ? { state: 'found', doc: body._source } : { state: 'unreachable' };
        } catch {
          return { state: 'unreachable' };
        }
      }
      if (attempt >= 2) return { state: 'unreachable' };
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }

  async function getDoc(id: string): Promise<unknown | null> {
    const r = await read(id);
    return r.state === 'found' ? r.doc : null;
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
  /** Fire-and-forget sends still in flight ({@link OsMirror.__settled}). */
  const sending = new Set<Promise<unknown>>();
  // Only WHEN it settles is recorded; what it answered is the send's own business, exactly as with the `void` before.
  const track = (p: Promise<unknown>): void => {
    const t: Promise<unknown> = Promise.allSettled([p]).then(() => sending.delete(t));
    sending.add(t);
  };
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
    track(probe().then((ok) => {
      if (ok) flushPending();
    }));
  }

  async function createDoc(id: string, doc: unknown): Promise<'created' | 'exists' | 'unreachable'> {
    const res = await osFetch(`/${index}/_create/${encodeURIComponent(id)}?refresh=true`, { method: 'PUT', body: JSON.stringify(doc) });
    if (!res) return 'unreachable';
    if (res.status === 409) return 'exists';
    return res.ok ? 'created' : 'unreachable';
  }

  async function writeConfirmed(
    id: string,
    doc: unknown,
    o: { attempts?: number; backoffMs?: number } = {},
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const attempts = Math.max(1, o.attempts ?? 3);
    const backoffMs = o.backoffMs ?? 100;
    const s = st();
    if (!(s.probed && s.healthy) && !(await probe())) {
      return { ok: false, reason: 'the shared store (OpenSearch) is unreachable' };
    }
    flushPending(); // an older queued write for this id must not land AFTER this one
    const body = JSON.stringify(doc);
    let reason = 'no answer';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * attempt));
      const res = await osFetch(`/${index}/_doc/${encodeURIComponent(id)}?refresh=true`, { method: 'PUT', body });
      if (!res) { reason = 'no answer (network error or timeout)'; continue; }
      if (res.ok) return { ok: true };
      reason = `HTTP ${res.status}`;
    }
    return { ok: false, reason: `the shared store did not confirm the write (${reason}, ${attempts} attempts)` };
  }

  function writeThrough(id: string, doc: unknown): void {
    const body = JSON.stringify(doc);
    sendThrough(() => {
      track(osFetch(`/${index}/_doc/${id}?refresh=true`, { method: 'PUT', body }));
    });
  }

  function deleteThrough(id: string): void {
    sendThrough(() => {
      track(osFetch(`/${index}/_doc/${id}?refresh=true`, { method: 'DELETE' }));
    });
  }

  function patchThrough(id: string, patch: MirrorPatch, o?: { upsert?: unknown }): void {
    const body = JSON.stringify({
      script: { lang: 'painless', source: PATCH_SCRIPT, params: { set: patch.set, unset: patch.unset } },
      ...(o?.upsert !== undefined ? { upsert: o.upsert } : {}),
    });
    sendThrough(() => {
      track(osFetch(`/${index}/_update/${id}?refresh=true&retry_on_conflict=3`, { method: 'POST', body }));
    });
  }

  return {
    index,
    healthy: () => st().healthy,
    probe,
    hydrate,
    list,
    readOnlyList,
    changedSince,
    getDoc,
    read,
    claim,
    deleteConfirmed,
    createDoc,
    writeConfirmed,
    writeThrough,
    deleteThrough,
    patchThrough,
    __reset: () => {
      inflight = null;
      updatedAtMapped = false;
      unmappedLogged = false;
      const s = st();
      s.healthy = false;
      s.probed = false;
      s.lastProbeAt = 0;
      s.probing = null;
      pending.length = 0;
    },
    __settled: async () => {
      // A send can start another (a heal flushes the queue), so drain until nothing is in flight.
      while (sending.size > 0) await Promise.all([...sending]);
    },
  };
}
