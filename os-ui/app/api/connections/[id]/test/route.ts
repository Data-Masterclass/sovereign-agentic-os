/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { rateLimit } from '@core/kernel/ratelimit';
import { testConnection } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

/** Tests one user may run on one connection per minute (each one calls the remote service). A route may export only its handlers. */
const CONNECTION_TEST_LIMIT = 5;

/** Test a connection inline. The secret is read server-side and never returned. Throttled per user and connection. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const rl = rateLimit(`connection-test:${user.id}:${id}`, CONNECTION_TEST_LIMIT, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { ok: false, state: 'not_verified', code: 'rate_limited', error: `Too many tests of this connection — at most ${CONNECTION_TEST_LIMIT} a minute.`, hint: `Wait ${rl.retryAfter} s, then test again.` },
        { status: 429, headers: { 'retry-after': String(rl.retryAfter) } },
      );
    }
    const result = await testConnection(id, user);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
