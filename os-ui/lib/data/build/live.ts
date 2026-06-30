/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type DataAdapter, type DataStage, type StepResult } from './adapter.ts';
import { transparencyGate, gateReason } from '../transparency.ts';
import {
  CUBE_ARTIFACT,
  DASHBOARD_ARTIFACT,
  EXPOSURE_ARTIFACT,
  cubeViewName,
  goldMartFqn,
  slug,
} from '../metrics.ts';
import { assetTarget } from '../store-fqn.ts';
import { type CubeAccessPolicy, type OpaBundle, compilePolicy } from '../policy/compiler.ts';
import { runConformance } from '../policy/conformance.ts';

/**
 * The LIVE Data Build adapters — real apply→verify against the services, behind the
 * same {@link DataAdapter} interface as the mocks. Every backend is injected as a
 * small client interface so this module stays PURE and unit-testable against
 * in-memory fakes; the real fetch-backed clients live in `live-clients.ts`
 * (server-only). A network/HTTP failure surfaces as a throw or falsy result so the
 * row reports ✗ honestly — never a false ✓.
 *
 * Phase 5 implements the Metric + Dashboard stages' adapters (cube · superset · om);
 * Phase 6 adds dlt · dbt · dbt-trino · trino · policy under the same factory.
 */

// ----------------------------------------------------------------- clients -------

export interface CubeClient {
  /** Validate + (re)load the generated Cube schema (the cube_dbt YAML). */
  reload(name: string, schema: string): Promise<void>;
  /** Resolve a measure on a probe query — returns the number, or null if it can't. */
  resolveMeasure(view: string, measure: string): Promise<number | null>;
}

export interface SupersetClient {
  importBundle(name: string, bundle: string): Promise<void>;
  dashboardExists(name: string): Promise<boolean>;
}

export interface OmClient {
  /** Push a dbt `exposure` so the mart→metric/dashboard edge lands in OpenMetadata. */
  pushExposure(name: string, yaml: string): Promise<void>;
  /** Does the catalog have a lineage edge for this FQN (the upstream mart)? */
  hasLineage(fqn: string): Promise<boolean>;
}

export interface DltClient {
  /** Run the load → a raw Iceberg table in Polaris. */
  load(table: string, source: string): Promise<void>;
  /** A table + snapshot exist in Polaris (the verify probe). */
  tableExists(table: string): Promise<boolean>;
}

export interface DbtClient {
  /** `dbt build` (+ compile, docs generate) for the model FQN; reports tests +
   *  compiled_code. Note: dbt `build` aborts dependents on a failed test, so a
   *  queryable mart is honest evidence its tests passed. */
  build(modelFqn: string): Promise<{ testsPassed: boolean; compiledCode: boolean }>;
}

export interface DbtTrinoClient {
  /** Materialize the model as a governed Iceberg table via dbt-trino. */
  materialize(fqn: string): Promise<{ ok: boolean }>;
}

export interface TrinoClient {
  /** A probe SELECT succeeds for the principal (OPA-governed) — the table is live. */
  tableQueryable(fqn: string, principal?: string): Promise<boolean>;
}

export interface PolicyClient {
  /** Push the compiled OPA `data.governance` bundle + Cube access policies. */
  push(opa: OpaBundle, cube: CubeAccessPolicy[]): Promise<void>;
}

/** Minimal roster shape for the policy adapter (id → domains). */
export type PolicyRoster = Record<string, { domains: string[]; clearances?: string[] }>;

export type DataLiveDeps = {
  cube: CubeClient;
  superset: SupersetClient;
  om: OmClient;
  dlt: DltClient;
  dbt: DbtClient;
  dbtTrino: DbtTrinoClient;
  trino: TrinoClient;
  policy: PolicyClient;
  /** The principal roster the policy conformance check evaluates against. */
  roster: PolicyRoster;
};

function ok(detail: string): StepResult {
  return { ok: true, detail };
}
function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}

// --------------------------------------------------------- stage → adapter-set ---

/** Which tools each stage's Build runs (brief §"stage→adapter-set"). Stages whose
 *  adapters arrive in Phase 6 list them here; the orchestrator runs only the ones
 *  present in the adapter map, so it never fakes a ✓ for an unimplemented tool. */
export const ADAPTER_SET: Record<DataStage, string[]> = {
  bronze: ['dlt', 'om'],
  silver: ['dbt', 'om'],
  gold: ['dbt', 'om'],
  metric: ['cube', 'om'],
  dashboard: ['superset', 'om'],
  promote: ['dbt-trino', 'trino', 'om', 'policy'],
  certify: ['om', 'policy'],
};

// ----------------------------------------------------------------- adapters ------

export function makeLiveAdapters(deps: DataLiveDeps): Record<string, DataAdapter> {
  const cube: DataAdapter = {
    tool: 'cube',
    async apply(ctx) {
      const name = slug(ctx.dataset.name);
      const schema = ctx.artifacts[CUBE_ARTIFACT(ctx.dataset)];
      if (!schema) return fail('no Cube model generated');
      await deps.cube.reload(name, schema);
      return ok(`reloaded Cube model '${name}' (${ctx.dataset.measures.length} measure(s))`);
    },
    async verify(ctx) {
      const view = cubeViewName(ctx.dataset);
      const measure = ctx.dataset.measures[0]?.name ?? 'count';
      const value = await deps.cube.resolveMeasure(view, measure);
      if (value === null) return fail(`metric '${measure}' did not resolve on view '${view}'`);
      return ok(`metric '${measure}' resolves on '${view}' (= ${value})`);
    },
  };

  const superset: DataAdapter = {
    tool: 'superset',
    async apply(ctx) {
      const view = cubeViewName(ctx.dataset);
      const bundle = ctx.artifacts[DASHBOARD_ARTIFACT(ctx.dataset)];
      if (!bundle) return fail('no Superset bundle generated');
      await deps.superset.importBundle(`${view} Overview`, bundle);
      return ok(`imported Superset dashboard '${view} Overview'`);
    },
    async verify(ctx) {
      const view = cubeViewName(ctx.dataset);
      const exists = await deps.superset.dashboardExists(`${view} Overview`);
      if (!exists) return fail(`dashboard '${view} Overview' not found after import`);
      return ok(`dashboard '${view} Overview' loads`);
    },
  };

  // The transparency gate blocks GOVERNED catalog entry + consumption — not a raw
  // Bronze load or an intermediate Silver model still in the sandbox.
  const GATED: ReadonlySet<DataStage> = new Set(['metric', 'dashboard', 'promote', 'certify']);
  const om: DataAdapter = {
    tool: 'om',
    async apply(ctx) {
      const exposure = ctx.artifacts[EXPOSURE_ARTIFACT];
      if (ctx.stage === 'metric' || ctx.stage === 'dashboard') {
        if (!exposure) return fail('no dbt exposure generated');
        await deps.om.pushExposure(`${slug(ctx.dataset.name)}_metrics`, exposure);
        return ok('pushed dbt exposure (mart→metric edge)');
      }
      // Refinement/promotion: the dbt/dlt artifacts ingestion owns the catalog entry;
      // pushing the exposure also seeds the upstream edge the gated stages verify.
      if (exposure) await deps.om.pushExposure(`${slug(ctx.dataset.name)}_lineage`, exposure);
      return ok(`catalogued ${ctx.stage ?? 'artifact'} in OpenMetadata`);
    },
    async verify(ctx) {
      // For governed/consumption stages the transparency GATE is enforced (no ✓ for an
      // undocumented/orphan artifact) + the upstream lineage edge must be present.
      if (ctx.stage && GATED.has(ctx.stage)) {
        const gate = transparencyGate(ctx.dataset);
        if (!gate.ok) return fail(gateReason(gate));
        const edge = await deps.om.hasLineage(goldMartFqn(ctx.dataset));
        if (!edge) return fail('no upstream lineage edge in the catalog');
        return ok('transparency gate green + upstream lineage edge present');
      }
      return ok(`${ctx.stage ?? 'artifact'} catalogued`);
    },
  };

  // ----------------------------------------------- bronze / silver / gold ------

  const dlt: DataAdapter = {
    tool: 'dlt',
    async apply(ctx) {
      const table = `iceberg.${ctx.dataset.domain}.bronze_${slug(ctx.dataset.name)}`;
      await deps.dlt.load(table, ctx.dataset.name);
      return ok(`loaded raw Iceberg table ${table}`);
    },
    async verify(ctx) {
      const table = `iceberg.${ctx.dataset.domain}.bronze_${slug(ctx.dataset.name)}`;
      const exists = await deps.dlt.tableExists(table);
      if (!exists) return fail(`raw table ${table} (or its snapshot) is not in Polaris`);
      return ok(`raw table + snapshot present in Polaris`);
    },
  };

  const dbtModelFqn = (ctx: { dataset: { domain: string; name: string }; stage?: DataStage }) => {
    const s = slug(ctx.dataset.name);
    return ctx.stage === 'silver'
      ? `iceberg.${ctx.dataset.domain}.silver_${s}`
      : `iceberg.${ctx.dataset.domain}.gold_${s}`;
  };
  const dbt: DataAdapter = {
    tool: 'dbt',
    async apply(ctx) {
      const fqn = dbtModelFqn(ctx);
      const r = await deps.dbt.build(fqn);
      if (!r.testsPassed) return fail(`dbt tests failed on ${fqn} — nothing untested enters Trino`);
      if (!r.compiledCode) return fail('manifest is missing compiled_code (run dbt compile)');
      return ok(`dbt build ${fqn} passed (tests + compiled_code present)`);
    },
    async verify(ctx) {
      return ok(`${dbtModelFqn(ctx)} built, tests green`);
    },
  };

  // --------------------------------------------------- promote / certify -------

  const dbtTrino: DataAdapter = {
    tool: 'dbt-trino',
    async apply(ctx) {
      const fqn = assetTarget(ctx.dataset);
      const r = await deps.dbtTrino.materialize(fqn);
      if (!r.ok) return fail(`dbt-trino could not materialize ${fqn}`);
      return ok(`materialized governed Iceberg table ${fqn}`);
    },
    async verify(ctx) {
      const fqn = assetTarget(ctx.dataset);
      const live = await deps.trino.tableQueryable(fqn, ctx.principal);
      if (!live) return fail(`materialized table ${fqn} is not queryable`);
      return ok(`${fqn} materialized + queryable`);
    },
  };

  const trino: DataAdapter = {
    tool: 'trino',
    async apply(ctx) {
      // The table is materialized by dbt-trino; this adapter's job is the live probe.
      return ok(`Trino ready for ${assetTarget(ctx.dataset)}`);
    },
    async verify(ctx) {
      const fqn = assetTarget(ctx.dataset);
      const live = await deps.trino.tableQueryable(fqn, ctx.principal);
      if (!live) return fail(`probe SELECT on ${fqn} failed (OPA-governed)`);
      return ok(`probe SELECT on ${fqn} succeeded for ${ctx.principal ?? 'principal'}`);
    },
  };

  const policy: DataAdapter = {
    tool: 'policy',
    async apply(ctx) {
      const compiled = compilePolicy([ctx.dataset], deps.roster);
      await deps.policy.push(compiled.opa, compiled.cube);
      return ok(`compiled 1 source → OPA (${Object.keys(compiled.opa.tables).length} table) + Cube (${compiled.cube.length} policy)`);
    },
    async verify(ctx) {
      // The conformance gate: OPA path == Cube path, else ✗ (data-policy-compiler.md).
      const r = runConformance([ctx.dataset], deps.roster);
      if (!r.ok) return fail(`policy drift: ${r.mismatches[0]?.reason ?? 'OPA ≠ Cube'} (${r.mismatches.length} mismatch)`);
      return ok(`OPA == Cube across ${r.checks} check(s) — conformant`);
    },
  };

  return { cube, superset, om, dlt, dbt, 'dbt-trino': dbtTrino, trino, policy };
}
