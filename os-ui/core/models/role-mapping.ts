/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The three role names the OS calls and their mapping onto catalog models (`os/models.yml`).
 * USER STORY: As a platform admin I map `sovereign-strong`, `sovereign-worker` and `sovereign-embedding`
 *             to real catalog models. A mapping to a model that is not in the catalog is refused with a
 *             typed error; an old alias keeps working, named as deprecated.
 * ARCHITECTURE:
 *   - OWNERSHIP. The CATALOG (real models under their real names) belongs to LiteLLM: the platform
 *     team adds and removes models and keys there. The ROLE MAPPING belongs to the OS: it is edited in
 *     Platform → Models (admin only, audited) and stored as the file `os/models.yml` in the platform
 *     repository, so it is versioned, diffable and restorable. The OS ENFORCES it by writing LiteLLM's
 *     documented `router_settings.model_group_alias` (`role-reconcile.ts`), so every caller — os-ui,
 *     agent keys, apps — resolves a role the same way, at the gateway. The OS does no client-side
 *     model resolution.
 *   - DEPRECATED ALIASES (one release): the older names collapse onto the roles — sovereign-default and
 *     sovereign-mock → worker; sovereign-reasoning, -reasoning-fast, -premium, -vision → strong;
 *     sovereign-embed → embedding. They are written as aliases pointing where their role points, unless
 *     the name is itself a real catalog model (then the real model wins and nothing is aliased).
 *   - Pure: no IO, no `server-only`.
 */
import yaml from 'js-yaml';

export const ROLE_NAMES = ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type RoleMapping = Record<RoleName, string>;

/** Old names that still work for one release, and the role each one now stands for. */
export const DEPRECATED_ALIASES: Readonly<Record<string, RoleName>> = {
  'sovereign-default': 'sovereign-worker',
  'sovereign-mock': 'sovereign-worker',
  'sovereign-reasoning': 'sovereign-strong',
  'sovereign-reasoning-fast': 'sovereign-strong',
  'sovereign-premium': 'sovereign-strong',
  'sovereign-vision': 'sovereign-strong',
  'sovereign-embed': 'sovereign-embedding',
};

/** A typed refusal: the file or the requested mapping is not acceptable. `status` is the HTTP status a route answers with. */
export class ModelMappingError extends Error {
  readonly status = 422;
  readonly code: 'invalid_mapping' | 'unknown_catalog_model';
  readonly role?: RoleName;
  readonly model?: string;
  constructor(code: 'invalid_mapping' | 'unknown_catalog_model', message: string, role?: RoleName, model?: string) {
    super(message);
    this.name = 'ModelMappingError';
    this.code = code;
    this.role = role;
    this.model = model;
  }
}

const isRole = (r: string): r is RoleName => (ROLE_NAMES as readonly string[]).includes(r);

/** Check an object (a parsed file or a request body) is exactly the three roles, each a non-empty model name. */
export function asRoleMapping(raw: unknown): RoleMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ModelMappingError('invalid_mapping', 'the role mapping must be an object with the three roles');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!isRole(k)) throw new ModelMappingError('invalid_mapping', `'${k}' is not a role; the roles are ${ROLE_NAMES.join(', ')}`);
  const out = {} as RoleMapping;
  for (const role of ROLE_NAMES) {
    const m = o[role];
    if (typeof m !== 'string' || m.trim().length === 0) throw new ModelMappingError('invalid_mapping', `role ${role} needs a catalog model name`, role);
    out[role] = m.trim();
  }
  return out;
}

export function parseModelsYml(text: string): RoleMapping {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new ModelMappingError('invalid_mapping', `os/models.yml is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  const roles = doc && typeof doc === 'object' ? (doc as { roles?: unknown }).roles : undefined;
  return asRoleMapping(roles);
}

export function serializeModelsYml(mapping: RoleMapping): string {
  const header = '# Role mapping — owned by the OS (Platform → Models). The OS applies it to LiteLLM\'s router_settings.model_group_alias.\n# Each role names a model in the LiteLLM catalog; edit it in Platform → Models, not here.\n';
  return header + yaml.dump({ roles: Object.fromEntries(ROLE_NAMES.map((r) => [r, mapping[r]])) }, { lineWidth: 200 });
}

/** Refuse a mapping that names a model the catalog does not have. */
export function validateMapping(mapping: RoleMapping, catalog: Iterable<string>): void {
  const have = new Set(catalog);
  for (const role of ROLE_NAMES) {
    if (!have.has(mapping[role])) {
      throw new ModelMappingError('unknown_catalog_model', `${mapping[role]} is not in the LiteLLM catalog, so ${role} cannot point at it`, role, mapping[role]);
    }
  }
}

/** What `router_settings.model_group_alias` must hold for this mapping: the roles (only `roles`), plus the deprecated names that follow them. */
export function desiredAliases(mapping: RoleMapping, catalog: ReadonlySet<string>, roles: readonly RoleName[] = ROLE_NAMES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of roles) out[role] = mapping[role];
  for (const [old, role] of Object.entries(DEPRECATED_ALIASES)) {
    if (roles.includes(role) && !catalog.has(old)) out[old] = mapping[role];
  }
  return out;
}

export type AliasDiff = { alias: string; have: string | undefined; want: string };

/** Aliases that are missing or point elsewhere. Aliases the OS does not own are never listed. */
export function diffAliases(current: Readonly<Record<string, string>>, want: Readonly<Record<string, string>>): AliasDiff[] {
  return Object.entries(want).filter(([a, w]) => current[a] !== w).map(([alias, w]) => ({ alias, have: current[alias], want: w }));
}

const warned = new Set<string>();
/** A deprecated alias was named somewhere: one log line per alias per process. */
export function noteDeprecatedAlias(name: string, where: string, log: (line: string) => void = (l) => console.warn(l)): void {
  const role = DEPRECATED_ALIASES[name];
  if (!role || warned.has(name)) return;
  warned.add(name);
  log(`[models] deprecated model name '${name}' (used by ${where}) still works and now means '${role}'. Use '${role}' — the old name goes away after one release.`);
}
