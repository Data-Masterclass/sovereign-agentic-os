/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, DataVisibility } from '../dataset-schema.ts';
import { assetTarget, productTarget } from '../store-fqn.ts';
import { cubeName } from '../metrics.ts';

/**
 * The policy compiler (data-policy-compiler.md): ONE source — a governed dataset's
 * visibility + grants — compiled to BOTH enforcement points so they can't drift:
 *
 *   1. the **Trino OPA** `data.governance` bundle the EXISTING `package trino` rego
 *      already reads (tables + principals) — we DON'T re-author the rego, we feed it;
 *   2. the **Cube** access policies (row_level + member_level) on each cube/view.
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
  /** Columns restricted for non-owners → masked in Trino / excluded in Cube. */
  sensitive_columns: Record<string, string>;
};

/** The governed Iceberg FQN a dataset is published under (gold preferred). */
export function tableFqn(d: Dataset): string {
  return d.tier === 'product' ? productTarget(d) : assetTarget(d);
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
    for (const c of [...g.scope.columns.mask, ...g.scope.columns.hide]) sensitive[c] = 'restricted';
  }
  return {
    fqn: tableFqn(d),
    domain: d.domain,
    visibility: d.visibility,
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

export function compileOpa(datasets: Dataset[], roster: Roster): OpaBundle {
  const tables: OpaBundle['tables'] = {};
  for (const d of datasets) {
    const g = governanceFor(d);
    if (!g) continue;
    const { fqn, ...rest } = g;
    tables[fqn] = rest;
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
  return { tables, principals };
}

// ------------------------------------------------ compile target 2 — Cube -------

/** A Cube `access_policy` block (data-policy-compiler.md compile target 2). */
export type CubeAccessPolicy = {
  /** The cube/view this governs. */
  cube: string;
  /** Domains + named users whose securityContext is allowed rows. */
  allowDomains: string[];
  allowUsers: string[];
  /** `true` ⇒ any domain (visibility=public). */
  public: boolean;
  /** member_level.excludes — restricted columns hidden in Cube. */
  excludes: string[];
};

/** The cube name a dataset's view binds to (one cube per gold mart). Delegates to
 *  `cubeName` (the single identity source) so the compiled access-policy key is
 *  BYTE-FOR-BYTE the model name `buildCubeModels` joins on — #155 namespacing included.
 *  If these two ever diverged, `policies.get(cubeName(d))` would miss and the cube would
 *  ship with NO access policy. */
export function cubeFor(d: Dataset): string {
  return cubeName(d);
}

export function compileCube(datasets: Dataset[]): CubeAccessPolicy[] {
  const out: CubeAccessPolicy[] = [];
  for (const d of datasets) {
    const g = governanceFor(d);
    if (!g) continue;
    // Mirror the OPA rego EXACTLY: the owning domain is always entitled; shared_with
    // domains count ONLY when visibility is `shared` (else the two paths would drift).
    const sharedDomains = g.visibility === 'shared' ? g.shared_with : [];
    out.push({
      cube: cubeFor(d),
      allowDomains: [g.domain, ...sharedDomains].sort(),
      allowUsers: g.shared_with_users,
      public: g.visibility === 'public',
      excludes: Object.keys(g.sensitive_columns).sort(),
    });
  }
  return out;
}

export type CompiledPolicy = { opa: OpaBundle; cube: CubeAccessPolicy[] };

/** Compile ONE source → both targets (run on Build + every grant/visibility change). */
export function compilePolicy(datasets: Dataset[], roster: Roster): CompiledPolicy {
  return { opa: compileOpa(datasets, roster), cube: compileCube(datasets) };
}
