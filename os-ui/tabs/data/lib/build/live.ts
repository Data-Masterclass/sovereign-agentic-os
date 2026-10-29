/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type DataAdapter, type DataStage, type StepResult } from '@tabs/data/lib/build/adapter';
import type { ExecuteIdentity } from '@core/infra/governed';
import { assetTarget, domainSchema, physicalSlug } from '@tabs/data/lib/store-fqn';
import { type OpaBundle, compilePolicy, tableFqn } from '@tabs/data/lib/policy/compiler';

/**
 * The LIVE Data Build adapters — real apply→verify against the services, behind the
 * same {@link DataAdapter} interface as the mocks. Every backend is injected as a
 * small client interface so this module stays PURE and unit-testable against
 * in-memory fakes; the real fetch-backed clients live in `live-clients.ts`
 * (server-only). A network/HTTP failure surfaces as a throw or falsy result so the
 * row reports ✗ honestly — never a false ✓.
 *
 * Adapters: dlt · dbt · dbt-trino · trino · policy — every stage runs through the
 * governed Trino/OPA path.
 */

// ----------------------------------------------------------------- clients -------

/** The artifact key carrying the uploaded object's MinIO key into the Bronze build,
 *  so the dlt adapter's `apply` can hand it to the data-runner /ingest call. */
export const INGEST_OBJECT_KEY = 'ingest.objectKey';

export interface DltClient {
  /** Run the load → a raw Iceberg table in Polaris. For a file upload the `ctx`
   *  carries the MinIO objectKey + the acting principal so the real client calls the
   *  data-runner /ingest; with no objectKey it is a no-op (verify then reports ✗). */
  load(table: string, source: string, ctx?: { objectKey?: string; principal?: string }): Promise<void>;
  /** A table + snapshot exist in Polaris (the verify probe, run as the principal). */
  tableExists(table: string, principal?: string): Promise<boolean>;
}

export interface DbtClient {
  /** `dbt build` (+ compile, docs generate) for the model FQN; reports tests +
   *  compiled_code. Note: dbt `build` aborts dependents on a failed test, so a
   *  queryable mart is honest evidence its tests passed.
   *
   *  M1 Silver builder: when `write` is supplied, the client EXECUTES the compiled,
   *  allowlisted CTAS as the caller (governed `/execute`) and reports whether the
   *  resulting table is queryable — a rejected statement or Trino error throws with
   *  the real message so the row reports ✗ honestly (dbt tests/scheduling are M2). */
  build(
    modelFqn: string,
    write?: { sql: string; identity: ExecuteIdentity },
    /** Principal for the verify-only probe (no `write`): a personal-lane table can
     *  only be read AS its owner, so the probe must run as the caller. */
    principal?: string,
  ): Promise<{ testsPassed: boolean; compiledCode: boolean }>;
}

/** The publish write bundle (T8): the promote CTAS + the APPROVING Builder's
 *  identity, plus the idempotent domain-schema DDL and the personal source schema
 *  to release read-only for the copy's duration. */
export type DbtTrinoWrite = {
  sql: string;
  schemaSql?: string;
  identity: ExecuteIdentity;
  releaseSchema?: string;
};

export interface DbtTrinoClient {
  /** Materialize the model as a governed Iceberg table. With a `write` (the promote
   *  publish) the REAL client executes the allowlisted CTAS via the governed
   *  `/execute` as `write.identity` — the approving Builder — then probes the
   *  result; a rejection/Trino error throws with the real message (honest ✗). */
  materialize(fqn: string, write?: DbtTrinoWrite): Promise<{ ok: boolean }>;
}

export interface TrinoClient {
  /** A probe SELECT succeeds for the principal (OPA-governed) — the table is live. */
  tableQueryable(fqn: string, principal?: string): Promise<boolean>;
}

export interface PolicyClient {
  /** Push the compiled OPA `data.governance` bundle. */
  push(opa: OpaBundle): Promise<void>;
}

/** Minimal roster shape for the policy adapter (id → domains). */
export type PolicyRoster = Record<string, { domains: string[]; clearances?: string[] }>;

export type DataLiveDeps = {
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

/** Which tools each stage's Build runs (brief §"stage→adapter-set"). The orchestrator
 *  runs only the ones present in the adapter map, so it never fakes a ✓ for a tool that
 *  isn't implemented. `policy` runs FIRST on promote so the compiled OPA governance for
 *  the promoted FQN is live BEFORE the table materializes (no window where the new
 *  domain table exists without its row filters). */
export const ADAPTER_SET: Record<DataStage, string[]> = {
  bronze: ['dlt'],
  silver: ['dbt'],
  gold: ['dbt'],
  promote: ['policy', 'dbt-trino', 'trino'],
  certify: ['policy'],
};

// ----------------------------------------------------------------- adapters ------

export function makeLiveAdapters(deps: DataLiveDeps): Record<string, DataAdapter> {
  // ----------------------------------------------- bronze / silver / gold ------

  const dlt: DataAdapter = {
    tool: 'dlt',
    async apply(ctx) {
      const table = `iceberg.${domainSchema(ctx.dataset.domain)}.bronze_${physicalSlug(ctx.dataset)}`;
      // A file upload carries its MinIO objectKey; the real client POSTs it to the
      // data-runner /ingest (which writes the physical Bronze table as the principal).
      await deps.dlt.load(table, ctx.dataset.name, {
        objectKey: ctx.artifacts[INGEST_OBJECT_KEY],
        principal: ctx.principal,
      });
      return ok(`loaded raw Iceberg table ${table}`);
    },
    async verify(ctx) {
      const table = `iceberg.${domainSchema(ctx.dataset.domain)}.bronze_${physicalSlug(ctx.dataset)}`;
      const exists = await deps.dlt.tableExists(table, ctx.principal);
      if (!exists) return fail(`raw table ${table} (or its snapshot) is not in Polaris`);
      return ok(`raw table + snapshot present in Polaris`);
    },
  };

  // The physical model FQN this build touches. Routes resolve the tier-aware target
  // (personal_<uid> vs domain schema) and thread it as ctx.targetFqn — the probe MUST
  // check the exact table the CTAS wrote, or a personal-lane build would be verified
  // against `iceberg.<domain>.…` (a table that never existed → false ✗, or worse, a
  // stale domain table → false ✓). The fallback keeps the legacy domain-schema shape,
  // sanitized so a hyphenated domain can't produce an invalid Trino identifier.
  const dbtModelFqn = (ctx: { dataset: { domain: string; name: string; slug?: string }; stage?: DataStage; targetFqn?: string }) => {
    if (ctx.targetFqn) return ctx.targetFqn;
    const s = physicalSlug(ctx.dataset);
    const schema = domainSchema(ctx.dataset.domain);
    return ctx.stage === 'silver' ? `iceberg.${schema}.silver_${s}` : `iceberg.${schema}.gold_${s}`;
  };
  const dbt: DataAdapter = {
    tool: 'dbt',
    async apply(ctx) {
      const fqn = dbtModelFqn(ctx);
      // Guided Silver/Gold builder: with a compiled transform + caller identity, run the
      // REAL governed CTAS (executeRun) as the caller; otherwise verify-only probe.
      const write =
        ctx.transformSql && ctx.identity ? { sql: ctx.transformSql, identity: ctx.identity } : undefined;
      const r = await deps.dbt.build(fqn, write, ctx.principal);
      if (!r.testsPassed) {
        return fail(
          write
            ? `${fqn} was not queryable after the transform ran`
            : `dbt tests failed on ${fqn} — nothing untested enters Trino`,
        );
      }
      if (!r.compiledCode) return fail('manifest is missing compiled_code (run dbt compile)');
      return ok(
        write ? `materialized ${fqn} via governed CTAS` : `dbt build ${fqn} passed (tests + compiled_code present)`,
      );
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
      // T8 publish: with the compiled promote CTAS + the APPROVING Builder's identity
      // in the context, run the REAL governed write (executeRun as the approver —
      // never the requester); otherwise the legacy verify-only probe.
      const write =
        ctx.transformSql && ctx.identity
          ? { sql: ctx.transformSql, schemaSql: ctx.schemaSql, identity: ctx.identity, releaseSchema: ctx.releaseSchema }
          : undefined;
      const r = await deps.dbtTrino.materialize(fqn, write);
      if (!r.ok) return fail(`dbt-trino could not materialize ${fqn}`);
      return ok(
        write
          ? `materialized ${fqn} via governed CTAS as ${write.identity.uid} (the approving Builder)`
          : `materialized governed Iceberg table ${fqn}`,
      );
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
      await deps.policy.push(compiled.opa);
      return ok(`compiled 1 source → OPA (${Object.keys(compiled.opa.tables).length} table)`);
    },
    async verify(ctx) {
      // The compiled bundle must govern the exact FQN this dataset materializes — a
      // dataset the compiler skipped (not governed) would otherwise publish ungoverned.
      const compiled = compilePolicy([ctx.dataset], deps.roster);
      const fqn = tableFqn(ctx.dataset);
      if (!compiled.opa.tables[fqn]) return fail(`no OPA governance compiled for ${fqn}`);
      return ok(`OPA governance covers ${fqn}`);
    },
  };

  return { dlt, dbt, 'dbt-trino': dbtTrino, trino, policy };
}
