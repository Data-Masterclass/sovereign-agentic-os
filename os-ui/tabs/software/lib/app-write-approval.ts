/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An approved app write runs
 * USER STORY: As a user whose app action was held for approval, I want it to happen once an
 *             approver says yes, and as the approver I want the inbox to say whether it ran,
 *             including when the app was deleted or is no longer allowed to do it.
 * ARCHITECTURE:
 *   - Registered into core's app-write port (`@core/policy/app-write-port`) at boot by the
 *     entrypoint, so the approve effect can run it without core importing this tab.
 *   - Runs through `callAppTool` itself, with `approved: true`: the closed-name guard, the
 *     declared-action layers, the app's grant and its compiled profile are re-checked as of now;
 *     only the hold is lifted, because a human just decided it. The app's records are written
 *     as the user who made the call, exactly as the call would have written them.
 *   - Every failure is a reason, never a throw: a deleted app, a now-refused gate, an app that
 *     is not running, an app that answered with `ok:false`.
 */
import 'server-only';
import { callAppTool } from '@tabs/software/lib/app-tool-call';
import { getAppByIdInternal, type App } from '@tabs/software/lib/apps';
import type { AdoptionPort } from '@tabs/software/lib/app-actions';
import type { AppWriteOutcome, AppWriteRequest } from '@core/policy/app-write-port';

export type AppWriteApprovalDeps = {
  /** The domain-adoption layer for declared actions (the connections tab's store). Absent ⇒ none adopted. */
  adoption?: AdoptionPort;
  getApp?: (appId: string) => Promise<App | null>;
  call?: typeof callAppTool;
};

export async function applyApprovedAppWrite(req: AppWriteRequest, deps: AppWriteApprovalDeps = {}): Promise<AppWriteOutcome> {
  const app = await (deps.getApp ?? getAppByIdInternal)(req.appId);
  if (!app) {
    return { ok: false, reason: `the app ${req.appId} this write was for has been deleted. Nothing was written.` };
  }
  const call = deps.call ?? callAppTool;
  try {
    const out = await call(
      app,
      req.tool,
      req.args,
      req.requestedBy,
      { tool: req.tool, args: req.args, approved: true },
      { id: req.requestedBy, domain: app.domain },
      deps.adoption,
      { approved: true },
    );
    if (out.status !== 200) {
      const why = typeof out.body.reason === 'string' && out.body.reason ? out.body.reason : 'the app gate refused it';
      return { ok: false, reason: `“${app.name}” may no longer run ${req.tool}: ${why}. Nothing was written.` };
    }
    const result = out.body.result as { ok?: unknown; reason?: unknown; error?: unknown } | undefined;
    if (result && result.ok === false) {
      const why = typeof result.reason === 'string' ? result.reason : typeof result.error === 'string' ? result.error : 'no reason given';
      return { ok: false, reason: `“${app.name}” answered that ${req.tool} failed: ${why}` };
    }
    return { ok: true, reason: `${req.tool} ran on “${app.name}” for ${req.requestedBy}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
