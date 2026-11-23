/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The immediate OPA governance push when a dataset's audience tier changes
 * USER STORY: As a member of any domain I want a dataset certified to Company to be queryable by me
 *             at once, and as its owner I want a decertify / unshare to close Trino at once — not at
 *             the next reconcile tick — and if that push fails I want to be told, not left guessing.
 * ARCHITECTURE:
 *   - Owner decision 2026-11-23 (PR #333): the Trino side of a tier change is IMMEDIATE, through
 *     the EXISTING policy push path — `compileOpa` (the same compiler a build uses) → the build's
 *     `PolicyClient.push` (`realPolicy()`, i.e. `governanceWrites` → `publishOpaAll`). No new
 *     mechanism; the periodic OPA reconcile (`opa-state.ts`) stays the safety net.
 *   - Wired by the data store's ONE write path (`persist` → the policy-push port), so no certify /
 *     decertify / unshare caller — route, MCP tool, approval door — can skip it. Callers read the
 *     outcome with `awaitDatasetPolicyPush(id)` and put it in their result.
 *   - A failure is TYPED (`code: 'policy_push_failed'`), VISIBLE (a `warning` sentence every result
 *     surface shows) and AUDITED (`policy.push.failed`), never silent.
 *   - Revocation: a dataset moved back to My is no longer governed by the compiler (`governanceFor`
 *     → null), which would leave its last entry — possibly `public` — in OPA. So the push writes a
 *     closed `private` entry for its table instead, which can only narrow.
 */
import 'server-only';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { compileOpa, tableFqn, type OpaBundle, type Roster } from '@tabs/data/lib/policy/compiler';
import { record as auditRecord } from '@core/policy/audit';

export type PolicyPushOutcome =
  | { ok: true; fqn: string; visibility: string }
  | { ok: false; code: 'policy_push_failed'; fqn: string; visibility: string; detail: string; warning: string };

export type PolicyPushDeps = {
  push: (opa: OpaBundle) => Promise<void>;
  roster: () => Promise<Roster>;
};

/** The governance bundle one dataset's tier change must push: its compiled entry, or (back in My) a
 *  closed entry for its table, plus the principals the compiler emits. */
export function bundleForTierChange(d: Dataset, roster: Roster): OpaBundle {
  const bundle = compileOpa([d], roster);
  const fqn = tableFqn(d);
  if (!bundle.tables[fqn]) {
    bundle.tables[fqn] = { domain: d.domain, visibility: 'private', shared_with: [], shared_with_users: [], sensitive_columns: {} };
    if (d.domain && !bundle.principals[d.domain]) bundle.principals[d.domain] = { domains: [d.domain], clearances: [] };
  }
  return bundle;
}

async function liveDeps(): Promise<PolicyPushDeps> {
  const { realPolicy, buildRoster } = await import('@tabs/data/lib/build/live-clients');
  return { push: (opa) => realPolicy().push(opa), roster: buildRoster };
}

/** Push one dataset's governance to OPA NOW. Never throws: a failure is returned typed and audited. */
export async function pushDatasetPolicyNow(d: Dataset, actor: string, via: string, deps?: PolicyPushDeps): Promise<PolicyPushOutcome> {
  const fqn = tableFqn(d);
  let visibility = 'unknown';
  try {
    const dd = deps ?? (await liveDeps());
    const bundle = bundleForTierChange(d, await dd.roster());
    visibility = bundle.tables[fqn]?.visibility ?? 'unknown';
    await dd.push(bundle);
    return { ok: true, fqn, visibility };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const warning =
      `The access policy for “${d.name}” could not be updated in the query engine right away (${detail}). ` +
      'Queries keep the previous access until the automatic policy reconcile retries (within minutes).';
    try {
      auditRecord({
        actor,
        action: 'policy.push.failed',
        subject: `dataset:${d.id} (${d.name})`,
        domain: d.domain,
        reason: `${via}: immediate OPA governance push for ${fqn} (${visibility}) failed — ${detail}`,
        detail: { kind: 'dataset', id: d.id, fqn, visibility, via, error: detail },
      });
    } catch (ae) {
      console.error(`[policy-push] audit of ${d.id} failed: ${ae instanceof Error ? ae.message : String(ae)}`);
    }
    console.error(`[policy-push] ${d.id} ${fqn}: ${detail}`);
    return { ok: false, code: 'policy_push_failed', fqn, visibility, detail, warning };
  }
}
