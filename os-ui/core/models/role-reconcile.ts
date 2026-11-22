/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The OS enforces its role mapping at LiteLLM and repairs a foreign edit — and reports it.
 * USER STORY: As a platform admin I remap a role in Platform → Models and the next call, from any
 *             caller, uses the new model with no restart. If someone edits the alias in LiteLLM
 *             directly, the OS puts it back and shows that it did. A catalog model removed under a
 *             role is a red warning, never a silent fallback.
 * ARCHITECTURE:
 *   - The mapping is `os/models.yml` (`role-store.ts`). The gateway side is `router_settings.model_group_alias`,
 *     written with LiteLLM's own `POST /config/update` and read back from `GET /router/settings`
 *     (`role-live.ts`). LiteLLM applies the change at once, keeps it in its database, and refuses to
 *     change an alias that is set in its config FILE — which is why the chart must not set one.
 *   - RECONCILE (boot, then on a timer; `scheduleRoleReconcile`): for every role whose model is in the
 *     catalog, make the gateway's alias equal the mapping (and the deprecated names equal their role's
 *     model). An alias that was ABSENT is created (not drift); one that points elsewhere is repaired AND
 *     reported (`drift`, audited as `gateway.models.reconcile`). Aliases the OS does not own are left alone.
 *   - NO SILENT FALLBACK: a role whose model is no longer in the catalog is `missing`; its alias is NOT
 *     touched (a call fails with LiteLLM's own typed "no healthy deployments" error) and the report is
 *     `blocked`. No mapping yet = `unmapped`: the OS invents no model names and writes nothing.
 *   - An unreadable gateway or catalog is `unreadable` ("could not check"), never "in sync".
 *   - Injected IO so the logic is unit-testable; the real gateway and a real git repository are
 *     proven in `tabs/admin/lib/model-roles.e2e.test.ts`.
 */
import { scheduleEvery } from '@core/reconcile/runtime';
import { ROLE_NAMES, ModelMappingError, asRoleMapping, desiredAliases, diffAliases, validateMapping, type AliasDiff, type RoleMapping, type RoleName } from '@core/models/role-mapping';

type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

export type RoleReconcileIo = {
  /** `os/models.yml` from the platform repository; null = no file yet. Throws a typed error if it does not parse. */
  readMapping: () => Promise<RoleMapping | null>;
  /** Commit the file as `by`. */
  writeMapping: (mapping: RoleMapping, by: string) => Promise<{ sha: string; changed: boolean }>;
  /** The names of the models LiteLLM serves now. */
  catalog: () => Promise<Fetched<string[]>>;
  /** LiteLLM's `router_settings.model_group_alias`. */
  readAliases: () => Promise<Fetched<Record<string, string>>>;
  /** Set the WHOLE alias map (the caller merges in the aliases it does not own). */
  writeAliases: (aliases: Record<string, string>) => Promise<Fetched<unknown>>;
  audit?: (entry: { actor: string; action: 'gateway.models.reconcile'; subject: string; domain: string; reason: string; detail?: Record<string, unknown> }) => unknown;
  log?: (line: string) => void;
  now?: () => number;
};

export type RoleReportState = 'unmapped' | 'in-sync' | 'applied' | 'repaired' | 'blocked' | 'unreadable';

export type RoleReport = {
  at: number;
  /** false = the pass could not look or could not write: "could not check", never "in sync". */
  ok: boolean;
  state: RoleReportState;
  mapping: RoleMapping | null;
  roles: { role: RoleName; model: string; inCatalog: boolean }[];
  /** Roles whose catalog model is gone. Their aliases are NOT changed. */
  missing: { role: RoleName; model: string }[];
  /** Aliases someone else changed in LiteLLM that the OS put back. */
  drift: AliasDiff[];
  error?: string;
};

type Slot = { last?: RoleReport };
const g = globalThis as unknown as { __osRoleReport?: Slot };
const slot = (): Slot => (g.__osRoleReport ??= {});
export const lastRoleReport = (): RoleReport | null => slot().last ?? null;

/** Whether an admin has mapped the roles (so the deprecated names are now in force). */
export const roleMappingActive = (): boolean => slot().last?.mapping != null;

export async function reconcileRoleMapping(io: RoleReconcileIo): Promise<RoleReport> {
  const at = (io.now ?? Date.now)();
  const log = io.log ?? ((l: string) => console.info(`[role-reconcile] ${l}`));
  const done = (r: Omit<RoleReport, 'at'>): RoleReport => {
    const full = { at, ...r };
    slot().last = full;
    return full;
  };
  const bad = (error: string, mapping: RoleMapping | null = null): RoleReport => {
    log(`could not reconcile: ${error}`);
    return done({ ok: false, state: 'unreadable', mapping, roles: [], missing: [], drift: [], error });
  };

  let mapping: RoleMapping | null;
  try {
    mapping = await io.readMapping();
  } catch (e) {
    return bad(`os/models.yml: ${(e as Error).message}`);
  }
  if (!mapping) return done({ ok: true, state: 'unmapped', mapping: null, roles: [], missing: [], drift: [] });

  const cat = await io.catalog();
  if (!cat.ok) return bad(`LiteLLM catalog: ${cat.error}`, mapping);
  const catalog = new Set(cat.data);
  const roles = ROLE_NAMES.map((role) => ({ role, model: mapping![role], inCatalog: catalog.has(mapping![role]) }));
  const missing = roles.filter((r) => !r.inCatalog).map(({ role, model }) => ({ role, model }));

  // Only roles whose model exists are enforced; a missing one is left exactly as it is.
  const live = ROLE_NAMES.filter((r) => catalog.has(mapping![r]));
  const want = desiredAliases(mapping, catalog, live);

  const have = await io.readAliases();
  if (!have.ok) return bad(`LiteLLM router settings: ${have.error}`, mapping);
  const diff = diffAliases(have.data, want);
  const drift = diff.filter((d) => d.have !== undefined);
  let state: RoleReportState = missing.length > 0 ? 'blocked' : 'in-sync';
  if (diff.length > 0) {
    const wrote = await io.writeAliases({ ...have.data, ...want });
    if (!wrote.ok) return bad(`LiteLLM refused the alias update: ${wrote.error}`, mapping);
    if (missing.length === 0) state = drift.length > 0 ? 'repaired' : 'applied';
    if (drift.length > 0) {
      log(`repaired ${drift.map((d) => `${d.alias} (${d.have} → ${d.want})`).join(', ')}`);
      io.audit?.({
        actor: 'system:os-ui',
        action: 'gateway.models.reconcile',
        subject: 'router_settings.model_group_alias',
        domain: 'platform',
        reason: `someone changed the model alias in LiteLLM; the OS put it back to its role mapping (${drift.map((d) => `${d.alias}: ${d.have} → ${d.want}`).join('; ')})`,
        detail: { drift },
      });
    }
  }
  if (missing.length > 0) log(`WARNING: ${missing.map((m) => `${m.role} → ${m.model}`).join(', ')} is not in the LiteLLM catalog; its alias was not changed`);
  return done({ ok: true, state, mapping, roles, missing, drift });
}

/**
 * An admin's mapping: validated against the catalog first (a typed refusal changes nothing), committed
 * as `os/models.yml`, then enforced at the gateway at once.
 */
export async function applyRoleMapping(io: RoleReconcileIo, requested: unknown, by: string): Promise<RoleReport> {
  const mapping = asRoleMapping(requested);
  const cat = await io.catalog();
  if (!cat.ok) throw Object.assign(new Error(`LiteLLM could not be read (${cat.error}), so the mapping was not changed`), { status: 502 });
  validateMapping(mapping, cat.data);
  await io.writeMapping(mapping, by);
  return reconcileRoleMapping(io);
}

/** At boot of os-ui web: reconcile once, then on a timer. Never throws into boot. */
export function scheduleRoleReconcile(io: () => RoleReconcileIo, intervalSeconds: number): (() => void) | null {
  const g2 = globalThis as unknown as { __osRoleReconcileBooted?: boolean };
  if (g2.__osRoleReconcileBooted || intervalSeconds <= 0) return null;
  g2.__osRoleReconcileBooted = true;
  void reconcileRoleMapping(io()).catch((e) => console.error(`[role-reconcile] first pass failed: ${(e as Error).message}`));
  return scheduleEvery('model-role-reconcile', intervalSeconds * 1000, () => reconcileRoleMapping(io()));
}

export { ModelMappingError };
