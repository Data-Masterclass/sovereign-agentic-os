/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type Dataset, type Layer, type Quality } from '../dataset-schema.ts';
import { type DataStage } from './adapter.ts';
import type { ExecuteIdentity } from '@/lib/governed';
import { orchestrateStage, type DataBuildReport } from './orchestrate.ts';
import { makeMockAdapters, newMockBackends } from './mocks.ts';
import { makeRealClients, liveDataReachable } from './live-clients.ts';
import { makeLiveAdapters } from './live.ts';
import { buildVersion, type Principal } from '../store.ts';
import { stageArtifact } from '../panels.ts';
import { layerTarget, passThroughPlan } from '../transform.ts';
import {
  CUBE_ARTIFACT,
  DASHBOARD_ARTIFACT,
  EXPOSURE_ARTIFACT,
  scaffoldCubeYaml,
  scaffoldDashboardBundle,
  scaffoldExposureYaml,
} from '../metrics.ts';

/**
 * Server boundary for a Data Build (mirrors lib/agents/build/server.ts). It
 * generates the stage's tool-native artifacts from the dataset, then runs the
 * stage's adapter-set against the LIVE services when the stack is reachable, or the
 * honest in-process OFFLINE-MOCK otherwise — labelled either way. Same adapter
 * logic both paths, so a ✓ always means a real apply+verify passed.
 */
export type BuildMode = 'live' | 'offline-mock';

function artifactsFor(d: Dataset): Record<string, string> {
  return {
    [CUBE_ARTIFACT(d)]: scaffoldCubeYaml(d),
    [EXPOSURE_ARTIFACT]: scaffoldExposureYaml(d),
    [DASHBOARD_ARTIFACT(d)]: scaffoldDashboardBundle(d),
  };
}

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
    artifacts: artifactsFor(dataset),
    principal,
    transformSql: write?.transformSql,
    identity: write?.identity,
    schemaSql: write?.schemaSql,
    releaseSchema: write?.releaseSchema,
    targetFqn: write?.targetFqn,
  };
  if (await liveDataReachable()) {
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

  const plan = passThrough ? passThroughPlan(dataset, identity, layer) : null;
  const build = await buildStage(dataset, layer, identity.principal, {
    transformSql: plan?.sql,
    identity: plan ? identity : undefined,
    targetFqn: target,
  });
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
