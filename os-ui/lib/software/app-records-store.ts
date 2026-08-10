/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { osMirror } from '@/lib/infra/os-mirror';

/**
 * The OS-side APP-RECORDS store — durable persistence for an app's OWN write data
 * (`os.records.*`: list/get/add/export). An OS-built app's internal writes must NOT
 * create OS datasets (the governed data plane is read-only and the app identity lacks
 * those perms); the write door is `os.records.*`. The DEFAULT app template is a static
 * Vite+React SPA on nginx with NO backend, so without this store its records never
 * persist. This backs those record tools with a real OS-side store.
 *
 * Persistence: best-effort OpenSearch ("os-app-records" index) as the durable mirror,
 * with an authoritative in-process cache. On first use we hydrate the cache from
 * OpenSearch if reachable; every write writes through (fire-and-forget) so a real
 * deployment is durable, while local/dev keeps everything in memory. Mirrors the exact
 * discipline of lib/core/artifacts.ts + lib/infra/os-mirror.ts — no new infra.
 *
 * Scoping (the security boundary regardless of backing store): every query is scoped
 * by `appSlug` (app A's records are NEVER visible under app B), then filtered to the
 * caller's view — My (owner === actor.id) PLUS Domain (domain === actor.domain) — the
 * same My/Domain rule the sovereign-app scaffold applies client-side.
 */

/** One persisted app record. `record` is the app's own opaque payload. */
export type AppRecord = {
  id: string;
  appSlug: string;
  owner: string;
  domain: string;
  record: Record<string, unknown>;
  createdAt: string;
};

/** The caller identity a record query is scoped to. */
export type RecordActor = { id: string; domain: string };

type AppRecordsCacheState = { cache: Map<string, AppRecord> | null };
const APP_RECORDS_STATE_KEY = Symbol.for('soa.app-records.cache');
function appRecordsCacheState(): AppRecordsCacheState {
  const g = globalThis as unknown as Record<symbol, AppRecordsCacheState | undefined>;
  if (!g[APP_RECORDS_STATE_KEY]) g[APP_RECORDS_STATE_KEY] = { cache: null };
  return g[APP_RECORDS_STATE_KEY]!;
}

// ---------------------------------------------------------------- OpenSearch --
// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/infra/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({
  index: config.appRecordsIndex,
  createBody: {
    mappings: {
      properties: {
        appSlug: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        createdAt: { type: 'date' },
      },
    },
  },
});

function writeThrough(r: AppRecord): void {
  // Fire-and-forget durable mirror; never block the request on it.
  mirror.writeThrough(r.id, r);
}

async function getCache(): Promise<Map<string, AppRecord>> {
  const s = appRecordsCacheState();
  if (s.cache) return s.cache;
  const map = new Map<string, AppRecord>();
  // Try to hydrate from OpenSearch; an unreachable mirror keeps us in-memory only.
  const docs = await mirror.hydrate(1000);
  if (docs !== null) {
    for (const r of docs as AppRecord[]) map.set(r.id, r);
  }
  s.cache = map;
  return map;
}

// ------------------------------------------------------------- Scoping rules --

/**
 * Records of this app VISIBLE to the actor: My (owner === actor.id) PLUS Domain
 * (domain === actor.domain). Every query is FIRST scoped to `appSlug`, so app A's
 * records are never returned under app B — the cross-app isolation invariant.
 */
function visibleTo(r: AppRecord, appSlug: string, actor: RecordActor): boolean {
  if (r.appSlug !== appSlug) return false;
  return r.owner === actor.id || (Boolean(actor.domain) && r.domain === actor.domain);
}

// ------------------------------------------------------------------ Mutations --

/** Persist a new record for `appSlug`, stamped with its owner + owning domain. */
export async function addAppRecord(input: {
  appSlug: string;
  owner: string;
  domain: string;
  record: Record<string, unknown>;
}): Promise<AppRecord> {
  const map = await getCache();
  const r: AppRecord = {
    id: crypto.randomUUID(),
    appSlug: input.appSlug,
    owner: input.owner,
    domain: input.domain,
    record: input.record ?? {},
    createdAt: new Date().toISOString(),
  };
  map.set(r.id, r);
  writeThrough(r);
  return r;
}

// -------------------------------------------------------------------- Reads --

/** This app's records visible to the actor (My + Domain), newest first. */
export async function listAppRecords(input: {
  appSlug: string;
  actor: RecordActor;
}): Promise<AppRecord[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((r) => visibleTo(r, input.appSlug, input.actor))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

/** One of this app's records by id, if visible to the actor; else null. */
export async function getAppRecord(input: {
  appSlug: string;
  id: string;
  actor: RecordActor;
}): Promise<AppRecord | null> {
  const map = await getCache();
  const r = map.get(input.id);
  if (!r || !visibleTo(r, input.appSlug, input.actor)) return null;
  return r;
}

/** The visible set for export — same scope as {@link listAppRecords}. */
export async function exportAppRecords(input: {
  appSlug: string;
  actor: RecordActor;
}): Promise<AppRecord[]> {
  return listAppRecords(input);
}

export function __resetAppRecordsCache(): void {
  const s = appRecordsCacheState();
  s.cache = null;
  mirror.__reset();
}
