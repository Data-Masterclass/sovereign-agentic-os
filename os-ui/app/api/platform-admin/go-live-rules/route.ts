/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    API — Platform → Go-live rules (App Builder F): read the global go-live rule table, change rows
 * USER STORY: As a platform admin I read who must review going live per kind and scope and change a row; a non-admin
 *             gets 403 and changes nothing; while the App Builder is off the route answers `app_builder_disabled`.
 * ARCHITECTURE: thin. `appBuilderDisabledResponse()` first (flag off ⇒ 403 typed, nothing read), then `adminCtx()`
 *             (401/403, tenant pin). The write additionally needs the OPA admin decision (like the tool consoles);
 *             validation, the seal, the confirmed write and the audit row are in core/policy/go-live-rules-store.ts.
 *             The MCP twins are `get_go_live_rules` / `set_go_live_rules` (core/mcp/governance-tools.ts).
 */
import { NextResponse } from 'next/server';
import { authorize } from '@core/infra/governed';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { readGoLiveRules, setGoLiveRules } from '@core/policy/go-live-rules-store';
import { GO_LIVE_KINDS, GO_LIVE_SCOPES, REVIEWERS } from '@core/policy/go-live-rules';
import { adminCtx, fail } from '../_ctx';

export const dynamic = 'force-dynamic';

export async function GET() {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  try {
    await adminCtx();
    const state = await readGoLiveRules();
    return NextResponse.json({ ...state, kinds: GO_LIVE_KINDS, scopes: GO_LIVE_SCOPES, reviewers: REVIEWERS });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: Request) {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  try {
    const { user } = await adminCtx();
    // Changing who reviews a go-live is a governed write: the OPA decision must allow it (unreachable OPA follows
    // OPA_FAIL_OPEN), unlike the adminCtx() read, which only reports OPA.
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: 'forbidden', policy: authz.policy }, { status: 403 });
    let body: { rules?: unknown; expectedVersion?: unknown } | null;
    try {
      body = (await req.json()) as typeof body;
    } catch (err) {
      return NextResponse.json({ error: 'not JSON', detail: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    const saved = await setGoLiveRules({
      rules: body?.rules,
      expectedVersion: body?.expectedVersion,
      actor: { id: user.id, role: user.role },
      opa: { decisionId: authz.decisionId, policyRev: authz.policyRev },
      via: 'ui',
    });
    return NextResponse.json({ ...saved, kinds: GO_LIVE_KINDS, scopes: GO_LIVE_SCOPES, reviewers: REVIEWERS });
  } catch (e) {
    return fail(e);
  }
}
