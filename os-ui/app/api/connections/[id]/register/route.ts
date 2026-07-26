/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { registerWarehouseCatalog } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * ONE-CLICK REGISTER a warehouse connection as a live Trino catalog — merge its
 * .properties into the trino-catalog ConfigMap, materialize its secret(s) + wire the
 * Trino env, and roll the Trino Deployment. Builder/Admin with edit rights (re-gated in
 * the lib). The credential is read server-side and never returned; the response is the
 * honest per-step outcome (ok:false with the real reason on any rejection).
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const result = await registerWarehouseCatalog(id, user);
    // A registration the cluster rejected is a 502-shaped failure, surfaced honestly.
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}, { defaultStatus: 500 });
