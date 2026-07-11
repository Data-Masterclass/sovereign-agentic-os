/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System } from '../system-schema.ts';
import { type IR } from '../langgraph-compile.ts';

/**
 * The ONE Build adapter interface (Approach A). Pressing Build runs each tool's
 * adapter: `apply` performs the real setup (LangGraph reload, Forgejo write,
 * LiteLLM key+routing, OPA policy, Langfuse project), then `verify` runs a probe
 * that it actually worked. Per-tool best-path; mocked in kind.
 *
 * The cardinal rule (tested): a row is ✓ ONLY when BOTH apply AND verify pass.
 * A stubbed apply that "succeeds" but whose verify probe fails surfaces ✗ — Build
 * can never report success without a passing verification.
 */

export type StepResult = {
  ok: boolean;
  detail: string;
  error?: string;
  /**
   * A NEUTRAL "not yet verifiable" outcome (NOT a failure): the component is set up
   * correctly but its verify probe needs a prior run to observe (e.g. Langfuse checks
   * a trace landed — there is none before the first invocation). `ok` stays true; the
   * row renders as pending, and pending NEVER counts as a build failure.
   */
  pending?: boolean;
};

export type BuildContext = {
  system: System;
  ir: IR;
  /** The system id / repo, for adapters that need to address a store. */
  systemId?: string;
  /** A test prompt for the verify invocation/routing probe. */
  probe?: string;
};

export interface BuildAdapter {
  /** Tool key shown in the Build table: langgraph | forgejo | litellm | opa | langfuse. */
  tool: string;
  apply(ctx: BuildContext): Promise<StepResult>;
  verify(ctx: BuildContext): Promise<StepResult>;
}

export type BuildStatus = 'ok' | 'fail' | 'pending';

export type BuildRow = {
  tool: string;
  applied: boolean;
  verified: boolean;
  status: BuildStatus;
  detail: string;
  error?: string;
};

/**
 * Run one adapter apply→verify and fold it into a single ✓/✗ row. Verify is
 * short-circuited if apply fails; any throw is caught and reported as ✗.
 */
export async function runAdapter(adapter: BuildAdapter, ctx: BuildContext): Promise<BuildRow> {
  let applied = false;
  let verified = false;
  let detail = '';
  let error: string | undefined;

  try {
    const ap = await adapter.apply(ctx);
    applied = ap.ok;
    detail = ap.detail;
    if (!ap.ok) {
      error = ap.error ?? 'apply failed';
      return { tool: adapter.tool, applied, verified, status: 'fail', detail, error };
    }
    const vr = await adapter.verify(ctx);
    verified = vr.ok;
    detail = vr.detail || detail;
    if (!vr.ok) {
      error = vr.error ?? 'verify failed';
      return { tool: adapter.tool, applied, verified, status: 'fail', detail, error };
    }
    // A NEUTRAL pending verify (ok:true, pending:true) is NOT a failure: the setup
    // applied, but the probe needs a prior run to observe. Surface it as its own
    // status so the report/UI never renders it as ✗.
    if (vr.pending) {
      return { tool: adapter.tool, applied, verified: false, status: 'pending', detail };
    }
    return { tool: adapter.tool, applied, verified, status: 'ok', detail };
  } catch (e) {
    return {
      tool: adapter.tool,
      applied,
      verified,
      status: 'fail',
      detail,
      error: (e as Error).message,
    };
  }
}
