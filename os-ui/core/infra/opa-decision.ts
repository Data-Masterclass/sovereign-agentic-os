/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OPA decision metadata — the `decision_id` and `policy_rev` of each decision
 * USER STORY: As an auditor I want every governed effect to name the exact OPA decision-log line
 *             and policy revision behind it, so "why was this allowed?" has an answer.
 * ARCHITECTURE:
 *   - `decision_id` comes from the Data API response; `policy_rev` from `GET /v1/config` labels,
 *     cached (success and failure) so authorise never waits on it.
 */
import { opaGetConfig } from '@core/adapters/opa/client';

/**
 * What OPA itself says about a decision, so an audit entry can point at the exact
 * decision-log line (04 M1):
 *  - `decisionId` — the `decision_id` OPA returns in the Data API response when
 *    decision logging is on (https://www.openpolicyagent.org/docs/rest-api).
 *  - `policyRev` — the `labels.policy_rev` of the running OPA, read from its Config API
 *    (`GET /v1/config`); the chart sets it to the revision of the policies + data and
 *    OPA stamps the same label on every decision-log entry.
 * Both are absent (never invented) when OPA did not provide them.
 */
export type DecisionMeta = { decisionId?: string; policyRev?: string };

export function decisionIdOf(body: unknown): string | undefined {
  const id = (body as { decision_id?: unknown } | null)?.decision_id;
  return typeof id === 'string' && id ? id : undefined;
}

/** A successful read is reused for this long (the label changes only on a pod roll). */
const REV_TTL_MS = 30_000;
/** After a failed read, skip `policyRev` for this long instead of retrying on every decision. */
const REV_FAIL_TTL_MS = 30_000;
let revCache: { until: number; rev: string | undefined } | null = null;

/** The running OPA's `labels.policy_rev`, or undefined when OPA did not provide it. At most one
 *  `GET /v1/config` per TTL, whether it succeeded or failed, so authorise never waits on it. */
export async function opaPolicyRev(): Promise<string | undefined> {
  if (revCache && Date.now() < revCache.until) return revCache.rev;
  const rev = await readPolicyRev();
  revCache = { until: Date.now() + (rev ? REV_TTL_MS : REV_FAIL_TTL_MS), rev };
  return rev;
}

async function readPolicyRev(): Promise<string | undefined> {
  const r = await opaGetConfig(2000);
  if (!r.ok || !r.value.defined) return undefined;
  const rev = (r.value.value as { labels?: { policy_rev?: unknown } } | undefined)?.labels?.policy_rev;
  return typeof rev === 'string' && rev ? rev : undefined;
}

/** Test-only: forget the cached revision. */
export function __resetPolicyRevCache(): void {
  revCache = null;
}

/** Decision metadata for an OPA Data API response body. */
export async function decisionMeta(body: unknown): Promise<DecisionMeta> {
  const decisionId = decisionIdOf(body);
  if (!decisionId) return {};
  const policyRev = await opaPolicyRev();
  return policyRev ? { decisionId, policyRev } : { decisionId };
}
