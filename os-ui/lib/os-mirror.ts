/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from './config.ts';

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
    const res = await osFetch(`/${index}/_doc/${id}`);
    if (!res || !res.ok) return null;
    try {
      const body = (await res.json()) as { _source?: unknown };
      return body?._source ?? null;
    } catch {
      return null;
    }
  }

  /** Send now if healthy; otherwise lazily re-probe (throttled) and send on heal. */
  function sendThrough(send: () => void): void {
    const s = st();
    if (s.probed && s.healthy) {
      send();
      return;
    }
    // Unhealthy or never probed: re-probe at most once per reprobeMs. A probe
    // already in flight adopts this write (send on its success).
    if (s.probed && !s.probing && Date.now() - s.lastProbeAt < reprobeMs) return;
    void probe().then((ok) => {
      if (ok) send();
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
    writeThrough,
    deleteThrough,
    __reset: () => {
      const s = st();
      s.healthy = false;
      s.probed = false;
      s.lastProbeAt = 0;
      s.probing = null;
    },
  };
}
