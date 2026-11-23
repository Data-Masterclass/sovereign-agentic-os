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
 *   - Revocation: a dataset moved back to My gets the compiler's closed `private` entry for its
 *     table (`closedEntryFor`), so its last entry — possibly `public` — is overwritten, never left.
 *     The same entry is in every compile, the os-data bundle included.
 */
import 'server-only';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { compileOpa, tableFqn, type OpaBundle, type Roster } from '@tabs/data/lib/policy/compiler';
import { record as auditRecord } from '@core/policy/audit';
import { bundledWritesServedHere } from '@core/policy/opa-publish';
import { config } from '@core/kernel/config';
import { setDatasetPolicyPushPort } from '@tabs/data/lib/store';

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
  // compileOpa emits the closed entry for a dataset back in My (see `closedEntryFor`).
  return compileOpa([d], roster);
}

/**
 * In BUNDLE mode (`OS_OPA_DATA_BUNDLE`) OPA refuses REST writes under the os-data roots; a governance
 * write only reaches OPA through os-ui's bundle recompile. A process that does not serve the bundle
 * (the agent-runs worker) would see its write "accepted" and dropped — so it is refused here, typed,
 * and the caller shows that the change reaches OPA at os-ui's next bundle resync (≤ 60 s).
 */
export function assertPushReachesOpa(bundleMode = config.opaDataBundle, servedHere = bundledWritesServedHere()): void {
  if (bundleMode && !servedHere) {
    throw new Error('bundle mode: this process does not serve the os-data bundle, so the change reaches OPA at os-ui’s next bundle resync (within 60 s), not immediately');
  }
}

async function liveDeps(): Promise<PolicyPushDeps> {
  const { realPolicy, buildRoster } = await import('@tabs/data/lib/build/live-clients');
  return {
    push: async (opa) => { assertPushReachesOpa(); await realPolicy().push(opa); },
    roster: buildRoster,
  };
}

/**
 * Wire the immediate push into the data store's write path. Called at BOTH boots — os-ui
 * (`opa-state-sources.ts`) and the agent-runs worker (`worker/agent-runs.ts`) — so a certify /
 * decertify / unshare decided in either process pushes at once. `deps` is for tests only.
 */
export function wireDatasetPolicyPush(deps?: PolicyPushDeps): void {
  setDatasetPolicyPushPort((d, actor, via) => pushDatasetPolicyNow(d, actor, via, deps));
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
