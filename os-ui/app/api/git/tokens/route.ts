/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The caller's OWN personal access tokens. GET lists them (prefix + metadata, never the hash or
 * the token); POST mints one and returns the plaintext EXACTLY ONCE — this response is the only
 * place it ever exists. A SHELL over `core/auth/access-tokens-store.ts`.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { createAccessToken, ensureHydrated, listAccessTokens, MAX_TTL_DAYS } from '@core/auth/access-tokens-store';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async ({ user }) => NextResponse.json({ tokens: listAccessTokens(user.id), maxTtlDays: MAX_TTL_DAYS }), {
  hydrate: ensureHydrated,
  defaultStatus: 500,
});

export const POST = withRoute<Record<string, string>, { name?: unknown; ttlDays?: unknown }>(
  async ({ user, body }) => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'a token needs a name — you will see it in the list, not the token' }, { status: 400 });
    const ttlDays = typeof body.ttlDays === 'number' && Number.isFinite(body.ttlDays) ? body.ttlDays : undefined;
    const minted = createAccessToken({ userId: user.id, name, ttlDays });
    return NextResponse.json({ token: minted.token, record: minted.record, shownOnce: true }, { status: 201 });
  },
  { parse: true, hydrate: ensureHydrated, defaultStatus: 500 },
);
