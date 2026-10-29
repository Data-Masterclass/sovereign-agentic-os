/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { executeRun, queryRun } from '@core/infra/governed';
import { serviceBearerHeader } from '@core/infra/service-bearer';
import { listUsers as userRoster } from '@tabs/admin/lib/users';
import {
  type DataLiveDeps,
  type DbtClient,
  type DbtTrinoClient,
  type DltClient,
  type PolicyClient,
  type PolicyRoster,
  type TrinoClient,
} from '@tabs/data/lib/build/live';

/**
 * The REAL fetch-backed clients for the live Data Build adapters. Server-only: they
 * use `config` (in-cluster Service URLs) and never reach the browser. Kept separate
 * from the PURE `live.ts` adapter logic so the adapters stay unit-testable against
 * fakes. A network/HTTP failure throws or returns falsy so the adapter reports ✗.
 * On a laptop the services are unreachable, so the server boundary falls back to the
 * offline-mock — these are exercised when a cluster is up.
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

/**
 * Is the governed WRITE path (query-tool → Trino) reachable? Every stage's real work is
 * a governed CTAS/probe through the query-tool, so this is the switch between the LIVE
 * path and the honest offline-mock — it probes the service the build actually writes through.
 */
export async function queryToolReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.queryToolUrl}/health`, { method: 'GET' }, 2500);
  return Boolean(res && res.ok);
}

// ----------------------------------------------- dlt / dbt / dbt-trino / trino ---

/** A probe SELECT through the governed query-tool (Trino + OPA). True ⇒ live. */
export async function probeQueryable(fqn: string, principal?: string): Promise<boolean> {
  try {
    const r = await queryRun(`SELECT 1 FROM ${fqn} LIMIT 1`, principal);
    return Array.isArray(r.rows);
  } catch {
    return false;
  }
}

/** Read a single `count(*)` scalar from a governed probe. Returns null when the
 *  query can't run (table absent, not-yet-created, or an OPA/Trino error) so the
 *  guard treats "unknown" as "not a populated target" and proceeds. */
async function countRows(sql: string, principal: string | undefined, run: typeof queryRun): Promise<number | null> {
  const r = await run(sql, principal);
  const cell = r.rows?.[0]?.[0];
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}

/**
 * Guard 1 (belt-and-suspenders): refuse to let a `CREATE OR REPLACE TABLE <fqn> AS
 * <select>` blow away a POPULATED table with a 0-row result. The verify runs AFTER
 * the replace, so without this a compiled SELECT that (via a bug/regression) yields
 * 0 rows would silently zero-out real data. Pre-flight, under the SAME identity:
 *   1. if the target already has count(*) > 0, AND
 *   2. `count(*) FROM (<select>)` is 0
 * → ABORT before executing. A fresh target (probe fails/0) or a >0-row select proceeds.
 *
 * Dependency-injected `run` (defaults to the governed queryRun) keeps it unit-testable.
 * Any probe error is swallowed as "unknown" → proceed, so the guard never turns a
 * transient probe failure into a false abort (the CTAS + its post-verify still run).
 */
export async function assertNoZeroRowReplace(
  ctasSql: string,
  principal: string | undefined,
  run: typeof queryRun = queryRun,
): Promise<void> {
  const m = /^\s*create\s+or\s+replace\s+table\s+(\S+)\s+as\s+([\s\S]+)$/i.exec(ctasSql);
  if (!m) return; // not a create-or-replace CTAS → nothing to guard
  const [, fqn, select] = m;
  let existing: number | null;
  try {
    existing = await countRows(`SELECT count(*) FROM ${fqn}`, principal, run);
  } catch {
    return; // target absent / not readable yet → fresh replace, proceed
  }
  if (existing === null || existing <= 0) return; // fresh or empty target → proceed
  let incoming: number | null;
  try {
    incoming = await countRows(`SELECT count(*) FROM (${select})`, principal, run);
  } catch {
    return; // can't evaluate the select count → don't block the real CTAS + its verify
  }
  if (incoming === 0) {
    throw new Error(
      `refusing to replace populated table ${fqn} with a 0-row result (${existing} existing row(s) would be lost)`,
    );
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
      headers: { 'content-type': 'application/json', ...serviceBearerHeader() },
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
        // Guard 1: never let a compiled CTAS zero-out a populated table.
        await assertNoZeroRowReplace(write.sql, write.identity.principal);
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
          // Guard 1: never let the publish CTAS zero-out a populated domain table.
          await assertNoZeroRowReplace(write.sql, write.identity.principal);
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
  // rego reads it); an unreachable OPA → throw → ✗.
  return {
    async push(opa) {
      // `tables` is fully recomputed each compile, so a wholesale replace is correct.
      // `principals` is an UPSERT-per-key merge, NOT a wholesale replace: a full PUT
      // here used to clobber the statically-seeded domain self-principals (which are
      // not in the user roster), collapsing every domain-session row filter to []
      // → ZERO rows (the empty-scorecard bug). Writing each principal to its own path
      // only ever adds/updates — it can never delete a principal this push didn't compute.
      const put = async (path: string, body: unknown) => {
        const res = await withTimeout(`${config.opaUrl}/v1/data/${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res || !res.ok) throw new Error(`OPA governance push failed at ${path} (${res?.status ?? 'unreachable'})`);
      };
      await put('governance/tables', opa.tables);
      for (const [id, p] of Object.entries(opa.principals)) {
        await put(`governance/principals/${encodeURIComponent(id)}`, p);
      }
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
    dlt: realDlt(), dbt: realDbt(), dbtTrino: realDbtTrino(), trino: realTrino(), policy: realPolicy(),
    roster: await buildRoster(),
  };
}
