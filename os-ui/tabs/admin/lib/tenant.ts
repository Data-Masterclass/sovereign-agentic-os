/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Tenant context + multi-tenant isolation for Platform Admin.
 *
 * The OS deploys one tenant per cluster (config.deploymentTenant), with many
 * DOMAINS inside it. Platform Admin is tenant-scoped: a tenant admin may only
 * ever read/write THEIR tenant — `assertTenantAccess` is the hard isolation gate
 * every adapter routes through, so one tenant's admin can never see another's
 * structure even if an id is guessed. This mirrors the RLS guarantee the app
 * tier (Supabase) enforces in a real deploy; here it is enforced in-process so
 * the invariant holds offline too.
 *
 * DURABILITY: the tenant record (envelope, premium cap, plan, residency, locale,
 * name) is written THROUGH to the OpenSearch mirror (`os-tenant-config`) and
 * hydrated on boot — without this a pod roll reverted an admin's budget/plan edits
 * to the seed while the audit row claimed they persisted. One doc, keyed by the
 * tenant id. FAIL-SOFT: an unreachable mirror keeps the in-process seed.
 *
 * Server-only by convention (imported only by API routes); kept free of the
 * `server-only` + `@/` imports so the pure logic stays unit-testable under
 * `node --test`.
 */
import { config } from '@core/kernel/config';
import { osMirror } from '@core/infra/os-mirror';

export type Residency = 'eu-germany-west-central' | 'eu' | 'other';
export type Plan = 'sovereign-self-hosted' | 'stackit-managed' | 'stackit-premium';

export type Tenant = {
  id: string;
  name: string;
  residency: Residency;
  plan: Plan;
  /** Monthly spend envelope in EUR (the tenant budget; Governance allocates within it). */
  envelopeEUR: number;
  /** Hard ceiling on the STACKIT premium-model route in EUR/mo. */
  premiumCapEUR: number;
  /** Localization default (EN first; DE for the Data Masterclass audience). */
  locale: 'en' | 'de';
  createdAt: string;
};

function seed(): Tenant {
  return {
    id: config.deploymentTenant,
    name: 'Data Masterclass',
    residency: 'eu-germany-west-central',
    plan: 'sovereign-self-hosted',
    envelopeEUR: 2000,
    premiumCapEUR: 400,
    locale: 'en',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

type TenantState = { tenants: Map<string, Tenant>; hydration: Promise<void> | null };
const TENANT_KEY = Symbol.for('soa.platform.tenants');
function tenantState(): TenantState {
  const g = globalThis as unknown as Record<symbol, TenantState | undefined>;
  if (!g[TENANT_KEY]) g[TENANT_KEY] = { tenants: new Map([[config.deploymentTenant, seed()]]), hydration: null };
  return g[TENANT_KEY]!;
}

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/infra/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: 'os-tenant-config' });

/** Hydrate the tenant record once from the mirror (best-effort). A stored doc for
 *  THIS tenant overwrites the seed; anything absent/unreachable keeps the seed. */
export async function ensureHydrated(): Promise<void> {
  const s = tenantState();
  if (!s.hydration) s.hydration = hydrateTenant();
  return s.hydration;
}

async function hydrateTenant(): Promise<void> {
  const own = config.deploymentTenant;
  const doc = (await mirror.getDoc(own)) as Partial<Tenant> | null;
  if (doc && typeof doc === 'object' && doc.id === own) {
    const s = tenantState();
    // Merge over the seed so a stored doc from before a field existed keeps its seed
    // default (nil-safe) rather than becoming undefined.
    s.tenants.set(own, { ...seed(), ...doc, id: own });
  }
}

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/** The single tenant this cluster serves. */
export function currentTenantId(): string {
  return config.deploymentTenant;
}

/**
 * Multi-tenant isolation gate. A request may only touch the tenant it is scoped
 * to; any other id is a 403 (never a 404 — we don't even confirm existence of
 * another tenant). Call this at the top of every tenant-scoped adapter action.
 */
export function assertTenantAccess(tenantId: string): Tenant {
  const own = currentTenantId();
  if (tenantId !== own) throw fail('Cross-tenant access denied', 403);
  const t = tenantState().tenants.get(own);
  if (!t) throw fail('Tenant not found', 404);
  return t;
}

export function getTenant(): Tenant {
  return assertTenantAccess(currentTenantId());
}

export function updateTenant(patch: Partial<Omit<Tenant, 'id' | 'createdAt'>>): Tenant {
  const t = getTenant();
  const next: Tenant = {
    ...t,
    ...patch,
    id: t.id,
    createdAt: t.createdAt,
  };
  tenantState().tenants.set(t.id, next);
  mirror.writeThrough(next.id, next);
  return next;
}

export function _reset(): void {
  const s = tenantState();
  s.tenants = new Map([[config.deploymentTenant, seed()]]);
  s.hydration = null;
  mirror.__reset();
}
