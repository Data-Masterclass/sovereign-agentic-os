/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../core/config.ts';

/**
 * The ONE durable-mirror core every in-process store shares (approvals, audit,
 * artifacts, apps, connections, datasets, domains, users, pillars, prefs,
 * role-config, marketplace, agent-memory). Each store keeps its authoritative
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

export type OsMirror = {
  readonly index: string;
  /** Current best knowledge of mirror health (false until first probe). */
  healthy(): boolean;
  /** Probe the mirror (dedupes concurrent calls); creates the index on 404. */
  probe(): Promise<boolean>;
  /** Probe, then `match_all` up to `size` docs. `null` → mirror unreachable;
   *  `[]` → reachable but empty (a fresh index hydrates to nothing). */
  hydrate(size?: number): Promise<unknown[] | null>;
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
  /** Fire-and-forget upsert. While unhealthy, lazily re-probes (throttled) and,
   *  if the mirror healed, persists THIS doc. Earlier dropped writes are NOT
   *  replayed — the in-process store stays authoritative until the next roll. */
  writeThrough(id: string, doc: unknown): void;
  /** Fire-and-forget delete (same lazy-heal behavior as writeThrough). */
  deleteThrough(id: string): void;
  /** Test seam: forget probe state — simulates a fresh process. */
  __reset(): void;
};

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

  async function doProbe(): Promise<boolean> {
    const s = st();
    s.lastProbeAt = Date.now();
    const ping = await osFetch(`/${index}/_count`);
    if (ping && ping.ok) {
      s.healthy = true;
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
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (!res || !res.ok) return [];
    try {
      const data = (await res.json()) as { hits?: { hits?: { _source?: unknown }[] } };
      return (data?.hits?.hits ?? []).map((h) => h._source).filter((d) => d !== undefined && d !== null);
    } catch {
      return [];
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

  return {
    index,
    healthy: () => st().healthy,
    probe,
    hydrate,
    getDoc,
    claim,
    writeThrough,
    deleteThrough,
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
