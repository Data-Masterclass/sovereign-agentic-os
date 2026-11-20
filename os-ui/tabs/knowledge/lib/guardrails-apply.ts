/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { opaPolicyLoaded, publishOpa, publishOpaAll, type OpaWrite } from '@core/policy/opa-publish';
import type { OpaSourceResult } from '@core/policy/opa-reconcile';
import { ensureHydrated, listAllForIndex } from '@tabs/knowledge/lib/store';
import { type Workflow } from '@tabs/knowledge/lib/schema';
import { compileGuardrails, type CompiledGuardrails } from '@tabs/knowledge/lib/guardrails';

/**
 * Apply → verify a workflow's compiled guardrails to OPA. Mirrors the agents Build
 * adapter's cardinal rule: a row is ✓ ONLY when BOTH apply AND verify pass. We
 * live-try the OPA REST API (PUT the Rego policy, PUT the data, then query it);
 * when OPA is unreachable (off locally / kind) we fall back to an HONEST in-process
 * mock that registers the policy and verifies against it, clearly marked
 * `opa-unreachable` so the teaching flow runs but the report never lies.
 *
 * This is the live path the STACKIT deploy uses; the mock keeps the gate
 * demonstrable on a laptop with no cluster.
 */

export type GuardrailApplyRow = {
  applied: boolean;
  verified: boolean;
  status: 'ok' | 'fail';
  /** opa-live = enforced by a real OPA; opa-mock = offline, honest fallback. */
  policy: 'opa-live' | 'opa-mock';
  detail: string;
  error?: string;
};

export type GuardrailResult = {
  compiled: CompiledGuardrails;
  apply: GuardrailApplyRow;
};

// In-process mock OPA registry (kind-only) — the honest offline mirror.
const MOCK_POLICIES = new Map<string, CompiledGuardrails>();

/** The OPA writes carrying one workflow's compiled guardrails: the Rego module, then its data. */
function guardrailWrites(compiled: CompiledGuardrails): OpaWrite[] {
  return [
    { kind: 'policy', id: `knowledge-${compiled.workflowId}`, rego: compiled.rego },
    { kind: 'data', path: `${compiled.packagePath.replace(/\./g, '/')}/guardrails`, value: compiled.data.guardrails },
  ];
}

/** Live-try: PUT the Rego policy + data to OPA, then verify the policy is queryable. */
async function applyLive(compiled: CompiledGuardrails): Promise<GuardrailApplyRow | null> {
  const [policy, data] = guardrailWrites(compiled);
  const putPolicy = await publishOpa(policy, 2500);
  if (putPolicy.status === null) return null; // OPA unreachable → caller falls back to mock
  if (!putPolicy.ok) {
    return { applied: false, verified: false, status: 'fail', policy: 'opa-live', detail: 'OPA rejected the policy', error: putPolicy.detail };
  }
  const putData = await publishOpa(data, 2500);
  if (!putData.ok) {
    return { applied: false, verified: false, status: 'fail', policy: 'opa-live', detail: 'OPA rejected the guardrail data', error: putData.detail };
  }
  // verify: read the policy back (Policy API GET).
  const verified = await opaPolicyLoaded(`knowledge-${compiled.workflowId}`, 2500);
  return {
    applied: true,
    verified,
    status: verified ? 'ok' : 'fail',
    policy: 'opa-live',
    detail: verified
      ? `Loaded ${compiled.guardrails.length} guardrail(s) into OPA and verified the policy is live.`
      : 'Applied the policy but could not verify it is queryable.',
    ...(verified ? {} : { error: 'verify probe failed' }),
  };
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

/** Honest offline mock: register in-process, then verify the registration. */
function applyMock(compiled: CompiledGuardrails): GuardrailApplyRow {
  MOCK_POLICIES.set(compiled.workflowId, compiled);
  const back = MOCK_POLICIES.get(compiled.workflowId);
  const verified = Boolean(back && back.guardrails.length === compiled.guardrails.length);
  return {
    applied: true,
    verified,
    status: verified ? 'ok' : 'fail',
    policy: 'opa-mock',
    detail: `OPA unreachable — registered ${compiled.guardrails.length} guardrail(s) in the in-process mock and verified the registration (offline).`,
    ...(verified ? {} : { error: 'mock verify failed' }),
  };
}

/** Compile a workflow's hard rules and apply→verify them to OPA (live or mock). */
export async function applyGuardrails(workflow: Workflow): Promise<GuardrailResult> {
  const compiled = compileGuardrails(workflow);
  const live = await applyLive(compiled);
  const apply = live ?? applyMock(compiled);
  return { compiled, apply };
}

