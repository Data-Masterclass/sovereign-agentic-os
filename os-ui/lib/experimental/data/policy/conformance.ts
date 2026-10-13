/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from '../dataset-schema.ts';
import {
  type CompiledPolicy,
  type CubeAccessPolicy,
  type OpaBundle,
  type Roster,
  compilePolicy,
  cubeFor,
  governanceFor,
  tableFqn,
} from './compiler.ts';

/**
 * The conformance test (data-policy-compiler.md §"Verification"): for a sample
 * identity + table, assert the SAME allowed rows/columns whether resolved via Trino
 * OPA or via Cube. If they differ, Build fails. This is the guardrail that proves the
 * two enforcement points agree — it runs on Build and on every grant/visibility change.
 *
 * Each path is evaluated from its OWN compiled structure (the OPA bundle vs the Cube
 * policies), so a drift introduced into one — a dropped grant, a column masked on one
 * side only — is caught. Mask-vs-hide is conformant BY DESIGN: a restricted column is
 * MASKED in Trino and EXCLUDED in Cube (both deny clear access), so OPA.masked must
 * equal Cube.excluded.
 */

export type Identity = { user: string; domains: string[] };

/** Replicates the `package trino` rego's row/column decision over the OPA bundle. */
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

/** The Cube securityContext decision over the compiled access policies. */
export function evaluateCube(
  policies: CubeAccessPolicy[],
  identity: Identity,
  cube: string,
  member?: string,
): { entitled: boolean; excluded: boolean } {
  const p = policies.find((x) => x.cube === cube);
  if (!p) return { entitled: false, excluded: false };
  const entitled =
    p.public || p.allowDomains.some((d) => identity.domains.includes(d)) || p.allowUsers.includes(identity.user);
  const excluded = member ? p.excludes.includes(member) : false;
  return { entitled, excluded };
}

export type Mismatch = {
  user: string;
  fqn: string;
  column?: string;
  reason: string;
  opa: { entitled: boolean; masked: boolean };
  cube: { entitled: boolean; excluded: boolean };
};

export type ConformanceReport = { ok: boolean; checks: number; mismatches: Mismatch[] };

/**
 * Run the conformance check across every governed dataset × every roster identity ×
 * (no column + each restricted column). Optionally `mutate` the compiled output first
 * — used to prove the check FAILS on injected drift.
 */
export function runConformance(
  datasets: Dataset[],
  roster: Roster,
  opts: { mutate?: (c: CompiledPolicy) => CompiledPolicy } = {},
): ConformanceReport {
  let compiled = compilePolicy(datasets, roster);
  if (opts.mutate) compiled = opts.mutate(compiled);

  const identities: Identity[] = Object.entries(roster).map(([user, p]) => ({ user, domains: p.domains }));
  const mismatches: Mismatch[] = [];
  let checks = 0;

  for (const d of datasets) {
    const g = governanceFor(d);
    if (!g) continue;
    const fqn = tableFqn(d);
    const cube = cubeFor(d);
    const columns: (string | undefined)[] = [undefined, ...Object.keys(g.sensitive_columns)];
    for (const id of identities) {
      for (const col of columns) {
        checks++;
        const opa = evaluateOpa(compiled.opa, id, fqn, col);
        const cu = evaluateCube(compiled.cube, id, cube, col);
        if (opa.entitled !== cu.entitled) {
          mismatches.push({ user: id.user, fqn, column: col, reason: 'row access differs (OPA vs Cube)', opa, cube: cu });
        } else if (col && opa.masked !== cu.excluded) {
          mismatches.push({ user: id.user, fqn, column: col, reason: 'column mask (Trino) ≠ exclude (Cube)', opa, cube: cu });
        }
      }
    }
  }
  return { ok: mismatches.length === 0, checks, mismatches };
}
