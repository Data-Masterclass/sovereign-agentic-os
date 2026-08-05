/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { osMirror } from '@/lib/infra/os-mirror';
import { trace } from '@/lib/infra/agent-governed';
import { getConnectionForUser } from '@/lib/connections/store';

/**
 * EXPOSURE SETS (lakehouse-import-exposure.md) — the platform-admin decision that says
 * "these tables from this warehouse connection are visible to these domains". An
 * exposure is the SECURITY gate that opens a live-registered external catalog (which,
 * without one, the new fail-closed rego floor + compiler withhold from everyone): the
 * policy compiler turns each non-revoked exposure into a `data.governance.tables` entry
 * keyed on the external FQN, shared with exactly the listed domains.
 *
 * Admin-only (roleAtLeast 'admin') — exposure is a Company-tier act. Persisted via the
 * SAME registry-mirror pattern the connections store uses (`os-exposures`): an
 * authoritative in-process Map + best-effort OpenSearch write-through, durable across a
 * pod roll. Every mutation is audit-traced through the connection's principal, following
 * the store's `trace()` conventions (`exposure_set_created/updated/revoked`).
 */

export type ExposureMode = 'live' | 'sync';
export type ExposureTier = 'silver' | 'gold';

export type ExposureTableRef = { schema: string; table: string };

/** Sync scheduling defaults, carried only when mode='sync' (Phase 3 consumes them). */
export type ExposureSyncDefaults = {
  schedule?: string;
  fullRefresh?: boolean;
};

export type ExposureSet = {
  id: string;
  connectionId: string;
  name: string;
  /** Domains this exposure grants the listed tables to. */
  domains: string[];
  mode: ExposureMode;
  tier: ExposureTier;
  tables: ExposureTableRef[];
  syncDefaults?: ExposureSyncDefaults;
  note?: string;
  revoked?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

const mirror = osMirror({ index: 'os-exposures' });

type ExpCacheState = { cache: Map<string, ExposureSet> | null };
const EXP_STATE_KEY = Symbol.for('soa.exposures.cache');
function expState(): ExpCacheState {
  const g = globalThis as unknown as Record<symbol, ExpCacheState | undefined>;
  if (!g[EXP_STATE_KEY]) g[EXP_STATE_KEY] = { cache: null };
  return g[EXP_STATE_KEY]!;
}

async function getCache(): Promise<Map<string, ExposureSet>> {
  const s = expState();
  if (s.cache) return s.cache;
  const map = new Map<string, ExposureSet>();
  const docs = await mirror.hydrate(500);
  for (const e of (docs ?? []) as ExposureSet[]) map.set(e.id, e);
  s.cache = map;
  return map;
}

function writeThrough(e: ExposureSet): void {
  mirror.writeThrough(e.id, e);
}

/** Admin-only gate for every mutating exposure operation (fail-closed). */
function assertAdmin(user: CurrentUser): void {
  if (!roleAtLeast(user.role, 'admin')) {
    throw withStatus(new Error('Managing exposure sets requires an Administrator'), 403);
  }
}

function sanitizeTables(tables: unknown): ExposureTableRef[] {
  if (!Array.isArray(tables)) return [];
  const out: ExposureTableRef[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const schema = String((t as ExposureTableRef)?.schema ?? '').trim();
    const table = String((t as ExposureTableRef)?.table ?? '').trim();
    if (!schema || !table) continue;
    const k = `${schema}.${table}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ schema, table });
  }
  return out;
}

function sanitizeDomains(domains: unknown): string[] {
  if (!Array.isArray(domains)) return [];
  return [...new Set(domains.map((d) => String(d).trim()).filter(Boolean))];
}

// -------------------------------------------------------------------- reads ---

/** Every exposure for a connection (including revoked, for the admin list). The caller
 *  must be able to SEE the connection; listing is otherwise unrestricted read. */
export async function listExposureSets(connId: string, user: CurrentUser): Promise<ExposureSet[]> {
  await getConnectionForUser(connId, user); // 404s if not visible
  const map = await getCache();
  return [...map.values()]
    .filter((e) => e.connectionId === connId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** ALL non-revoked exposures across every connection — the compiler's source. Not
 *  user-scoped: the compiler runs server-side over the whole registry, exactly like
 *  the dataset governance compile. */
export async function allActiveExposures(): Promise<ExposureSet[]> {
  const map = await getCache();
  return [...map.values()].filter((e) => !e.revoked);
}

// ------------------------------------------------------------------ mutate ---

export type ExposureInput = {
  name: string;
  domains: string[];
  mode?: ExposureMode;
  tier?: ExposureTier;
  tables: ExposureTableRef[];
  syncDefaults?: ExposureSyncDefaults;
  note?: string;
};

export async function createExposureSet(connId: string, user: CurrentUser, input: ExposureInput): Promise<ExposureSet> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const name = (input.name ?? '').trim();
  if (!name) throw withStatus(new Error('An exposure set needs a name'), 400);
  const tables = sanitizeTables(input.tables);
  if (tables.length === 0) throw withStatus(new Error('Select at least one table to expose'), 400);
  const domains = sanitizeDomains(input.domains);
  if (domains.length === 0) throw withStatus(new Error('Select at least one domain to expose to'), 400);
  const mode: ExposureMode = input.mode === 'sync' ? 'sync' : 'live';
  const t = now();
  const e: ExposureSet = {
    id: id('exp'),
    connectionId: connId,
    name,
    domains,
    mode,
    tier: input.tier === 'gold' ? 'gold' : 'silver',
    tables,
    ...(mode === 'sync' && input.syncDefaults ? { syncDefaults: input.syncDefaults } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    createdBy: user.id,
    createdAt: t,
    updatedAt: t,
  };
  const map = await getCache();
  map.set(e.id, e);
  writeThrough(e);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'exposure_set_created', by: user.id, connectionId: connId, name, domains, mode: e.mode, tier: e.tier, tables: tables.length },
    output: { exposureId: e.id },
    decision: 'allow',
  });
  return e;
}

export async function updateExposureSet(
  exposureId: string,
  user: CurrentUser,
  input: Partial<ExposureInput>,
): Promise<ExposureSet> {
  assertAdmin(user);
  const map = await getCache();
  const e = map.get(exposureId);
  if (!e) throw withStatus(new Error('Exposure set not found'), 404);
  const c = await getConnectionForUser(e.connectionId, user); // re-check visibility

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw withStatus(new Error('An exposure set needs a name'), 400);
    e.name = name;
  }
  if (input.domains !== undefined) {
    const domains = sanitizeDomains(input.domains);
    if (domains.length === 0) throw withStatus(new Error('Select at least one domain to expose to'), 400);
    e.domains = domains;
  }
  if (input.tables !== undefined) {
    const tables = sanitizeTables(input.tables);
    if (tables.length === 0) throw withStatus(new Error('Select at least one table to expose'), 400);
    e.tables = tables;
  }
  if (input.mode !== undefined) e.mode = input.mode === 'sync' ? 'sync' : 'live';
  if (input.tier !== undefined) e.tier = input.tier === 'gold' ? 'gold' : 'silver';
  if (input.note !== undefined) e.note = input.note.trim() || undefined;
  if (input.syncDefaults !== undefined) e.syncDefaults = input.syncDefaults;
  // syncDefaults only make sense in sync mode — dropping to live clears them (so a mode
  // switch alone, with no explicit syncDefaults, still cleans up honestly).
  if (e.mode === 'live') e.syncDefaults = undefined;

  e.updatedAt = now();
  map.set(e.id, e);
  writeThrough(e);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'exposure_set_updated', by: user.id, exposureId, domains: e.domains, mode: e.mode, tier: e.tier, tables: e.tables.length },
    output: { exposureId: e.id },
    decision: 'allow',
  });
  return e;
}

/** REVOKE (soft): flips `revoked`, so the compiler withdraws its OPA entries on the next
 *  recompile (live reads → zero rows). The record is kept for audit, never deleted. */
export async function revokeExposureSet(exposureId: string, user: CurrentUser): Promise<ExposureSet> {
  assertAdmin(user);
  const map = await getCache();
  const e = map.get(exposureId);
  if (!e) throw withStatus(new Error('Exposure set not found'), 404);
  const c = await getConnectionForUser(e.connectionId, user);
  e.revoked = true;
  e.updatedAt = now();
  map.set(e.id, e);
  writeThrough(e);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'exposure_set_revoked', by: user.id, exposureId },
    output: { exposureId: e.id, revoked: true },
    decision: 'allow',
  });
  return e;
}

/** Test seam — forget the in-process cache. */
export function __resetExposures(): void {
  expState().cache = null;
  mirror.__reset();
}
