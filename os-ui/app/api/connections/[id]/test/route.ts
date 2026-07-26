/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { testConnection } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/** Test a connection inline. The secret is read server-side and never returned. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const result = await testConnection(id, user);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
