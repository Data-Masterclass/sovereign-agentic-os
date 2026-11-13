/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino file-based access-control rules — who may impersonate whom, and who owns which schema
 * USER STORY: As a platform owner I want the dbt service user to be able to act as an OS principal and
 *             as NOTHING else, and a domain's Iceberg schema to be writable only by principals of that
 *             domain — expressed in the engine's own rules file, not in OS code the engine never sees.
 * ARCHITECTURE:
 *   - PURE. `buildTrinoRules(input)` → the `rules.json` document Trino's `file` system access control
 *     reads; `renderTrinoRules` serialises it byte-stably (2-space JSON, one trailing newline). The
 *     impure half (patching the ConfigMap, rolling Trino) lives in `trino-rules-server.ts`.
 *   - Trino evaluates each rule list TOP-DOWN and the FIRST match wins. Every list therefore ends in
 *     an explicit catch-all DENY, so the document never depends on Trino's default for an absent
 *     section — `impersonationAllowed` / `tablePrivilegesFor` reimplement exactly that first-match
 *     rule, which is what the tests assert against.
 *   - Principals are ENUMERATED, never templated: Trino's `${USER}` substitution is not available in
 *     every rule field, and the OS knows every uid and domain, so `personal_<uid>` ownership is one
 *     explicit rule per uid. Deterministic order (sorted) keeps the file diff-stable.
 *   - NO SECRET may appear here. The file is mounted read-only into Trino and is visible to anyone who
 *     can read the ConfigMap; it carries identifiers and regexes only.
 *   - Chained with the OPA plugin (`access-control.config-files`): BOTH must allow, so these rules can
 *     only ever narrow what `policies/trino.rego` already permits.
 */

export type RulesInput = {
  /** Users allowed to impersonate an OS principal (the dbt runner). */
  serviceUsers: string[];
  /** The regex an impersonated principal must match, WITHOUT anchors (anchored on render). Used
   *  only when no principal is enumerated — the chart's bootstrap file. */
  principalPattern: string;
  /** Extra principals the service user may become, beyond the domains and lanes below. */
  knownPrincipals?: string[];
  /** Domains whose Iceberg schema is owned by the domain's principals. Sorted on build. */
  domains: { name: string; schema: string; principals: string[] }[];
  /** Personal lanes: `uid` → `personal_<uid>`. Sorted on build. */
  personalLanes: { uid: string; schema: string }[];
  /** Users that may read everything (the OS query path reads as the end user, so this stays empty). */
  readAnySchema?: string[];
};

export type ImpersonationRule = { original_user: string; new_user: string; allow: boolean };
export type SchemaRule = { user?: string; schema?: string; owner: boolean };
export type TableRule = { user?: string; schema?: string; table?: string; privileges: string[] };
export type CatalogRule = { user?: string; catalog?: string; allow: 'all' | 'read-only' | 'none' };

export type TrinoRules = {
  catalogs: CatalogRule[];
  schemas: SchemaRule[];
  tables: TableRule[];
  impersonation: ImpersonationRule[];
};

/**
 * The shape of an OS principal id (a domain name or a uid): the BOOTSTRAP bound on impersonation,
 * used before the OS has enumerated anything. Must stay in step with the chart's
 * `trino.accessControl.principalPattern` — `trino-rules.test.ts` asserts the two agree.
 */
export const OS_PRINCIPAL_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

/** Everything a schema owner may do to a table in it. `OWNERSHIP` is what CTAS / DROP need. */
export const OWNER_PRIVILEGES = ['SELECT', 'INSERT', 'DELETE', 'UPDATE', 'OWNERSHIP'] as const;
const READ_ONLY = ['SELECT'] as const;

/** Anchor a user-supplied regex fragment so a rule cannot match a longer string by accident. */
export function anchor(pattern: string): string {
  const p = pattern.replace(/^\^/, '').replace(/\$$/, '');
  return `^${p}$`;
}

/** An exact-match regex for one literal identifier. */
export function literal(id: string): string {
  return `^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function alternation(ids: readonly string[]): string {
  return `^(${[...ids].sort().map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

/**
 * The whole `rules.json`. Order matters: the narrow allows come first, the catch-all denies last.
 *
 * `catalogs` stays permissive (`all`): catalog-level reach is the OPA plugin's and the OS's
 * business, and a restrictive catalog rule here would silently break every existing reader. What
 * this file adds is the two things OPA cannot express — impersonation, and schema ownership.
 */
export function buildTrinoRules(input: RulesInput): TrinoRules {
  const serviceUsers = [...new Set(input.serviceUsers)].sort();
  const domains = [...input.domains].sort((a, b) => a.name.localeCompare(b.name));
  const lanes = [...input.personalLanes].sort((a, b) => a.uid.localeCompare(b.uid));

  // Who the service user is allowed to BE. When the OS knows its principals (the reconciler passes
  // them) the rule is an exact alternation of those ids, so `root` or a service account is refused
  // even though it would satisfy the id pattern. The pattern is the BOOTSTRAP fallback the chart
  // renders before the OS has reconciled anything — narrow by shape, not by name.
  const known = [
    ...new Set([
      ...domains.flatMap((d) => [d.name, ...d.principals]),
      ...lanes.map((l) => l.uid),
      ...(input.knownPrincipals ?? []),
    ]),
  ].sort();
  const impersonationTarget = known.length ? alternation(known) : anchor(input.principalPattern);

  const impersonation: ImpersonationRule[] = [];
  for (const u of serviceUsers) {
    // (a) the service user may become an OS principal …
    impersonation.push({ original_user: literal(u), new_user: impersonationTarget, allow: true });
    // … and nothing else, not even itself-by-another-spelling.
    impersonation.push({ original_user: literal(u), new_user: '.*', allow: false });
  }
  // (b) everyone else: a user may only "impersonate" themselves (Trino asks even for that when the
  // session user equals the authenticated user in some paths), never another identity.
  impersonation.push({ original_user: '(.*)', new_user: '$1', allow: true });
  impersonation.push({ original_user: '.*', new_user: '.*', allow: false });

  const schemas: SchemaRule[] = [];
  const tables: TableRule[] = [];

  // (d) schema ownership — a domain schema is owned by that domain's principals; a personal lane by
  // its own uid. Everything else: not an owner (so no CREATE / DROP / CTAS in it).
  for (const d of domains) {
    const owners = [...new Set([d.name, ...d.principals])].sort();
    schemas.push({ user: alternation(owners), schema: literal(d.schema), owner: true });
    tables.push({ user: alternation(owners), schema: literal(d.schema), privileges: [...OWNER_PRIVILEGES] });
    // A reader from outside the domain keeps SELECT: row filters and column masks stay OPA's job.
    tables.push({ schema: literal(d.schema), privileges: [...READ_ONLY] });
  }
  for (const l of lanes) {
    schemas.push({ user: literal(l.uid), schema: literal(l.schema), owner: true });
    tables.push({ user: literal(l.uid), schema: literal(l.schema), privileges: [...OWNER_PRIVILEGES] });
    // No SELECT fallthrough for a personal lane: `trino.rego` hard-denies a foreign `personal_*`
    // read and this file must not be the place that re-opens it.
    tables.push({ schema: literal(l.schema), privileges: [] });
  }
  for (const u of [...new Set(input.readAnySchema ?? [])].sort()) {
    tables.push({ user: literal(u), privileges: [...READ_ONLY] });
  }
  // Catch-all. With principals ENUMERATED it closes: a schema nobody was granted is nobody's to
  // create in. With NOTHING enumerated the file is the chart's BOOTSTRAP — "the OS has not spoken
  // yet", not "nobody owns anything" — so ownership stays exactly as it is without this file and
  // only impersonation is bounded. Closing it there would deny every CTAS on a fresh install.
  const enumerated = domains.length > 0 || lanes.length > 0;
  schemas.push({ owner: !enumerated });
  tables.push({ privileges: enumerated ? [...READ_ONLY] : [...OWNER_PRIVILEGES] });

  return {
    catalogs: [{ allow: 'all' }],
    schemas,
    tables,
    impersonation,
  };
}

/** A directory entry the rules are derived from (the Admin user directory's shape, narrowed). */
export type RulesDirectoryUser = { id: string; domains: string[]; disabled?: boolean };

/**
 * Turn the OS's own membership facts into a `RulesInput`: every known domain gets a schema owned by
 * itself plus its members, every ACTIVE user gets `personal_<uid>`. A disabled user keeps neither —
 * their lane stops being writable the moment the directory says they are gone, which is the same
 * rule the inactive-principal sensor applies to schedules.
 *
 * `sanitize` is the SAME function `store-fqn` uses for a schema name; it is passed in so this module
 * stays in @core and does not import a tab.
 */
export function rulesInputFromDirectory(input: {
  serviceUsers: string[];
  principalPattern: string;
  domains: string[];
  users: RulesDirectoryUser[];
  sanitize: (s: string) => string;
}): RulesInput {
  const active = input.users.filter((u) => !u.disabled);
  const members = new Map<string, string[]>();
  for (const d of input.domains) members.set(d, []);
  for (const u of active) {
    for (const d of u.domains) {
      if (!members.has(d)) members.set(d, []);
      members.get(d)!.push(u.id);
    }
  }
  return {
    serviceUsers: input.serviceUsers,
    principalPattern: input.principalPattern,
    domains: [...members.entries()]
      .map(([name, principals]) => ({ name, schema: input.sanitize(name), principals: [...new Set(principals)].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    personalLanes: active.map((u) => ({ uid: u.id, schema: `personal_${input.sanitize(u.id)}` })).sort((a, b) => a.uid.localeCompare(b.uid)),
  };
}

/** Byte-stable `rules.json`. */
export function renderTrinoRules(rules: TrinoRules): string {
  return JSON.stringify(rules, null, 2) + '\n';
}

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * Trino's own first-match-wins evaluation of the `impersonation` list, so the rules can be asserted
 * without a cluster. `$1`-style backreferences in `new_user` are expanded against the groups the
 * `original_user` pattern captured — exactly what Trino's file access control does.
 */
export function impersonationAllowed(rules: TrinoRules, originalUser: string, newUser: string): boolean {
  for (const r of rules.impersonation) {
    let m: RegExpExecArray | null = null;
    try {
      m = new RegExp(r.original_user).exec(originalUser);
    } catch {
      continue;
    }
    if (!m) continue;
    const target = r.new_user.replace(/\$(\d)/g, (_s, g: string) => m![Number(g)] ?? '');
    if (!matches(target, newUser)) continue;
    return r.allow;
  }
  return false;
}

/** First-match-wins over `schemas`: may `user` own (create/drop in) `schema`? */
export function schemaOwnerAllowed(rules: TrinoRules, user: string, schema: string): boolean {
  for (const r of rules.schemas) {
    if (r.user && !matches(r.user, user)) continue;
    if (r.schema && !matches(r.schema, schema)) continue;
    return r.owner;
  }
  return false;
}

/** First-match-wins over `tables`: the privileges `user` holds on `schema.table`. */
export function tablePrivilegesFor(rules: TrinoRules, user: string, schema: string, table = 'any_table'): string[] {
  for (const r of rules.tables) {
    if (r.user && !matches(r.user, user)) continue;
    if (r.schema && !matches(r.schema, schema)) continue;
    if (r.table && !matches(r.table, table)) continue;
    return r.privileges;
  }
  return [];
}
