/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { SalesforceSliceArgs } from './salesforce.ts';
import type { KajabiSliceArgs } from './kajabi.ts';
import type { ODataSliceArgs } from './odata/sync.ts';
import type { WorkdaySliceArgs } from './workday-raas.ts';
import type { ConnectionTemplateKey } from './schema.ts';
import { operationalPlatformFor, type OperationalPlatform } from './operational-platform.ts';
import { cursorSupportForPlatform, type EntityCursorSupport } from './operational-cursor.ts';

export type { OperationalPlatform } from './operational-platform.ts';
export type { EntityCursorSupport } from './operational-cursor.ts';
export { isOperationalTemplate, operationalTemplates } from './operational-platform.ts';

/**
 * OPERATIONAL-CONNECTION REGISTRY — the ONE place that knows how each API-batch
 * operational template (Salesforce, Kajabi, later SAP/Workday) pulls a sync slice,
 * discovers its entities, and — honestly — which incremental cursor each entity
 * supports (operational-system-connections.md, Phase 0). It registry-izes the two
 * hardcoded seams the design calls out:
 *
 *   1. `liveApiPlatform` — the `'salesforce'|'kajabi'` switch in `sync-run-server.ts`
 *      that decides which slice runner an api-batch sync dispatches to.
 *   2. `buildCatalogSnapshot` — the warehouse-only `discoverWarehouse` call in
 *      `catalog-snapshot.ts`, now dispatched per template so an operational connection
 *      gets a real entity catalog through the SAME snapshot machinery.
 *
 * Pattern: the `CONNECTION_EXECUTORS` map in `store.ts` and `warehouse/registry.ts` —
 * each connector registers its dispatch on a disjoint branch instead of a growing
 * ternary. The slice runners are imported LAZILY (they sit at the top of heavy
 * server module graphs) so the pure executor tests and client bundles never drag them
 * in — exactly the discipline `sync-run-server.ts`'s `liveSalesforceSlice`/
 * `liveKajabiSlice` already follow.
 *
 * CURSOR HONESTY (non-negotiable, `kajabi-resources.ts` precedent): each entry knows
 * which cursor kinds an entity honestly supports. Nothing here is guessed — Salesforce
 * derives from the real SystemModstamp replication cursor, Kajabi from the curated
 * `kajabi-resources.ts` map. The UI's cursor-honesty chip reads this, never invents it.
 */

/** The discovery result shape shared with the warehouse discover path — the catalog
 *  snapshot's build loop treats every source identically. */
export type OperationalDiscovery = {
  ok: boolean;
  schemas: string[];
  tables: string[];
  schema: string | null;
  detail: string;
};

/**
 * One operational template's registry entry. `platform` is the slice-runner dispatch
 * key (the `liveApiPlatform` answer). `discover` builds the entity catalog. `cursorFor`
 * answers cursor honesty per entity. `pullSlice` is the per-platform slice puller — the
 * existing `runSalesforceSlice`/`runKajabiSlice`, imported lazily and adapted to a
 * uniform `(args) => Promise<SliceResult>` signature so the executor never branches on
 * platform beyond building the platform-specific arg (object vs resource).
 */
export type OperationalRegistryEntry = {
  template: ConnectionTemplateKey;
  platform: OperationalPlatform;
  /** Discover the entities (SObjects / Kajabi resources) as {schemas, tables}, the same
   *  shape a warehouse discover returns, so the snapshot build loop is source-agnostic. */
  discover: (connId: string, user: CurrentUser) => Promise<OperationalDiscovery>;
  /** The honest cursor support for one entity name (case-insensitive where the source is). */
  cursorFor: (entity: string) => EntityCursorSupport;
};

// Cursor honesty lives in the PURE, client-safe `operational-cursor.ts` (shared with the
// UI so server and client can never drift). Each entry below just binds its platform.

// ---- lazy slice-runner bridges (heavy server graphs; never in the pure tests) --

async function salesforceSlice(
  args: SalesforceSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runSalesforceSlice } = await import('./salesforce.ts');
  return runSalesforceSlice(args);
}

async function kajabiSlice(
  args: KajabiSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runKajabiSlice } = await import('./kajabi.ts');
  return runKajabiSlice(args);
}

async function odataSlice(
  args: ODataSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runODataSlice } = await import('./odata/sync.ts');
  return runODataSlice(args);
}

async function workdaySlice(
  args: WorkdaySliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runWorkdaySlice } = await import('./workday-raas.ts');
  return runWorkdaySlice(args);
}

async function salesforceDiscover(connId: string, user: CurrentUser): Promise<OperationalDiscovery> {
  const { discoverSalesforceObjects } = await import('./salesforce.ts');
  return discoverSalesforceObjects(connId, user);
}

async function kajabiDiscover(connId: string, user: CurrentUser): Promise<OperationalDiscovery> {
  const { discoverKajabiResources } = await import('./kajabi.ts');
  return discoverKajabiResources(connId, user);
}

async function odataDiscover(connId: string, user: CurrentUser): Promise<OperationalDiscovery> {
  const { discoverODataEntities } = await import('./odata/client.ts');
  return discoverODataEntities(connId, user);
}

async function workdayDiscover(connId: string, user: CurrentUser): Promise<OperationalDiscovery> {
  const { discoverWorkdayReports } = await import('./workday-raas.ts');
  return discoverWorkdayReports(connId, user);
}

// ---- the registry -------------------------------------------------------------

const OPERATIONAL_REGISTRY: Partial<Record<ConnectionTemplateKey, OperationalRegistryEntry>> = {
  'salesforce-api': {
    template: 'salesforce-api',
    platform: 'salesforce',
    discover: salesforceDiscover,
    cursorFor: (entity) => cursorSupportForPlatform('salesforce', entity),
  },
  'kajabi-api': {
    template: 'kajabi-api',
    platform: 'kajabi',
    discover: kajabiDiscover,
    cursorFor: (entity) => cursorSupportForPlatform('kajabi', entity),
  },
  // SAP S/4HANA Cloud (branded) + generic OData V4 share ONE generic OData core
  // (lib/connections/odata/). Cursor honesty is per-entity from $metadata detection at
  // sync time; the client-level chip is the safe full-refresh default (never guessed).
  'sap-odata': {
    template: 'sap-odata',
    platform: 'odata',
    discover: odataDiscover,
    cursorFor: (entity) => cursorSupportForPlatform('odata', entity),
  },
  'odata-v4': {
    template: 'odata-v4',
    platform: 'odata',
    discover: odataDiscover,
    cursorFor: (entity) => cursorSupportForPlatform('odata', entity),
  },
  // Workday RaaS — configured custom reports ARE the entities (report-as-entity);
  // full-refresh by default, incremental only when the admin set a date prompt.
  'workday-raas': {
    template: 'workday-raas',
    platform: 'workday',
    discover: workdayDiscover,
    cursorFor: (entity) => cursorSupportForPlatform('workday', entity),
  },
};

/** The registry entry for a template, or undefined when it is not an operational
 *  api-batch source (warehouse / files / action-only connectors). */
export function operationalEntry(template: ConnectionTemplateKey): OperationalRegistryEntry | undefined {
  return OPERATIONAL_REGISTRY[template];
}

/**
 * The api-batch PLATFORM a non-catalog operational connection dispatches to — the
 * registry-ized `liveApiPlatform`. Falls back to 'salesforce' for an unknown template
 * so the Salesforce slice runner re-resolves and throws the honest "not an available
 * sync source" error (byte-identical to the prior switch's default), never a silent
 * success.
 */
export function platformForTemplate(template: ConnectionTemplateKey): OperationalPlatform {
  return operationalPlatformFor(template) ?? 'salesforce';
}

/**
 * Dispatch a sync slice to the right platform runner. `common` is the platform-agnostic
 * arg bundle the executor built; `entity` is `sync.source.table` (SObject / Kajabi
 * resource). Byte-identical to the executor's prior inline `platform === 'kajabi' ? … : …`,
 * now behind the registry so a new operational template appends here only.
 */
type SliceResult = { rowsAffected: number | null; batchId?: string; highWatermark: string | null };

export async function pullOperationalSlice(
  platform: OperationalPlatform,
  common: Omit<SalesforceSliceArgs, 'object'> &
    Omit<KajabiSliceArgs, 'resource'> &
    Omit<ODataSliceArgs, 'entitySet'> &
    Omit<WorkdaySliceArgs, 'report'>,
  entity: string,
  deps: {
    salesforceSlice?: (a: SalesforceSliceArgs) => Promise<SliceResult>;
    kajabiSlice?: (a: KajabiSliceArgs) => Promise<SliceResult>;
    odataSlice?: (a: ODataSliceArgs) => Promise<SliceResult>;
    workdaySlice?: (a: WorkdaySliceArgs) => Promise<SliceResult>;
  } = {},
): Promise<SliceResult> {
  switch (platform) {
    case 'kajabi':
      return (deps.kajabiSlice ?? kajabiSlice)({ ...(common as KajabiSliceArgs), resource: entity });
    case 'odata':
      return (deps.odataSlice ?? odataSlice)({ ...(common as ODataSliceArgs), entitySet: entity });
    case 'workday':
      return (deps.workdaySlice ?? workdaySlice)({ ...(common as WorkdaySliceArgs), report: entity });
    default:
      return (deps.salesforceSlice ?? salesforceSlice)({ ...(common as SalesforceSliceArgs), object: entity });
  }
}

/** Dispatch entity discovery for an operational template (the snapshot build seam). */
export async function discoverOperational(
  template: ConnectionTemplateKey,
  connId: string,
  user: CurrentUser,
): Promise<OperationalDiscovery> {
  const entry = OPERATIONAL_REGISTRY[template];
  if (!entry) {
    return { ok: false, schemas: [], tables: [], schema: null, detail: 'Not an operational connection.' };
  }
  return entry.discover(connId, user);
}

/** The honest cursor support for one entity of an operational template — the source of
 *  the cursor-honesty chip, the SyncPanel/adopt cursor lock, and the deferredReason. */
export function cursorSupportFor(template: ConnectionTemplateKey, entity: string): EntityCursorSupport | null {
  const entry = OPERATIONAL_REGISTRY[template];
  return entry ? entry.cursorFor(entity) : null;
}
