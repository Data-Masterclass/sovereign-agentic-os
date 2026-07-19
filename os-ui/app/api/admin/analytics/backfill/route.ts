/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { realForgejo } from '@/lib/agents/build/live-clients';
import { listGovernedDatasets } from '@/lib/data/store';
import { writeAnalyticsFiles } from '@/lib/data/analytics-repo';
import type { ForgejoClient } from '@/lib/infra/forgejo';

export const dynamic = 'force-dynamic';

/**
 * Admin-only analytics-repo BACKFILL (#146 enabler).
 *
 * The Cube sidecar serves N models (static demo cubes + runtime `northpeak_*`
 * cubes). Before Cube-serving can be flipped to git, git must hold ALL of them.
 * This endpoint force-writes the desired analytics-repo file set for EVERY
 * governed dataset and RETURNS the write summary so an operator can verify each
 * runtime cube landed in git.
 *
 * Unlike the fire-and-forget `syncAnalyticsRepo`, this AWAITS `writeAnalyticsFiles`
 * and reports the result. It is honest: if Forgejo is unreachable it returns 503
 * with the reason — it never fabricates success.
 *
 * The underlying writer returns `void`, so we wrap the real ForgejoClient in a
 * thin recording proxy: every `writeFile` is captured and bucketed by repo path
 * (`cube/…` → cube models, `dbt/…` → dbt models). This adds observability
 * WITHOUT touching the pure writer module.
 */

/** Buckets of repo-relative paths actually written, by artifact kind. */
type WriteLog = { cube: string[]; dbt: string[]; other: string[] };

/**
 * Wrap a ForgejoClient so every `writeFile` path is recorded and bucketed.
 * `readFile` passes through unchanged (diff-write reads existing content first,
 * so an unchanged file is never counted as "written").
 */
function recordingForgejo(inner: ForgejoClient, log: WriteLog): ForgejoClient {
  return {
    ensureRepo: (repo) => inner.ensureRepo(repo),
    readFile: (repo, path) => inner.readFile(repo, path),
    async writeFile(repo, path, content, sha, message) {
      const res = await inner.writeFile(repo, path, content, sha, message);
      if (path.startsWith('cube/')) log.cube.push(path);
      else if (path.startsWith('dbt/')) log.dbt.push(path);
      else log.other.push(path);
      return res;
    },
    deleteRepo: (repo) => inner.deleteRepo(repo),
    listCommits: (repo, opts) => inner.listCommits(repo, opts),
    getCommitFiles: (repo, sha) => inner.getCommitFiles(repo, sha),
  };
}

export async function POST() {
  // 1. Admin-only — authoritative 401 (anon) / 403 (non-admin) gate.
  try {
    await requireAdmin();
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  // 2. Reachability probe — the real client swallows unreachability into `null`
  //    on reads, so probe explicitly and fail loudly (503) rather than silently
  //    "succeeding" with zero writes when Forgejo is down. `ensureRepo` is
  //    idempotent (409-tolerant on the real client), so probing it is safe.
  const forgejo = realForgejo();
  try {
    await forgejo.ensureRepo('analytics');
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'Forgejo unreachable', reason: (e as Error).message },
      { status: 503 },
    );
  }

  // 3. Backfill EVERY governed dataset, AWAITING the result (not fire-and-forget).
  const datasets = listGovernedDatasets();
  const log: WriteLog = { cube: [], dbt: [], other: [] };
  const errors: string[] = [];
  try {
    await writeAnalyticsFiles(recordingForgejo(forgejo, log), datasets, 'admin-backfill');
  } catch (e) {
    // A write failed mid-way — surface it honestly. Whatever landed before the
    // throw is still reported so the operator sees partial progress.
    errors.push((e as Error).message);
    return NextResponse.json(
      {
        ok: false,
        datasets: datasets.length,
        cubeModelsWritten: log.cube,
        dbtModelsWritten: [...log.dbt, ...log.other],
        errors,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    datasets: datasets.length,
    cubeModelsWritten: log.cube,
    dbtModelsWritten: [...log.dbt, ...log.other],
    errors,
  });
}
