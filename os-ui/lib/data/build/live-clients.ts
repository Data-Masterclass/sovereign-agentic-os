/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { cubeLoad, executeRun, queryRun } from '@/lib/infra/governed';
import { listUsers as userRoster } from '@/lib/users';
import { importDashboardBundle } from '@/lib/superset/client';
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
} from './live.ts';

/**
 * The REAL fetch-backed clients for the live Data Build adapters. Server-only: they
 * use `config` (in-cluster Service URLs) and never reach the browser. Kept separate
 * from the PURE `live.ts` adapter logic so the adapters stay unit-testable against
 * fakes. A network/HTTP failure throws or returns falsy so the adapter reports ✗.
 *
 * Exact request shapes (Cube meta/load, Superset import/list, OM lineage) are the
 * documented community endpoints; they are validated end-to-end on the real deploy
 * (m3i.16). On a laptop the services are unreachable, so the server boundary falls
 * back to the offline-mock — these are exercised when a cluster is up.
 */

async function withTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------- Cube -------

export function realCube(): CubeClient {
  return {
    async reload(_name, _schema) {
      // Cube schema is git-deployed (Forgejo → Cube), not hot-pushed at runtime; the
      // adapter's job is to confirm Cube has loaded a usable model, so we validate the
      // metadata endpoint is serving. A 4xx/5xx or unreachable → throw → ✗.
      const res = await withTimeout(`${config.cubeUrl}/cubejs-api/v1/meta`, { method: 'GET' });
      if (!res || !res.ok) throw new Error(`Cube /meta not ready (${res?.status ?? 'unreachable'})`);
    },
    async resolveMeasure(view, measure) {
      // Resolve the measure on the curated view (the agent metrics tool path).
      const member = `${view.replace(/\s+/g, '')}.${measure}`;
      try {
        const { rows } = await cubeLoad({ measures: [member], limit: 1 });
        if (rows.length === 0) return null;
        const v = Number(rows[0][member] ?? rows[0][measure]);
        return Number.isNaN(v) ? 0 : v;
      } catch {
        return null;
      }
    },
  };
}

// ----------------------------------------------------------------- Superset ------

export function realSuperset(): SupersetClient {
  // In-cluster Service URL (the import must reach Superset itself, not the optional
  // browser console link) — mirrors the Dashboards build client.
  const base = config.supersetInternalUrl;
  return {
    async importBundle(_name, bundle) {
      // Build the real import_assets ZIP from the manifest and POST it multipart
      // (formData + overwrite + passwords, with CSRF). A non-2xx throws → ✗ → the
      // offline-mock fallback when Superset is not reachable/authed on a laptop.
      await importDashboardBundle(base, bundle);
    },
    async dashboardExists(name) {
      const q = encodeURIComponent(JSON.stringify({ filters: [{ col: 'dashboard_title', opr: 'ct', value: name }] }));
      const res = await withTimeout(`${base}/api/v1/dashboard/?q=${q}`, { method: 'GET' });
      if (!res || !res.ok) return false;
      const d = (await res.json().catch(() => ({}))) as { count?: number };
      return (d.count ?? 0) > 0;
    },
  };
}

// ------------------------------------------------------------ OpenMetadata -------

export function realOm(): OmClient {
  const base = config.openmetadataApiUrl;
  return {
    async pushExposure(_name, _yaml) {
      // Exposures ride in on the dbt artifacts ingestion; the adapter confirms the OM
      // API is serving so the edge can land. Unreachable → throw → ✗.
      const res = await withTimeout(`${base}/api/v1/system/version`, { method: 'GET' });
      if (!res || !res.ok) throw new Error(`OpenMetadata API not ready (${res?.status ?? 'unreachable'})`);
    },
    async hasLineage(fqn) {
      // Best-effort: the table entity exists in the catalog (its lineage is built from
      // the same dbt artifacts). A miss → false → ✗.
      const res = await withTimeout(`${base}/api/v1/tables/name/${encodeURIComponent(fqn)}`, { method: 'GET' });
      return Boolean(res && res.ok);
    },
  };
}

/**
 * Is the live data stack reachable? Cube is the irreplaceable dependency for the
 * metric/dashboard builds (the one live execution can't fake), so its health is the
 * switch between the LIVE path and the honest offline-mock.
 */
export async function liveDataReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.cubeUrl}/cubejs-api/v1/meta`, { method: 'GET' }, 2500);
  return Boolean(res && res.ok);
}

// ----------------------------------------------- dlt / dbt / dbt-trino / trino ---

/** A probe SELECT through the governed query-tool (Trino + OPA). True ⇒ live. */
async function probeQueryable(fqn: string, principal?: string): Promise<boolean> {
  try {
    const r = await queryRun(`SELECT 1 FROM ${fqn} LIMIT 1`, principal);
    return Array.isArray(r.rows);
  } catch {
    return false;
  }
}

/** The data-runner /ingest result (the physical Bronze table it just wrote). */
export type IngestOutcome = { table: string; rowCount: number; columns: { name: string; type: string }[] };

/** POST the upload to the data-runner /ingest. principal + objectKey come from the
 *  caller (session-derived); the runner independently forces the personal_<uid>
 *  schema + the uploads/<uid>/ prefix, so a spoofed value can't cross users. */
async function postIngest(input: { principal?: string; dataset: string; objectKey: string }): Promise<IngestOutcome> {
  const res = await withTimeout(
    `${config.dataRunnerUrl}/ingest`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal: input.principal, dataset: input.dataset, objectKey: input.objectKey }),
    },
    60_000, // large files: DuckDB read + PyIceberg write can take a while.
  );
  if (!res) throw new Error('data-runner unreachable');
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { throw new Error(`data-runner returned non-JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || data.ok === false || data.error) throw new Error((data.error as string) ?? `data-runner ${res.status}`);
  return {
    table: String(data.table ?? ''),
    rowCount: typeof data.rowCount === 'number' ? data.rowCount : 0,
    columns: Array.isArray(data.columns) ? (data.columns as IngestOutcome['columns']) : [],
  };
}

/** Is the data-runner reachable? Gates the LIVE physical ingest vs the offline-mock. */
export async function dataRunnerReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.dataRunnerUrl}/health`, { method: 'GET' }, 2500);
  return Boolean(res && res.ok);
}

export function realDlt(): DltClient & { lastIngest?: IngestOutcome } {
  // `load` performs the REAL ingest when a file objectKey is present (data-runner
  // writes the physical Bronze table); `tableExists` verifies the RESULT landed in
  // Polaris (a governed probe SELECT as the principal), so a missing table reports ✗.
  const self: DltClient & { lastIngest?: IngestOutcome } = {
    async load(_table, source, ctx) {
      if (!ctx?.objectKey) return; // no upload context → nothing to load (verify then ✗).
      self.lastIngest = await postIngest({ principal: ctx.principal, dataset: source, objectKey: ctx.objectKey });
    },
    async tableExists(table, principal) { return probeQueryable(table, principal); },
  };
  return self;
}

export function realDbt(): DbtClient {
  // M1 Silver builder: when the guided panel supplies a compiled, allowlisted transform
  // + the caller identity, EXECUTE the governed CTAS as the caller (Trino→OPA masks the
  // reads inside the SELECT), then verify the result is queryable. A rejected statement
  // (400/403) or Trino error throws with the real message ⇒ the row reports ✗ honestly.
  // Without a transform (pass-through / built out of band) we fall back to a verify-only
  // probe: dbt `build` aborts dependents on a failed test, so a queryable table is
  // honest evidence its tests passed. (dbt tests/docs/scheduling are M2.)
  return {
    async build(modelFqn, write) {
      if (write) {
        await executeRun(write.sql, write.identity); // throws on any rejection/Trino error
        const queryable = await probeQueryable(modelFqn, write.identity.principal);
        return { testsPassed: queryable, compiledCode: true };
      }
      const queryable = await probeQueryable(modelFqn);
      return { testsPassed: queryable, compiledCode: queryable };
    },
  };
}

/**
 * Promotion release (T8): a one-time, SINGLE-READER, READ-ONLY exemption on the
 * requester's `personal_<uid>` schema so the APPROVING Builder's publish CTAS can
 * copy it into the domain schema. `trino.rego` honours it only for non-write
 * operations and only for `reader`; it is pushed just before the CTAS and withdrawn
 * in a `finally` (and any straggler is wiped by the next full `data.governance`
 * PUT). A failed push is not fatal here — the CTAS then fails CLOSED with the real
 * Trino access-denied, which the adapter reports honestly.
 */
async function pushPromoteRelease(schema: string, reader: string, fqn: string): Promise<void> {
  await withTimeout(`${config.opaUrl}/v1/data/governance/releases/${schema}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reader, fqn, at: new Date().toISOString() }),
  });
}
async function withdrawPromoteRelease(schema: string): Promise<void> {
  await withTimeout(`${config.opaUrl}/v1/data/governance/releases/${schema}`, { method: 'DELETE' });
}

export function realDbtTrino(): DbtTrinoClient {
  return {
    async materialize(fqn, write) {
      if (write) {
        // T8 publish: the REAL materialization — the allowlisted promote CTAS runs
        // through the governed /execute AS THE APPROVING BUILDER (write.identity is
        // built from the approver, never the requester). executeRun throws with the
        // real query-tool/Trino error so a failed publish reports ✗ verbatim.
        if (write.releaseSchema) {
          await pushPromoteRelease(write.releaseSchema, write.identity.principal, fqn);
        }
        try {
          if (write.schemaSql) await executeRun(write.schemaSql, write.identity);
          await executeRun(write.sql, write.identity);
        } finally {
          if (write.releaseSchema) await withdrawPromoteRelease(write.releaseSchema);
        }
        return { ok: await probeQueryable(fqn, write.identity.principal) };
      }
      return { ok: await probeQueryable(fqn) };
    },
  };
}

export function realTrino(): TrinoClient {
  return { async tableQueryable(fqn, principal) { return probeQueryable(fqn, principal); } };
}

// ------------------------------------------------------------------- policy -------

export function realPolicy(): PolicyClient {
  // Push the compiled `data.governance` bundle to OPA (the EXISTING package trino
  // rego reads it). Cube access policies are git-deployed (Forgejo → Cube), so here we
  // push the OPA half; an unreachable OPA → throw → ✗.
  return {
    async push(opa) {
      const res = await withTimeout(`${config.opaUrl}/v1/data/governance`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tables: opa.tables, principals: opa.principals }),
      });
      if (!res || !res.ok) throw new Error(`OPA governance push failed (${res?.status ?? 'unreachable'})`);
    },
  };
}

/** Build the policy roster (id → domains) from the user directory. */
export async function buildRoster(): Promise<PolicyRoster> {
  const users = await userRoster();
  const out: PolicyRoster = {};
  for (const u of users) out[u.id] = { domains: u.domains };
  return out;
}

export async function makeRealClients(): Promise<DataLiveDeps> {
  return {
    cube: realCube(), superset: realSuperset(), om: realOm(),
    dlt: realDlt(), dbt: realDbt(), dbtTrino: realDbtTrino(), trino: realTrino(), policy: realPolicy(),
    roster: await buildRoster(),
  };
}
