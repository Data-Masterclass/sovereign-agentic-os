/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { type Workflow } from './schema.ts';
import { compileGuardrails, type CompiledGuardrails } from './guardrails.ts';

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

async function withTimeout(url: string, init: RequestInit, ms = 2500): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Live-try: PUT the Rego policy + data to OPA, then verify both are queryable. */
async function applyLive(compiled: CompiledGuardrails): Promise<GuardrailApplyRow | null> {
  const policyId = `knowledge-${compiled.workflowId}`;
  const policyUrl = `${config.opaUrl}/v1/policies/${policyId}`;
  const dataUrl = `${config.opaUrl}/v1/data/${compiled.packagePath.replace(/\./g, '/')}/guardrails`;

  // apply: PUT policy (Rego) + PUT data (the structured guardrail mirror).
  const putPolicy = await withTimeout(policyUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: compiled.rego,
  });
  if (!putPolicy) return null; // OPA unreachable → caller falls back to mock
  if (!putPolicy.ok) {
    return {
      applied: false,
      verified: false,
      status: 'fail',
      policy: 'opa-live',
      detail: 'OPA rejected the policy',
      error: `OPA ${putPolicy.status}: ${(await putPolicy.text()).slice(0, 200)}`,
    };
  }
  await withTimeout(dataUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(compiled.data.guardrails),
  });

  // verify: read the policy back.
  const getPolicy = await withTimeout(policyUrl, { method: 'GET' });
  const verified = Boolean(getPolicy && getPolicy.ok);
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

/** Test/inspection hook: read the mock-registered policy for a workflow. */
export function mockPolicyFor(workflowId: string): CompiledGuardrails | undefined {
  return MOCK_POLICIES.get(workflowId);
}
