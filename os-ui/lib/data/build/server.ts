/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type Dataset } from '../dataset-schema.ts';
import { type DataStage } from './adapter.ts';
import type { ExecuteIdentity } from '@/lib/governed';
import { orchestrateStage, type DataBuildReport } from './orchestrate.ts';
import { makeMockAdapters, newMockBackends } from './mocks.ts';
import { makeRealClients, liveDataReachable } from './live-clients.ts';
import { makeLiveAdapters } from './live.ts';
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
  write?: { transformSql?: string; identity?: ExecuteIdentity; schemaSql?: string; releaseSchema?: string },
): Promise<DataBuildReport & { mode: BuildMode }> {
  const ctx = {
    dataset,
    artifacts: artifactsFor(dataset),
    principal,
    transformSql: write?.transformSql,
    identity: write?.identity,
    schemaSql: write?.schemaSql,
    releaseSchema: write?.releaseSchema,
  };
  if (await liveDataReachable()) {
    const report = await orchestrateStage(stage, ctx, makeLiveAdapters(await makeRealClients()));
    return { ...report, mode: 'live' };
  }
  const report = await orchestrateStage(stage, ctx, makeMockAdapters(newMockBackends()));
  return { ...report, mode: 'offline-mock' };
}
