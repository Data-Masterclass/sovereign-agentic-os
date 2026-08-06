/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { osMirror } from '@/lib/infra/os-mirror';
import { trace } from '@/lib/infra/agent-governed';
import { getConnectionForUser } from '@/lib/connections/store';
import { isOperationalTemplate, templateHasActionTools } from '@/lib/connections/operational-platform';
import { config } from '@/lib/core/config';
import { enqueue } from '@/lib/governance/approvals';
import type { ConnectionTemplateKey } from '@/lib/connections/schema';

/**
 * Resolve the honest exposure MODE for a connection template. An OPERATIONAL source
 * (Salesforce / Kajabi) has no Trino catalog to federate a live read, so its exposure is
 * ALWAYS 'sync' — an explicit 'live' is refused with the honest reason
 * (operational-system-connections.md, Phase 2). A warehouse keeps its live/sync choice.
 */
function resolveExposureMode(template: ConnectionTemplateKey, requested: ExposureMode | undefined): ExposureMode {
  if (isOperationalTemplate(template)) {
    if (requested === 'live') {
      throw withStatus(new Error('Operational sources sync; there is no live mode.'), 400);
    }
    return 'sync';
  }
  return requested === 'sync' ? 'sync' : 'live';
}

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

/**
 * The optional AGENT-ACTION grant on an operational exposure (operational-system-
 * connections.md, Phase 3). Keyed per selected entity (the SObject / resource name,
 * lowercased for stable lookup), each flag opts that entity's read/search/create/
 * update action tool INTO the exposure. ABSENT = data-only (the safe default): the
 * exposure exposes rows to sync, no live action tools at all.
 *
 * TWO-LAYER WRITE APPROVAL: read/search compile immediately; create/update are the
 * REQUESTED write actions — they take effect only once an `exposure_action_enable`
 * approval clears (`writeApproved`), and BROADENING the requested writes re-triggers
 * that approval (`writeApproved` is cleared on a broadening edit). Deletes are never
 * an action here — `sf_delete_record` stays Blocked on the profile regardless.
 */
export type EntityActionGrant = { read?: boolean; search?: boolean; create?: boolean; update?: boolean };
export type ExposureActions = { [entityKey: string]: EntityActionGrant };

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
  /** Optional per-entity agent-action grant (Phase 3). Absent = data-only. */
  actions?: ExposureActions;
  /** True once an admin has approved this exposure's create/update actions
   *  (`exposure_action_enable`). Write scopes compile only when this is set; a
   *  broadening edit clears it (re-triggering approval). Read/search never need it. */
  writeApproved?: boolean;
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

/** The exposure entity KEY for an entity name — lowercased so lookups are stable across
 *  the case-insensitive SObject naming (`Account` ↔ `account`). */
export function entityActionKey(entity: string): string {
  return String(entity ?? '').trim().toLowerCase();
}

/** Sanitize a raw `actions` map: keep only known flags, drop entities with no true
 *  flag, key everything by {@link entityActionKey}. Returns undefined when empty
 *  (absent = data-only, the safe default). */
function sanitizeActions(actions: unknown): ExposureActions | undefined {
  if (!actions || typeof actions !== 'object') return undefined;
  const out: ExposureActions = {};
  for (const [rawKey, rawVal] of Object.entries(actions as Record<string, unknown>)) {
    const key = entityActionKey(rawKey);
    if (!key || !rawVal || typeof rawVal !== 'object') continue;
    const v = rawVal as Record<string, unknown>;
    const grant: EntityActionGrant = {};
    if (v.read) grant.read = true;
    if (v.search) grant.search = true;
    if (v.create) grant.create = true;
    if (v.update) grant.update = true;
    if (grant.read || grant.search || grant.create || grant.update) out[key] = grant;
  }
  return Object.keys(out).length ? out : undefined;
}

/** True when `next` requests a create/update NOT already present in `prev` — a
 *  BROADENING of the write surface, which must re-trigger the enable approval. */
export function actionsBroadenWrites(prev: ExposureActions | undefined, next: ExposureActions | undefined): boolean {
  for (const [key, grant] of Object.entries(next ?? {})) {
    const before = prev?.[key];
    if (grant.create && !before?.create) return true;
    if (grant.update && !before?.update) return true;
  }
  return false;
}

/** True when the actions map requests ANY create/update (i.e. a write enablement). */
export function actionsRequestWrites(actions: ExposureActions | undefined): boolean {
  return Object.values(actions ?? {}).some((g) => g.create || g.update);
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
  /** Per-entity agent-action grant (Phase 3). Ignored when the actions flag is off. */
  actions?: ExposureActions;
  note?: string;
};

/** Enqueue the admin `exposure_action_enable` approval when an exposure requests
 *  write actions. Idempotent-by-intent: the caller invokes this on a create/update
 *  that requests or broadens create/update. Tenant-scoped, admin approver. */
function enqueueActionEnable(e: ExposureSet, connName: string, requestedBy: string): void {
  const entities = Object.entries(e.actions ?? {})
    .filter(([, g]) => g.create || g.update)
    .map(([k, g]) => `${k}:${[g.create ? 'create' : '', g.update ? 'update' : ''].filter(Boolean).join('+')}`);
  enqueue({
    kind: 'exposure_action_enable',
    title: `Enable write actions: ${connName}`,
    detail: `Exposure “${e.name}” requests write actions (${entities.join(', ')}). Approving compiles the create/update tools; read/search are already live.`,
    agent: '',
    domain: e.domains[0] ?? '',
    requestedBy,
    tool: 'exposure_action_enable',
    payload: { exposureId: e.id, connectionId: e.connectionId, entities },
    approverRole: 'admin',
    scope: 'tenant',
    source: 'Connections',
  });
}

export async function createExposureSet(connId: string, user: CurrentUser, input: ExposureInput): Promise<ExposureSet> {
  assertAdmin(user);
  const c = await getConnectionForUser(connId, user);
  const name = (input.name ?? '').trim();
  if (!name) throw withStatus(new Error('An exposure set needs a name'), 400);
  const tables = sanitizeTables(input.tables);
  if (tables.length === 0) throw withStatus(new Error('Select at least one table to expose'), 400);
  const domains = sanitizeDomains(input.domains);
  if (domains.length === 0) throw withStatus(new Error('Select at least one domain to expose to'), 400);
  // OPERATIONAL sources sync — no Trino catalog exists to federate a live read. An
  // exposure of an operational connection is FORCED to 'sync'; an explicit 'live' is
  // refused honestly (operational-system-connections.md, Phase 2).
  const mode: ExposureMode = resolveExposureMode(c.template, input.mode);
  // Agent actions only exist for templates with a REGISTERED action-tool set (today:
  // salesforce-api), and only when the flag is on. Kajabi/SAP/Workday have no action
  // tools, so their exposures are data-only — never arm a nonexistent action surface (M9).
  const actions = config.operationalActionsEnabled && templateHasActionTools(c.template)
    ? sanitizeActions(input.actions)
    : undefined;
  const requestsWrites = actionsRequestWrites(actions);
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
    ...(actions ? { actions } : {}),
    // Write scopes stay compiled-out until an admin approves (two-layer, enable-time).
    ...(requestsWrites ? { writeApproved: false } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    createdBy: user.id,
    createdAt: t,
    updatedAt: t,
  };
  const map = await getCache();
  map.set(e.id, e);
  writeThrough(e);
  if (requestsWrites) enqueueActionEnable(e, c.name, user.id);
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
  if (input.mode !== undefined) e.mode = resolveExposureMode(c.template, input.mode);
  if (input.tier !== undefined) e.tier = input.tier === 'gold' ? 'gold' : 'silver';
  if (input.note !== undefined) e.note = input.note.trim() || undefined;
  if (input.syncDefaults !== undefined) e.syncDefaults = input.syncDefaults;

  // Agent actions (operational only, flag-gated). Recompute; a BROADENING of the
  // write surface clears `writeApproved` and re-triggers the enable approval (the
  // envelope discipline). Narrowing/read-only edits never re-approve.
  let broadened = false;
  if (input.actions !== undefined && config.operationalActionsEnabled && templateHasActionTools(c.template)) {
    const nextActions = sanitizeActions(input.actions);
    broadened = actionsBroadenWrites(e.actions, nextActions);
    e.actions = nextActions;
    if (!actionsRequestWrites(nextActions)) {
      e.writeApproved = undefined; // no writes requested ⇒ nothing to approve
    } else if (broadened) {
      e.writeApproved = false; // broadened write surface ⇒ re-approve
    }
    // A non-broadening edit that still requests writes keeps its prior writeApproved.
  }
  // syncDefaults only make sense in sync mode — dropping to live clears them (so a mode
  // switch alone, with no explicit syncDefaults, still cleans up honestly).
  if (e.mode === 'live') e.syncDefaults = undefined;

  e.updatedAt = now();
  map.set(e.id, e);
  writeThrough(e);
  if (broadened) enqueueActionEnable(e, c.name, user.id);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'exposure_set_updated', by: user.id, exposureId, domains: e.domains, mode: e.mode, tier: e.tier, tables: e.tables.length, actions: e.actions ? Object.keys(e.actions).length : 0 },
    output: { exposureId: e.id, writeApproved: e.writeApproved ?? null },
    decision: 'allow',
  });
  return e;
}

/**
 * APPLY an approved `exposure_action_enable` (the effect's applier): flip
 * `writeApproved` so the exposure's create/update action tools compile. Idempotent.
 * Admin-only (the approval kind is admin-gated; re-checked here, fail-closed).
 */
export async function approveExposureActions(
  exposureId: string,
  approver: CurrentUser,
): Promise<{ exposureId: string; connectionName: string }> {
  if (!roleAtLeast(approver.role, 'admin')) {
    throw withStatus(new Error('Enabling exposure write actions requires an Administrator'), 403);
  }
  const map = await getCache();
  const e = map.get(exposureId);
  if (!e) throw withStatus(new Error('Exposure set not found'), 404);
  const c = await getConnectionForUser(e.connectionId, approver);
  e.writeApproved = true;
  e.updatedAt = now();
  map.set(e.id, e);
  writeThrough(e);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'exposure_actions_enabled', by: approver.id, exposureId },
    output: { exposureId: e.id, writeApproved: true },
    decision: 'allow',
  });
  return { exposureId: e.id, connectionName: c.name };
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
