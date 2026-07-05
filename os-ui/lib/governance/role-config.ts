/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Role } from '../session.ts';
import { ROLES } from '../session.ts';
import { config } from '../config.ts';

/**
 * Role-permissions store — the ADMIN-EDITABLE source for "what each role may do,
 * per component / golden path." Today the answer is HARDCODED (roles.ts
 * `ROLE_RIGHTS` + the per-surface `minRole` gates); this module lifts that same
 * answer into a governed, editable matrix so a tenant Admin can adjust it as
 * needed (app/platform/roles), and the gates resolve THROUGH it.
 *
 * Shape: for each role, a set of capabilities per component. The matrix is the
 * human surface; `resolveRoleRights` COMPILES it back to the exact abstract
 * rights `roles.ts` already speaks, so nothing downstream changes shape. Seeded
 * (DEFAULT_MATRIX) so that on first load it reproduces the current model EXACTLY
 * — same OPA tools per role, same lockdown (a creator still cannot promote /
 * approve / reach admin).
 *
 * FAIL-SAFE, by construction:
 *  - Deny-by-default: a malformed / empty stored matrix falls back to the safe
 *    hardcoded DEFAULT_MATRIX (never an empty grant, never an escalation).
 *  - No silent escalation: creator/builder gain a higher capability ONLY when an
 *    Admin explicitly toggles it — the defaults grant none.
 *  - Never lock out admins: the admin role's platform-management capability
 *    (`manage @ platform` → the tenant-admin grant) cannot be removed.
 *
 * Pure + dependency-light (no `server-only`, like audit.ts): the compile logic
 * is unit-tested directly, and roles.ts can consume `resolveRoleRights`
 * synchronously without becoming server-only. The only side effect — the
 * best-effort OpenSearch mirror — is isolated and fails open, mirroring the rest
 * of the OS's live + offline pattern.
 */

// ---- The matrix vocabulary --------------------------------------------------

/** A component / golden path (a matrix row). */
export type Component =
  | 'data' | 'knowledge' | 'files' | 'agents' | 'software' | 'metrics'
  | 'dashboards' | 'bigbets' | 'connections' | 'marketplace' | 'governance' | 'platform';

/** A capability a role may hold on a component (a cell toggle). */
export type Capability = 'view' | 'create' | 'run' | 'request' | 'approve' | 'manage';

export const COMPONENTS: { id: Component; label: string; hint: string }[] = [
  { id: 'data', label: 'Data', hint: 'Governed datasets & marts' },
  { id: 'knowledge', label: 'Knowledge', hint: 'Retrieval workflows & docs' },
  { id: 'files', label: 'Files', hint: 'Unstructured objects' },
  { id: 'agents', label: 'Agents', hint: 'Agent systems' },
  { id: 'software', label: 'Software', hint: 'Apps: build → preview → deploy' },
  { id: 'metrics', label: 'Metrics', hint: 'Semantic metrics' },
  { id: 'dashboards', label: 'Dashboards', hint: 'Dashboards & boards' },
  { id: 'bigbets', label: 'Big Bets', hint: 'Cross-domain bets' },
  { id: 'connections', label: 'Connections', hint: 'External tools & egress' },
  { id: 'marketplace', label: 'Marketplace', hint: 'Shared / certified catalogue' },
  { id: 'governance', label: 'Governance', hint: 'Approvals, policy, memberships' },
  { id: 'platform', label: 'Platform', hint: 'Tenant control room' },
];

export const CAPABILITIES: { id: Capability; label: string; glyph: string; hint: string }[] = [
  { id: 'view', label: 'View', glyph: '👁', hint: 'See this surface & its shared assets' },
  { id: 'create', label: 'Create own', glyph: '✎', hint: 'Create & run own artifacts' },
  { id: 'run', label: 'Run', glyph: '▷', hint: 'Run attended work' },
  { id: 'request', label: 'Request', glyph: '↗', hint: 'Request access / import / promotion' },
  { id: 'approve', label: 'Approve / Promote', glyph: '✓', hint: 'Approve & promote to shared' },
  { id: 'manage', label: 'Manage', glyph: '⚙', hint: 'Manage members / policy / tenant' },
];

const COMPONENT_IDS = COMPONENTS.map((c) => c.id);
const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);
const WORK: Component[] = ['data', 'knowledge', 'files', 'agents', 'software', 'metrics', 'dashboards', 'bigbets', 'connections'];

export type RoleMatrix = Record<Role, Record<Component, Capability[]>>;

// ---- Cell → abstract rights (the compile) -----------------------------------

/**
 * The rights one (component, capability) cell grants. Role-independent: a role's
 * rights are the UNION over its ON cells. An empty result means the cell is NOT
 * applicable to that component (the UI renders it as "—", never a dead toggle).
 * This is the exact inverse of the hardcoded `ROLE_RIGHTS`, so the seeded matrix
 * compiles back to today's model with no drift.
 */
export function cellRights(component: Component, capability: Capability): string[] {
  switch (capability) {
    case 'view':
      if (component === 'governance') return ['policy.view.domain'];
      if (component === 'platform') return ['policy.view.tenant'];
      return ['read.own'];
    case 'create':
      return WORK.includes(component) ? ['create.artifact'] : [];
    case 'run':
      return WORK.includes(component) ? ['run.attended'] : [];
    case 'request':
      return WORK.includes(component) ? ['request.access', 'request.import'] : [];
    case 'approve':
      if (component === 'software') return ['deploy.review'];
      if (component === 'connections') return ['egress.approve'];
      if (component === 'governance') return ['approve.domain'];
      if (component === 'platform') return ['approve.tenant'];
      return ['promote.shared']; // work comps + marketplace: promote to Shared
    case 'manage':
      if (component === 'platform') return ['manage.users.tenant', 'cost.cap.set', 'override.policy'];
      if (component === 'governance') return ['manage.memberships.domain'];
      if (component === 'marketplace') return ['promote.certify'];
      return [];
    default:
      return [];
  }
}

/** Is a (component, capability) meaningful (grants ≥1 right)? Drives the UI. */
export function isApplicable(component: Component, capability: Capability): boolean {
  return cellRights(component, capability).length > 0;
}

/** Compile a role's ON cells into the deduped, sorted set of abstract rights. */
export function matrixToRights(matrix: RoleMatrix, role: Role): string[] {
  const rights = new Set<string>();
  const perComp = matrix[role] ?? {};
  for (const comp of COMPONENT_IDS) {
    for (const cap of perComp[comp] ?? []) {
      for (const r of cellRights(comp, cap)) rights.add(r);
    }
  }
  return [...rights].sort();
}

// ---- The seed (reproduces today's model EXACTLY) ----------------------------

function caps(...c: Capability[]): Capability[] {
  return c;
}

/** Every work component gets the same base creator cell-set. */
function workBase(extra: Capability[] = []): Record<Component, Capability[]> {
  const out = {} as Record<Component, Capability[]>;
  for (const c of COMPONENT_IDS) out[c] = [];
  for (const c of WORK) out[c] = caps('view', 'create', 'run', 'request', ...extra);
  return out;
}

function buildDefault(): RoleMatrix {
  // creator (base): view/create/run/request on the work surfaces only.
  const creator = workBase();

  // builder: creator + promote-to-shared on artifacts, deploy review on software,
  // and the domain-governance set (view/approve/manage memberships). No egress,
  // no tenant/platform powers.
  const builder = workBase();
  for (const c of ['data', 'knowledge', 'files', 'agents', 'software', 'metrics', 'dashboards', 'bigbets'] as Component[]) {
    builder[c] = caps('view', 'create', 'run', 'request', 'approve');
  }
  builder.marketplace = caps('view', 'approve');
  builder.governance = caps('view', 'approve', 'manage');

  // admin: full authority across every surface. `manage @ governance` is left OFF
  // by default (it is the domain-memberships grant a Builder owns) so the seeded
  // admin reproduces today's exact OPA tool-set; an Admin may toggle it on.
  const admin = {} as Record<Component, Capability[]>;
  for (const c of COMPONENT_IDS) {
    const applicable = CAPABILITY_IDS.filter((cap) => isApplicable(c, cap));
    admin[c] = applicable;
  }
  admin.governance = admin.governance.filter((cap) => cap !== 'manage');

  return { creator, builder, admin };
}

/** The safe, hardcoded default matrix — the fallback for deny-by-default. */
export const DEFAULT_MATRIX: RoleMatrix = buildDefault();

// ---- Validation + cloning ---------------------------------------------------

function cloneMatrix(m: RoleMatrix): RoleMatrix {
  const out = {} as RoleMatrix;
  for (const role of ROLES) {
    out[role] = {} as Record<Component, Capability[]>;
    for (const c of COMPONENT_IDS) {
      const list = (m[role]?.[c] ?? []).filter((cap): cap is Capability => CAPABILITY_IDS.includes(cap as Capability) && isApplicable(c, cap as Capability));
      out[role][c] = [...new Set(list)];
    }
  }
  return out;
}

/** Structurally valid AND non-lockout: admin keeps `manage @ platform`. */
export function isValidMatrix(m: unknown): m is RoleMatrix {
  if (!m || typeof m !== 'object') return false;
  const mm = m as Record<string, unknown>;
  for (const role of ROLES) {
    const perComp = mm[role];
    if (!perComp || typeof perComp !== 'object') return false;
    for (const c of COMPONENT_IDS) {
      const list = (perComp as Record<string, unknown>)[c];
      if (list !== undefined && !Array.isArray(list)) return false;
    }
  }
  // Never a config that locks every admin out of tenant management.
  if (!(mm.admin as Record<string, unknown>)) return false;
  const adminPlatform = ((mm.admin as Record<string, unknown>).platform as Capability[]) ?? [];
  if (!Array.isArray(adminPlatform) || !adminPlatform.includes('manage')) return false;
  return true;
}

// ---- The pinned cache + best-effort OpenSearch mirror -----------------------

type RoleConfigState = { matrix: RoleMatrix | null; loaded: boolean; osHealthy: boolean };
const STATE_KEY = Symbol.for('soa.governance.roleConfig');
function state(): RoleConfigState {
  const g = globalThis as unknown as Record<symbol, RoleConfigState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { matrix: null, loaded: false, osHealthy: false };
  return g[STATE_KEY]!;
}

const DOC = '/os-role-config/_doc/matrix';

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

function writeThrough(m: RoleMatrix): void {
  if (!state().osHealthy) return;
  void osFetch(`${DOC}?refresh=true`, { method: 'PUT', body: JSON.stringify({ id: 'matrix', matrix: m, updatedAt: Date.now() }) });
}

/**
 * Load the persisted matrix once (from the OpenSearch mirror), validating it.
 * Deny-by-default: anything malformed/absent → the safe DEFAULT_MATRIX. Idempotent
 * and cached on globalThis, so subsequent sync reads reflect it.
 */
export async function getMatrix(): Promise<RoleMatrix> {
  const s = state();
  if (s.loaded && s.matrix) return s.matrix;
  const res = await osFetch(`${DOC}`);
  if (res && res.ok) {
    s.osHealthy = true;
    try {
      const body = (await res.json()) as { _source?: { matrix?: unknown } };
      const stored = body?._source?.matrix;
      if (isValidMatrix(stored)) {
        s.matrix = cloneMatrix(stored);
        s.loaded = true;
        return s.matrix;
      }
    } catch {
      /* fall through to default */
    }
  } else if (res && res.status === 404) {
    // Index/doc not there yet — the mirror is reachable, seed it with the default.
    s.osHealthy = true;
  }
  s.matrix = cloneMatrix(DEFAULT_MATRIX);
  s.loaded = true;
  if (s.osHealthy) writeThrough(s.matrix);
  return s.matrix;
}

/** Ensure the pinned cache is hydrated (so the sync resolvers reflect persistence). */
export async function ensureRoleConfigLoaded(): Promise<void> {
  await getMatrix();
}

/** The current matrix without awaiting a load — cache, else the safe default. */
export function getMatrixSync(): RoleMatrix {
  return state().matrix ?? DEFAULT_MATRIX;
}

// ---- The public resolvers (what the gates read) -----------------------------

/**
 * The rights a role holds NOW — the config-resolved replacement for the
 * hardcoded `ROLE_RIGHTS[role]`. Sync + fail-safe: reads the pinned matrix (or
 * the safe default if not yet hydrated) and compiles it. `roles.ts` funnels
 * `rightsToTools` through this, so an Admin edit changes what the role can do.
 */
export function resolveRoleRights(role: Role): string[] {
  return matrixToRights(getMatrixSync(), role);
}

// ---- Admin write ------------------------------------------------------------

function e(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status?: number }).status = status;
  return err;
}

/**
 * Toggle one capability for one role on one component. Validated + fail-safe:
 *  - the (component, capability) must be applicable;
 *  - you cannot remove the admin role's `manage @ platform` (the last-admin lockout
 *    guard — the tenant-management grant every admin needs).
 * Returns the new matrix (also pinned + mirrored). The OPA recompile is the
 * caller's job (it owns the identity store).
 */
export async function setCapability(
  role: Role,
  component: Component,
  capability: Capability,
  enabled: boolean,
): Promise<RoleMatrix> {
  if (!ROLES.includes(role)) throw e('Unknown role', 400);
  if (!COMPONENT_IDS.includes(component)) throw e('Unknown component', 400);
  if (!CAPABILITY_IDS.includes(capability)) throw e('Unknown capability', 400);
  if (!isApplicable(component, capability)) throw e(`${capability} is not applicable to ${component}`, 400);
  if (role === 'admin' && component === 'platform' && capability === 'manage' && !enabled) {
    throw e('Cannot remove the admin role’s platform-management capability — that would lock every admin out', 400);
  }

  const current = await getMatrix();
  const next = cloneMatrix(current);
  const set = new Set(next[role][component]);
  if (enabled) set.add(capability);
  else set.delete(capability);
  next[role][component] = [...set];

  if (!isValidMatrix(next)) throw e('Refusing an invalid configuration', 400);

  const s = state();
  s.matrix = next;
  s.loaded = true;
  writeThrough(next);
  return next;
}

/** Test-only reset of the pinned cache. */
export function __resetRoleConfig(): void {
  const s = state();
  s.matrix = null;
  s.loaded = false;
  s.osHealthy = false;
}
