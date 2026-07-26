/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session.ts';

/**
 * The `Principal` every tab store scopes on. Structurally identical across the
 * Data and Files stores (both `{ id; domains; role }`), so the shared server
 * boundary can produce it once and each tab re-exports its own alias.
 */
export type Principal = { id: string; domains: string[]; role: Role };

/**
 * Shared server boundary for tab routes: turn the signed-in user into the
 * `Principal` the (pure, testable) stores scope on, and fold any thrown
 * error — which carries an HTTP `status` — into a JSON response.
 *
 * The one thing tabs differ on is WHICH per-process `ensureHydrated()` runs
 * before the first read/write (Data hydrates the dataset cache, Files the file
 * cache). That is passed in as a `hydrate` hook so behavior stays EXACTLY per
 * tab while the boundary logic lives in one place.
 */
export function makeRequirePrincipal(hydrate: () => Promise<void>) {
  return async function requirePrincipal(): Promise<Principal> {
    const u = await requireUser();
    // Hydrate the tab's cache from the durable mirror once per process, before
    // any read/write — so a restarted os-ui serves the persisted records.
    // Idempotent + graceful when OpenSearch is off.
    await hydrate();
    return { id: u.id, domains: u.domains, role: u.role };
  };
}

export function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}
