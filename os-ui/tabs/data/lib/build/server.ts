/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type Dataset, type Layer, type Quality } from '@tabs/data/lib/dataset-schema';
import { type DataStage } from '@tabs/data/lib/build/adapter';
import type { ExecuteIdentity } from '@core/infra/governed';
import { orchestrateStage, type DataBuildReport } from '@tabs/data/lib/build/orchestrate';
import { makeMockAdapters, newMockBackends } from '@tabs/data/lib/build/mocks';
import { makeRealClients, queryToolReachable, probeQueryable } from '@tabs/data/lib/build/live-clients';
import { makeLiveAdapters } from '@tabs/data/lib/build/live';
import { buildVersion, type Principal } from '@tabs/data/lib/store';
import { stageArtifact } from '@tabs/data/lib/panels';
import { layerTarget, passThroughPlan, resolvePassThroughSource } from '@tabs/data/lib/transform';

/**
 * Server boundary for a Data Build (mirrors lib/agents/build/server.ts). It runs the
 * stage's adapter-set against the LIVE services when the governed query path is
 * reachable, or the honest in-process OFFLINE-MOCK otherwise — labelled either way.
 * Same adapter logic both paths, so a ✓ always means a real apply+verify passed.
 */
export type BuildMode = 'live' | 'offline-mock';

export async function buildStage(
  dataset: Dataset,
  stage: DataStage,
  principal?: string,
  /** The guided Silver/Gold builder passes the compiled CTAS + caller identity so the
   *  dbt adapter runs a REAL governed write; the promote publish (T8) additionally
   *  passes the domain-schema DDL + the personal source schema to release read-only.
   *  Omitted ⇒ the existing verify-only path. */
  write?: { transformSql?: string; identity?: ExecuteIdentity; schemaSql?: string; releaseSchema?: string; targetFqn?: string },
): Promise<DataBuildReport & { mode: BuildMode }> {
  const ctx = {
    dataset,
    artifacts: {},
    principal,
    transformSql: write?.transformSql,
    identity: write?.identity,
    schemaSql: write?.schemaSql,
    releaseSchema: write?.releaseSchema,
    targetFqn: write?.targetFqn,
  };
  // The live/offline switch probes the service every stage ACTUALLY depends on: the
  // governed query-tool (Trino) the CTAS/probes run through.
  if (await queryToolReachable()) {
    const report = await orchestrateStage(stage, ctx, makeLiveAdapters(await makeRealClients()));
    return { ...report, mode: 'live' };
  }
  const report = await orchestrateStage(stage, ctx, makeMockAdapters(newMockBackends()));
  return { ...report, mode: 'offline-mock' };
}

export type CommitVersionOutcome = {
  ok: boolean;
  /** Present for Silver/Gold (the materialize-or-probe run); absent for Bronze. */
  build?: DataBuildReport & { mode: BuildMode };
  /** The updated dataset — ONLY when the version was actually registered. */
  dataset?: Dataset;
  error?: string;
};

/**
 * Commit one medallion version HONESTLY — the ONE path the version route and the
 * MCP `add_dataset_version` share. Bronze is recorded as before (its physical
 * honesty gate lives in the ingest pipeline, which registers only on apply+verify).
 * Silver/Gold are the fix for the stale-"built" bug: the flag is set ONLY after a
 * real materialization/probe of the tier-aware physical target —
 *   • pass-through  → a REAL governed CTAS copy of the prior layer
 *                     (`CREATE OR REPLACE TABLE <layer> AS SELECT * FROM <prior>`),
 *   • authored body → a verify-only probe that the target table is queryable
 *                     (built out of band ⇒ it must actually exist).
 * A ✗ report registers NOTHING (no dot without a queryable table); offline the
 * adapters degrade to the honestly-labelled offline-mock, same as every build.
 */
export async function commitLayerVersion(
  dataset: Dataset,
  layer: Layer,
  user: Principal,
  opts: { passThrough?: boolean; body?: string; quality?: Quality },
): Promise<CommitVersionOutcome> {
  const passThrough = Boolean(opts.passThrough);
  if (layer === 'bronze') {
    const updated = buildVersion(dataset.id, user, 'bronze', {
      quality: opts.quality,
      passThrough: false,
      artifact: stageArtifact(dataset.name, 'bronze'),
      body: opts.body,
    });
    return { ok: true, dataset: updated };
  }

  const identity: ExecuteIdentity = {
    principal: user.domains[0] ?? user.id,
    uid: user.id,
    domains: user.domains,
    role: user.role,
  };
  const target = layerTarget(dataset, identity, layer);
  // Personal-lane tables are owner-read-only in Trino→OPA: run the CTAS/probe AS
  // the uid, not the domain principal (same rule as the transform route).
  if (target.includes('.personal_')) identity.principal = user.id;

  // Resolve the physical write. A pass-through copies the prior layer forward — but the
  // prior layer must ACTUALLY exist: the original seed / an out-of-band authored table
  // can leave a layer "built" in the registry with no queryable table (the cause of a
  // raw TABLE_NOT_FOUND when Gold blindly read a phantom silver_). We probe reality and
  // carry the newest lower layer that exists, adopt an already-materialized target, or
  // fail with a clear message — never a raw Trino error. (Offline keeps the honest mock.)
  let write: { transformSql?: string; identity?: ExecuteIdentity; targetFqn?: string };
  if (passThrough && (await queryToolReachable())) {
    const res = await resolvePassThroughSource(dataset, identity, layer as 'silver' | 'gold', (fqn) =>
      probeQueryable(fqn, identity.principal),
    );
    if (res.kind === 'none') {
      const lower = layer === 'gold' ? 'Bronze or Silver' : 'Bronze';
      return {
        ok: false,
        error: `Nothing to pass through into ${layer} for “${dataset.name}”: no ${lower} table exists yet, and no ${layer} table is present to adopt. Build a lower layer first, or author the ${layer} SQL.`,
      };
    }
    // `copy` runs a governed CTAS of the resolved source; `adopt` registers the
    // already-materialized target verify-only (honest — it is queryable).
    write = res.kind === 'copy' ? { transformSql: res.sql, identity, targetFqn: target } : { targetFqn: target };
  } else if (passThrough) {
    write = { transformSql: passThroughPlan(dataset, identity, layer).sql, identity, targetFqn: target };
  } else {
    // Authored body: verify-only probe of the out-of-band target (unchanged).
    write = { targetFqn: target };
  }
  const build = await buildStage(dataset, layer, identity.principal, write);
  if (!build.ok) {
    const failed = build.rows.find((r) => r.status === 'fail');
    return { ok: false, build, error: failed?.error ?? `${layer} was not materialized — nothing registered` };
  }

  const updated = buildVersion(dataset.id, user, layer, {
    quality: opts.quality,
    passThrough,
    // Pass-through keeps no own artifact; an authored layer points at its native file.
    artifact: passThrough ? null : stageArtifact(dataset.name, layer),
    body: passThrough ? undefined : opts.body,
  });
  return { ok: true, build, dataset: updated };
}
