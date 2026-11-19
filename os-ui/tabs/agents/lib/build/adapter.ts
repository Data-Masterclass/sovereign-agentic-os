/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System } from '@tabs/agents/lib/system-schema';
import { type IR } from '@tabs/agents/lib/langgraph-compile';

/**
 * The ONE Build adapter interface (Approach A). Pressing Build runs each tool's
 * adapter: `apply` performs the real setup (LangGraph reload, LiteLLM key+routing,
 * OPA policy, Langfuse project), then `verify` runs a probe
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
  /**
   * What `apply` actually DID, so a rebuild that finishes in a blink is understandable:
   *   `created`   — the thing did not exist and was made now;
   *   `updated`   — it existed and differed from the definition; it was changed (the detail says how);
   *   `unchanged` — it existed and already matched; nothing was written;
   *   `reapplied` — the step has no "already matches" check: it was written/computed again.
   * Set by `apply` only; `verify` never changes anything.
   */
  change?: BuildChange;
};

export type BuildChange = 'created' | 'updated' | 'unchanged' | 'reapplied';

export type BuildContext = {
  system: System;
  ir: IR;
  /** The system id / repo, for adapters that need to address a store. */
  systemId?: string;
  /** A test prompt for the verify invocation/routing probe. */
  probe?: string;
};

export interface BuildAdapter {
  /** Tool key shown in the Build table: langgraph | litellm | opa | langfuse. */
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
  /** What apply did (see {@link StepResult.change}); absent on a row that failed before applying. */
  change?: BuildChange;
  /** Apply's own sentence — WHAT was created or changed ("updated key …: tokens/min 200000 → 1000000"). */
  appliedDetail?: string;
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
    // What apply did survives the verify (whose detail used to overwrite it): the row says both
    // what was done and what was then checked.
    const did = ap.change ? { change: ap.change, appliedDetail: ap.detail } : {};
    const vr = await adapter.verify(ctx);
    verified = vr.ok;
    detail = vr.detail || detail;
    if (!vr.ok) {
      error = vr.error ?? 'verify failed';
      return { tool: adapter.tool, applied, verified, status: 'fail', detail, error, ...did };
    }
    // A NEUTRAL pending verify (ok:true, pending:true) is NOT a failure: the setup
    // applied, but the probe needs a prior run to observe. Surface it as its own
    // status so the report/UI never renders it as ✗.
    if (vr.pending) {
      return { tool: adapter.tool, applied, verified: false, status: 'pending', detail, ...did };
    }
    return { tool: adapter.tool, applied, verified, status: 'ok', detail, ...did };
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
