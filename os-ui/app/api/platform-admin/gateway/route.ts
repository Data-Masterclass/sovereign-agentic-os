/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/platform-admin/gateway — the LiteLLM read-mirror, for admins only.
 *
 * FEATURE:
 *   • One endpoint behind `adminCtx()` returning the whole `GatewayMirror`:
 *     models, teams, keys, guardrails, spend, drift, and how stale it is.
 *   • Always 200 when the caller is an admin. An unreachable gateway is a
 *     `degraded: true` body, not a 502 — the panels need something to render
 *     and a date to put on it.
 *
 * USER STORY:
 *   • As a platform admin, every gateway panel in the OS reads one endpoint, so
 *     four panels cost one round trip to LiteLLM, not four.
 *   • As a builder or user, I cannot reach this: spend, budgets and key aliases
 *     across the whole tenant are admin-only facts.
 *
 * ARCHITECTURE:
 *   The gate is `adminCtx()` — the same single chokepoint every other
 *   Platform-Admin route uses (role, then OPA, then tenant pin), which is also
 *   what hydrates the domain and model registries the mirror compares against.
 *   READ-ONLY: there is no POST/PATCH here by design. A write path to LiteLLM
 *   arrives in Phase 3 as its own route, so a reviewer can tell at a glance
 *   which endpoints can change the gateway.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { readMirror } from '@tabs/admin/lib/gateway-mirror';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
  } catch (e) {
    return fail(e);
  }
  // Past the gate the mirror cannot fail: it degrades instead.
  return NextResponse.json(await readMirror());
}
