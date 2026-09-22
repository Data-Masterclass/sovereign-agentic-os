/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type CubeClient,
  type DataLiveDeps,
  type DbtClient,
  type DbtTrinoClient,
  type DltClient,
  type OmClient,
  type PolicyClient,
  type PolicyRoster,
  type SupersetClient,
  type TrinoClient,
  makeLiveAdapters,
} from './live.ts';
import { type DataAdapter } from './adapter.ts';

/**
 * The honest OFFLINE-MOCK backends (kind/laptop, no services). They are real
 * in-process clients — `apply` records state, `verify` reads it back — so the SAME
 * adapter logic ({@link makeLiveAdapters}) runs against them. That guarantees the
 * mock and live paths can't drift: a metric only "resolves" if its cube was actually
 * reloaded; a table is only "queryable" if dbt-trino actually materialized it.
 */

export type MockBackends = {
  cubeSchemas: Map<string, string>;
  dashboards: Set<string>;
  exposures: Map<string, string>;
  lineage: Set<string>;
  rawTables: Set<string>;
  materialized: Set<string>;
  policyPushes: number;
  /** Publish (T8) writes the mock dbt-trino received — lets tests assert the CTAS
   *  and the APPROVING Builder's identity were threaded through the adapter. */
  publishWrites: { fqn: string; sql: string; uid: string; role: string; releaseSchema?: string }[];
};

export function newMockBackends(): MockBackends {
  return {
    cubeSchemas: new Map(), dashboards: new Set(), exposures: new Map(), lineage: new Set(),
    rawTables: new Set(), materialized: new Set(), policyPushes: 0, publishWrites: [],
  };
}

/** The default teaching roster the mock policy conformance evaluates against. */
export const MOCK_ROSTER: PolicyRoster = {
  amir: { domains: ['sales'] },
  bea: { domains: ['sales'] },
  sara: { domains: ['sales'] },
  kenji: { domains: ['finance'] },
  maria: { domains: ['finance'] },
  sam: { domains: ['sales', 'finance'] },
};

function mockCube(b: MockBackends): CubeClient {
  return {
    async reload(name, schema) { b.cubeSchemas.set(name, schema); },
    async resolveMeasure(_view, measure) {
      if (b.cubeSchemas.size === 0) return null; // resolves only after a reload
      let h = 0;
      for (let i = 0; i < measure.length; i++) h = (h * 31 + measure.charCodeAt(i)) | 0;
      return Math.abs(h % 100000);
    },
  };
}

function mockSuperset(b: MockBackends): SupersetClient {
  return {
    async importBundle(name) { b.dashboards.add(name); },
    async dashboardExists(name) { return b.dashboards.has(name); },
  };
}

function mockOm(b: MockBackends): OmClient {
  return {
    async pushExposure(name, yaml) {
      b.exposures.set(name, yaml);
      const m = /ref\('mart_([a-z0-9_]+)'\)/.exec(yaml);
      if (m) b.lineage.add(`iceberg.*.gold_${m[1]}`);
    },
    async hasLineage(fqn) {
      const m = /\.gold_([a-z0-9_]+)$/.exec(fqn);
      return m ? b.lineage.has(`iceberg.*.gold_${m[1]}`) : false;
    },
  };
}

function mockDlt(b: MockBackends): DltClient {
  return {
    async load(table) { b.rawTables.add(table); },
    async tableExists(table) { return b.rawTables.has(table); },
  };
}

function mockDbt(): DbtClient {
  // dbt is deterministic in the teaching mock: models compile and tests pass.
  return { async build() { return { testsPassed: true, compiledCode: true }; } };
}

function mockDbtTrino(b: MockBackends): DbtTrinoClient {
  return {
    async materialize(fqn, write) {
      if (write) {
        b.publishWrites.push({
          fqn, sql: write.sql, uid: write.identity.uid, role: write.identity.role, releaseSchema: write.releaseSchema,
        });
      }
      b.materialized.add(fqn);
      return { ok: true };
    },
  };
}

function mockTrino(b: MockBackends): TrinoClient {
  // Queryable only once dbt-trino has materialized it (apply→verify is a real chain).
  return { async tableQueryable(fqn) { return b.materialized.has(fqn); } };
}

function mockPolicy(b: MockBackends): PolicyClient {
  return { async push() { b.policyPushes++; } }; // signature: (opa, cube) — recorded as a count
}

export function mockDeps(b: MockBackends): DataLiveDeps {
  return {
    cube: mockCube(b), superset: mockSuperset(b), om: mockOm(b),
    dlt: mockDlt(b), dbt: mockDbt(), dbtTrino: mockDbtTrino(b), trino: mockTrino(b), policy: mockPolicy(b),
    roster: MOCK_ROSTER,
  };
}

export function makeMockAdapters(b: MockBackends): Record<string, DataAdapter> {
  return makeLiveAdapters(mockDeps(b));
}
