/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset, buildVersion } from '@/lib/data/store';
import { stepperStages, stageArtifact, canBuildStage } from '@/lib/data/panels';
import { buildStage } from '@/lib/data/build/server';
import { silverPlan, type TransformOp } from '@/lib/data/transform';
import { rematerializeDomainTableLive } from '@/lib/data/publish-server';
import { roleAtLeast } from '@/lib/core/session';
import type { ExecuteIdentity } from '@/lib/infra/governed';

export const dynamic = 'force-dynamic';

/**
 * Silver builder — REAL transform via a governed CTAS. The guided panel sends the
 * cleaning ops; here we (server-authoritatively) compile them into ONE allowlisted
 * `CREATE OR REPLACE TABLE … AS SELECT` targeting the CALLER's own schema, then run it
 * through the Build adapter (dbt.apply = executeRun as the caller → Trino→OPA masks the
 * reads) followed by the verify probe. The Silver version is registered — and its dot
 * lit — ONLY when the Build report is ✓; a rejected statement or Trino error is
 * surfaced verbatim (honest ✗), and no version is recorded.
 *
 * The client-sent SQL is NEVER trusted: we recompile from the ops. Identity is derived
 * from the signed session, never the request body.
 */
export const POST = withRoute<{ id: string }, { ops?: TransformOp[]; columns?: string[] }>(async ({ user, params, body }) => {
  const { id } = params;
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const ops = Array.isArray(body.ops) ? body.ops : [];

  const dataset = getDataset(id, user); // view-scope guard
  if (!canBuildStage(dataset.versions, 'silver')) {
    return NextResponse.json({ error: 'Bring in the Bronze version before cleaning it' }, { status: 400 });
  }

  const identity: ExecuteIdentity = {
    principal: user.domains[0] ?? user.id,
    uid: user.id,
    domains: user.domains,
    role: user.role,
  };

  // Compile server-side (throws TransformError → 400 with the real reason).
  const plan = silverPlan(dataset, identity, columns, ops);

  // The build ALWAYS runs in the caller's personal lane now (silverSchema): that is
  // where Bronze physically lives, for every tier. It must run under the UID (not the
  // domain principal) so Trino→OPA recognises the caller as the `personal_<uid>` owner.
  if (plan.schema.startsWith('personal_')) identity.principal = user.id;

  // Execute + verify through the Build adapter (live when reachable, else offline-mock).
  const build = await buildStage(dataset, 'silver', identity.principal, {
    transformSql: plan.sql,
    identity,
    // Probe the exact table the CTAS wrote (personal vs domain schema).
    targetFqn: plan.target,
  });

  if (!build.ok) {
    const failed = build.rows.find((r) => r.status === 'fail');
    return NextResponse.json(
      { build, sql: plan.sql, target: plan.target, error: failed?.error ?? 'Silver build did not pass' },
      { status: 200 },
    );
  }

  // ✓ only: register the Silver version + persist the compiled SQL as its artifact.
  // Quality stays 'unknown' — the table is materialized + queryable, but dbt
  // data-quality tests are M2 (no faked green check).
  const updated = buildVersion(id, user, 'silver', {
    quality: 'unknown',
    artifact: stageArtifact(dataset.name, 'silver'),
    body: plan.sql,
  });

  // The domain-copy contract (same as the Gold rebuild): buildVersion just flagged an
  // already-promoted dataset STALE — this rebuild rewrote only the owner's personal
  // lane. When SILVER is the published layer (no Gold on top) a Builder+'s rebuild
  // refreshes the governed domain table in the same act. With a Gold on top the
  // refresh belongs to the Gold rebuild — publishing now would copy the still-stale
  // personal Gold — so it stays honestly STALE with the reason saying what to do.
  let domainTable: { state: 'refreshed' | 'stale' | 'not-promoted'; fqn?: string; reason?: string } =
    { state: 'not-promoted' };
  if (updated.tier !== 'dataset') {
    if (!updated.versions.gold.built && roleAtLeast(user.role, 'builder')) {
      try {
        const out = await rematerializeDomainTableLive(id, user);
        domainTable = out.ok
          ? { state: 'refreshed', fqn: out.fqn }
          : { state: 'stale', fqn: out.fqn, reason: out.error };
      } catch (e) {
        domainTable = { state: 'stale', reason: e instanceof Error ? e.message : String(e) };
      }
    } else {
      domainTable = {
        state: 'stale',
        reason: updated.versions.gold.built
          ? 'Rebuild Gold to refresh the shared domain table (Gold is the published layer).'
          : 'Rebuilt by a creator — a Builder must re-promote to refresh the shared domain table.',
      };
    }
  }

  const finalDataset = domainTable.state === 'refreshed' ? getDataset(id, user) : updated;
  return NextResponse.json({ build, sql: plan.sql, target: plan.target, dataset: finalDataset, domainTable, stages: stepperStages(finalDataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
