/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, DataVisibility } from '@tabs/data/lib/dataset-schema';
import { assetTarget, productTarget } from '@tabs/data/lib/store-fqn';
import { isCompanyScope } from '@core/kernel/company-scope';

/**
 * The policy compiler (data-policy-compiler.md): ONE source — a governed dataset's
 * visibility + grants — compiled to BOTH enforcement points so they can't drift:
 *
 *   1. the **Trino OPA** `data.governance` bundle the EXISTING `package trino` rego
 *      already reads (tables + principals) — we DON'T re-author the rego, we feed it;
 *
 * Pure + tested. The conformance test (`conformance.ts`) then proves the two agree.
 * Mask-vs-hide is the locked decision: a restricted column is MASKED in Trino and
 * EXCLUDED in Cube — the source says which, so the two are intentional, not accidental.
 */

// -------------------------------------------------- the one source, normalized ---

export type TableGovernance = {
  fqn: string;
  domain: string;
  visibility: DataVisibility;
  /** Domains explicitly granted (domain grants + marketplace imports). */
  shared_with: string[];
  /** Named individuals granted cross-domain (the additive rego clause). */
  shared_with_users: string[];
  /** Columns restricted for non-owners → masked in Trino. */
  sensitive_columns: Record<string, string>;
};

/** The governed Iceberg FQN a dataset is published under (gold preferred). */
export function tableFqn(d: Dataset): string {
  return d.tier === 'product' ? productTarget(d) : assetTarget(d);
}

/** The columns the compiled policy MASKS in Trino: every grant's `mask` + `hide`, unioned. The ONE
 *  definition — `governanceFor` compiles it and the Company personal-data rule
 *  (`personal-data-gate.ts`) asks it which personal-data columns are protected. */
export function maskedColumns(grants: Dataset['grants']): Set<string> {
  const out = new Set<string>();
  for (const g of grants ?? []) for (const c of [...g.scope.columns.mask, ...g.scope.columns.hide]) out.add(c);
  return out;
}

/** Normalize ONE governed dataset's visibility + grants into the policy source. */
export function governanceFor(d: Dataset): TableGovernance | null {
  if (d.tier === 'dataset') return null; // private datasets aren't governed in Trino
  const sharedDomains = new Set<string>([...(d.imports ?? [])]);
  const sharedUsers = new Set<string>();
  const sensitive: Record<string, string> = {};
  for (const g of d.grants) {
    if (g.grantee.kind === 'domain' && g.grantee.id !== d.domain) sharedDomains.add(g.grantee.id);
    if (g.grantee.kind === 'user') sharedUsers.add(g.grantee.id);
  }
  for (const c of maskedColumns(d.grants)) sensitive[c] = 'restricted';
  return {
    fqn: tableFqn(d),
    domain: d.domain,
    // A Company (product) dataset is READABLE BY EVERY DOMAIN — owner decision 2026-11-23,
    // the one rule in core/kernel/company-scope. Trino's `package trino` rego knows no tier,
    // so the compiled entry says `public` (row filter lifted for every principal); the
    // column masks below still apply to anyone without the clearance. A product certified
    // with the historical default `shared` used to compile to "shared with nobody" and
    // returned zero rows to every other domain.
    visibility: isCompanyScope(d.tier) ? 'public' : d.visibility,
    shared_with: [...sharedDomains].sort(),
    shared_with_users: [...sharedUsers].sort(),
    sensitive_columns: sensitive,
  };
}

// ----------------------------------------------- compile target 1 — Trino OPA ---

export type OpaPrincipal = { domains: string[]; clearances: string[] };
export type OpaBundle = {
  /** Keyed by FQN — exactly the shape `package trino` reads at `data.governance`. */
  tables: Record<string, Omit<TableGovernance, 'fqn'>>;
  principals: Record<string, OpaPrincipal>;
};

export type Roster = Record<string, { domains: string[]; clearances?: string[] }>;

/**
 * `extraDomains`: further domains that must map to themselves even when they govern no table yet
 * (every registered domain and every roster member's domain) — the full restore after an OPA
 * restart passes them so no domain session resolves to zero domains.
 */
/**
 * The CLOSED entry for a dataset that is not governed (back in My): its domain table, if one is
 * left behind, reads only for its own domain. Needed because `package trino` leaves an INTERNAL
 * (`iceberg`) table with NO entry unfiltered for everyone (`trino_test.rego`
 * `test_internal_table_without_entry_is_unfiltered`) — so "no entry" after an unshare would be
 * open, not closed. Emitted by every compile (build push, immediate push, reconcile AND the
 * os-data bundle), never over a governed entry for the same table.
 */
export function closedEntryFor(d: Dataset): Omit<TableGovernance, 'fqn'> {
  return { domain: d.domain, visibility: 'private', shared_with: [], shared_with_users: [], sensitive_columns: {} };
}

export function compileOpa(datasets: Dataset[], roster: Roster, extraDomains: string[] = []): OpaBundle {
  const tables: OpaBundle['tables'] = {};
  for (const d of datasets) {
    const g = governanceFor(d);
    if (!g) continue;
    const { fqn, ...rest } = g;
    tables[fqn] = rest;
  }
  // A My dataset's domain table (left by an unshare, or never built) gets the closed entry — but a
  // governed dataset that shares the FQN always wins (a slug collision must never close a live asset).
  for (const d of datasets) {
    if (d.tier !== 'dataset' || !d.domain) continue;
    const fqn = tableFqn(d);
    if (!tables[fqn]) tables[fqn] = closedEntryFor(d);
  }
  const principals: Record<string, OpaPrincipal> = {};
  for (const [id, p] of Object.entries(roster)) {
    principals[id] = { domains: p.domains, clearances: p.clearances ?? [] };
  }
  // Domain SELF-PRINCIPAL — every domain that governs a table (or is shared one)
  // MUST map to itself, or the Trino row filter resolves a domain-session user's
  // membership to [] and returns ZERO rows (the empty-scorecard bug). The governed
  // query tool runs as the domain name (`user.domains[0]`), so this self-mapping is
  // load-bearing and must be emitted on EVERY compile — it cannot depend on the
  // user directory happening to list the domain. Never clobber a real roster entry.
  for (const g of Object.values(tables)) {
    for (const dom of [g.domain, ...(g.shared_with ?? [])]) {
      if (dom && !principals[dom]) principals[dom] = { domains: [dom], clearances: [] };
    }
  }
  for (const dom of extraDomains) {
    if (dom && !principals[dom]) principals[dom] = { domains: [dom], clearances: [] };
  }
  return { tables, principals };
}

/** A principal as the rego sees it (user + the domains their groups carry). */
export type Identity = { user: string; domains: string[] };

/** Replicates the `package trino` rego's row/column decision over the OPA bundle —
 *  the pure check Build + tests use to prove the compiled bundle governs as intended. */
export function evaluateOpa(
  bundle: OpaBundle,
  identity: Identity,
  fqn: string,
  column?: string,
): { entitled: boolean; masked: boolean } {
  const meta = bundle.tables[fqn];
  if (!meta) return { entitled: false, masked: false };
  const inDomain = (dom: string) => identity.domains.includes(dom);
  const entitled =
    meta.visibility === 'public' ||
    inDomain(meta.domain) ||
    (meta.visibility === 'shared' && meta.shared_with.some(inDomain)) ||
    meta.shared_with_users.includes(identity.user);
  let masked = false;
  if (column && meta.sensitive_columns[column]) {
    const clearances = bundle.principals[identity.user]?.clearances ?? [];
    masked = !clearances.includes(meta.sensitive_columns[column]);
  }
  return { entitled, masked };
}

export type CompiledPolicy = { opa: OpaBundle };

/** Compile ONE source → the OPA bundle (run on Build + every grant/visibility change). */
export function compilePolicy(datasets: Dataset[], roster: Roster): CompiledPolicy {
  return { opa: compileOpa(datasets, roster) };
}

// ------------------------------------------- compile target — EXPOSURE SETS ---

/**
 * The minimal, pure view of a non-revoked exposure the compiler needs: the connection's
 * owning domain, the domains it is shared with, the catalog, and the listed tables. Kept
 * decoupled from the connections store's `ExposureSet` so this module stays pure/testable
 * (the server resolves connection.domain + catalog and passes this in).
 */
export type ExposureGovernanceInput = {
  /** The connection's OWNING domain — the exposed table's `domain` in governance. */
  domain: string;
  /** The registered Trino catalog the tables live in (e.g. `glue_sales`). */
  catalog: string;
  /** Domains the exposure grants the tables to. */
  domains: string[];
  tables: { schema: string; table: string }[];
};

/**
 * Compile a set of exposures into `data.governance.tables` entries — EXACTLY the shape
 * `compileOpa` emits for a dataset, so the rego's `table_entitled` reads them identically:
 *
 *   tables["<catalog>.<schema>.<table>"] = {
 *     domain, visibility:'shared', shared_with: <exposure.domains>,
 *     shared_with_users: [], sensitive_columns: {}
 *   }
 *
 * With the new fail-closed floor in `policies/trino.rego`, a table WITHOUT such an entry
 * (in a non-`iceberg`/non-internal catalog) reads zero rows for everyone — so this
 * function is the ONE thing that opens a live external catalog, and only to the assigned
 * domains. Later exposures for the same FQN win (last one compiled). Returns the
 * per-key `tables` map; the server pushes each key to `governance/tables/<key>` so it is
 * additive to the dataset entries (which are pushed wholesale under the same subtree).
 */
export function compileExposures(exposures: ExposureGovernanceInput[]): Record<string, Omit<TableGovernance, 'fqn'>> {
  const tables: Record<string, Omit<TableGovernance, 'fqn'>> = {};
  for (const e of exposures) {
    const shared = [...new Set(e.domains)].sort();
    for (const t of e.tables) {
      const fqn = `${e.catalog}.${t.schema}.${t.table}`;
      tables[fqn] = {
        domain: e.domain,
        visibility: 'shared',
        shared_with: shared,
        shared_with_users: [],
        sensitive_columns: {},
      };
    }
  }
  return tables;
}
