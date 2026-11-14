/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The ONE endpoint every `git push` passes (decision D28). A SHELL:
 * `core/infra/git-receive-server.ts` decides, `core/infra/git-receive.ts` holds the lock and
 * ingests. Authenticated on every phase by the pusher's own OS access token, which the hook
 * forwards as `x-os-git-authorization` — see that module's header for why.
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { principalById } from '@core/kernel/auth';
import { ensureHydrated } from '@core/auth/access-tokens-store';
import { handleReceive, type ReceiveBody } from '@core/infra/git-receive-server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  await ensureHydrated();
  const body = (await req.json().catch(() => ({}))) as ReceiveBody;
  const result = await handleReceive(
    body,
    {
      gitAuthorization: req.headers.get('x-os-git-authorization'),
      authorization: req.headers.get('authorization'),
    },
    {
      lookup: principalById,
      principalIds: async () => {
        // The personal-lane collision guard (review M-7). A core module may not import a tab, so
        // the directory is read here and passed in.
        const { listUsers } = await import('@tabs/admin/lib/users');
        return (await listUsers()).filter((u) => !u.disabled).map((u) => u.id);
      },
      serviceBearerToken: config.serviceBearerToken,
    },
  );
  return new NextResponse(result.body, { status: result.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
