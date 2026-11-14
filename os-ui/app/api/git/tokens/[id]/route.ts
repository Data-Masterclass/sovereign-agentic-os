/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Revoke one of the caller's OWN personal access tokens. Someone else's id is a 404, never a 403 —
 * a 403 would confirm it exists. A SHELL over `core/auth/access-tokens-store.ts`.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { ensureHydrated, revokeAccessToken } from '@core/auth/access-tokens-store';

export const dynamic = 'force-dynamic';

export const DELETE = withRoute<{ id: string }>(
  async ({ user, params }) => NextResponse.json({ record: revokeAccessToken(user.id, params.id) }),
  { hydrate: ensureHydrated, defaultStatus: 500 },
);
