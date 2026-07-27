/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/data/server';
import { getDataset, builtLayerFqn } from '@/lib/data/store';
import { queryRun } from '@/lib/infra/governed';
import { assistantComplete } from '@/lib/assistant/complete';
import { roleModel } from '@/lib/models/roles';
import { proposeFixes } from '@/lib/data/dq-fix-server';

export const dynamic = 'force-dynamic';

/**
 * PROPOSE AI remediations for ONE failing quality rule (Validate stage).
 *
 * POST { checkId } → the propose envelope: the rule re-run for real (pass ⇒ nothing
 * invented), a failing-rows sample (honest "showing N of M"), and — when the model is
 * reachable — a guard-validated proposal: batch (one column transform, previewed
 * before→after with a MEASURED residual) or per-row fixes (only when the dataset
 * DECLARES a unique key column and ≤200 rows fail; identity is never guessed), or an
 * honest `kind:'none'` diagnosis. Model unconfigured/over-cap/unreachable ⇒
 * `offline:true` — the run results stay real, nothing is faked.
 *
 * READ + advice only: canView gate (getDataset), reads AS the builtLayerFqn resolver's
 * principal (OPA-governed), and NOTHING is written — apply is its own edit-gated door.
 * The reasoning model establishes the pattern; the standard model fills per-row values
 * (roleModel split through the ONE audited, cost-capped assistantComplete).
 */
export const POST = withRoute<{ id: string }, { checkId?: string }>(async ({ user, params, body }) => {
  const dataset = getDataset(params.id, user); // canView gate (403/404)
  const checkId = (body.checkId ?? '').trim();
  const check = (dataset.checks ?? []).find((c) => c.id === checkId);
  if (!check) return NextResponse.json({ error: 'unknown check' }, { status: 404 });

  const resolved = builtLayerFqn(dataset, user);
  const envelope = await proposeFixes(dataset, check, {
    fqn: resolved?.fqn ?? null,
    layer: resolved?.layer ?? null,
    queryFn: (sql) => queryRun(sql, resolved?.principal),
    complete: async (messages, role) =>
      (
        await assistantComplete(messages, {
          user: { id: user.id, domains: user.domains },
          model: roleModel(role),
        })
      ).content,
  });
  return NextResponse.json(envelope);
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
