/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { opaPolicyLoaded, publishOpa, publishOpaAll, type OpaWrite } from '@core/policy/opa-publish';
import { opaDecide } from '@core/adapters/opa/client';
import type { OpaSourceResult } from '@core/policy/opa-reconcile';
import { ensureHydrated, listAllForIndex } from '@tabs/knowledge/lib/store';
import { type Workflow } from '@tabs/knowledge/lib/schema';
import { compileGuardrails, type CompiledGuardrails } from '@tabs/knowledge/lib/guardrails';

/**
 * INTERIM (rollback path for one release, `OS_GUARDRAILS_DATA` off): apply → verify a workflow's
 * compiled guardrails to OPA by uploading its generated module and data. A row is ✓ ONLY when
 * BOTH apply AND verify pass. An unreachable OPA is a failure: nothing is enforced, so nothing is
 * reported as applied. WP-30's data path (`guardrails-data.ts`) replaces this module.
 */

export type GuardrailApplyRow = {
  applied: boolean;
  verified: boolean;
  /** ok = OPA enforces them; fail = not enforced; none = the workflow has no hard rules. */
  status: 'ok' | 'fail' | 'none';
  /** opa-live = uploaded to OPA (interim); opa-bundle = committed data in the os-data bundle (WP-30). */
  policy: 'opa-live' | 'opa-bundle';
  detail: string;
  error?: string;
};

export type GuardrailResult = {
  compiled: CompiledGuardrails;
  apply: GuardrailApplyRow;
};

/** The OPA writes carrying one workflow's compiled guardrails: the Rego module, then its data. */
function guardrailWrites(compiled: CompiledGuardrails): OpaWrite[] {
  return [
    { kind: 'policy', id: `knowledge-${compiled.workflowId}`, rego: compiled.rego },
    { kind: 'data', path: `${compiled.packagePath.replace(/\./g, '/')}/guardrails`, value: compiled.data.guardrails },
  ];
}

/** PUT the Rego policy + data to OPA, then verify the policy is queryable. Unreachable = fail. */
async function applyLive(compiled: CompiledGuardrails): Promise<GuardrailApplyRow> {
  const [policy, data] = guardrailWrites(compiled);
  const putPolicy = await publishOpa(policy, 2500);
  if (putPolicy.status === null) {
    return { applied: false, verified: false, status: 'fail', policy: 'opa-live', detail: 'OPA is unreachable: the guardrails are not enforced.', error: putPolicy.detail || 'policy_unreachable' };
  }
  if (!putPolicy.ok) {
    return { applied: false, verified: false, status: 'fail', policy: 'opa-live', detail: 'OPA rejected the policy', error: putPolicy.detail };
  }
  const putData = await publishOpa(data, 2500);
  if (!putData.ok) {
    return { applied: false, verified: false, status: 'fail', policy: 'opa-live', detail: 'OPA rejected the guardrail data', error: putData.detail };
  }
  // verify: the policy is loaded AND OPA enforces it — a clean call is allowed and a call that
  // reports the first guardrail as violated is denied. Only then is the row "enforced".
  const loaded = await opaPolicyLoaded(`knowledge-${compiled.workflowId}`, 2500);
  const enforced = loaded && (await enforces(compiled));
  return {
    applied: true,
    verified: enforced,
    status: enforced ? 'ok' : 'fail',
    policy: 'opa-live',
    detail: enforced
      ? `Loaded ${compiled.guardrails.length} guardrail(s) into OPA; OPA allows a clean call and denies a call that reports a violated guardrail.`
      : loaded
        ? 'The policy is loaded, but OPA did not deny a call that reports a violated guardrail: not enforced.'
        : 'Applied the policy but could not verify it is queryable.',
    ...(enforced ? {} : { error: loaded ? 'not enforced' : 'verify probe failed' }),
  };
}

/** Ask OPA itself: clean call → true, a reported violation of the first guardrail → false. */
async function enforces(compiled: CompiledGuardrails): Promise<boolean> {
  const first = compiled.guardrails[0]?.id;
  if (!first) return false;
  const path = `${compiled.packagePath.replace(/\./g, '/')}/allow`;
  const clean = await opaDecide(path, { violations: [] }, 2500);
  const violated = await opaDecide(path, { violations: [first] }, 2500);
  return clean.ok && clean.value.value === true && violated.ok && violated.value.defined && violated.value.value === false;
}

/**
 * OPA state SOURCE (registered in `instrumentation.ts`): re-apply every live workflow's compiled
 * guardrails after an OPA restart, with the same writes `applyGuardrails` makes. No mock here —
 * an unreachable OPA is a failed restore.
 */
export async function restoreGuardrails(): Promise<OpaSourceResult> {
  await ensureHydrated();
  let workflows = 0;
  for (const { record, workflow } of listAllForIndex()) {
    if (record.archived) continue;
    const compiled = compileGuardrails(workflow);
    if (compiled.guardrails.length === 0) continue;
    const r = await publishOpaAll(guardrailWrites(compiled));
    if (!r.ok) return { ok: false, detail: `workflow ${record.id}: ${r.detail}` };
    workflows++;
  }
  return { ok: true, detail: `${workflows} workflow(s) with guardrails` };
}

/** Compile a workflow's hard rules and apply→verify them to OPA (interim upload path). */
export async function applyGuardrails(workflow: Workflow): Promise<GuardrailResult> {
  const compiled = compileGuardrails(workflow);
  if (compiled.guardrails.length === 0) return { compiled, apply: nothingToEnforce('opa-live') };
  return { compiled, apply: await applyLive(compiled) };
}

/** A workflow with no hard rules: nothing is uploaded or checked, and the row says exactly that. */
export function nothingToEnforce(policy: GuardrailApplyRow['policy']): GuardrailApplyRow {
  return { applied: false, verified: false, status: 'none', policy, detail: 'This workflow has no hard rules, so there is nothing to enforce.' };
}

