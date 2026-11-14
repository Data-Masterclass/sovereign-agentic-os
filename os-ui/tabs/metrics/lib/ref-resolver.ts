/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The Metrics tab's governed-id resolver for the git receive gate
 * USER STORY: As an analytics engineer pushing a dashboard-as-code file I want `metric:<id>` to
 *             resolve to the member I can actually see, so a push binds to the number I meant and
 *             a metric outside my entitlement refuses loudly instead of rebinding (D29, E9).
 * ARCHITECTURE:
 *   - NIGHT-2 MERGE (E x D x M). The Dashboards tab's ingest needs a metric's member; a tab may not
 *     import another tab, so the kernel hosts the seam (`core/infra/git-receive.ts`
 *     `registerGovernedRefResolver`) and this file is the Metrics half of it. One line in
 *     `instrumentation.ts` joins them.
 *   - VISIBILITY IS THE STORE'S: it resolves through `getMetric(id, caller)`, so a metric the
 *     caller cannot see is indistinguishable from one that does not exist. This module adds no
 *     second visibility rule and no fallback.
 *   - Only `metric:<id>` is claimed. Anything else is `null`, which the importer turns into a
 *     refusal naming the ref — never a guess.
 */
import { registerGovernedRefResolver, type Pusher } from '@core/infra/git-receive';
import { getMetric } from '@tabs/metrics/lib/store';

/** `metric:<id>` → the canonical member, as `caller` may see it. `null` = not found / not visible. */
export function resolveMetricRef(ref: string, caller: Pusher): { member: string } | null {
  const id = /^metric:(.+)$/.exec(String(ref ?? '').trim())?.[1];
  if (!id) return null;
  try {
    return { member: getMetric(id, { id: caller.id, domains: caller.domains, role: caller.role }).member };
  } catch {
    return null;
  }
}

/** Install it with the receive gate. Idempotent; called from the boot step. */
export function installGovernedRefResolver(): void {
  registerGovernedRefResolver(resolveMetricRef);
}
