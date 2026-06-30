/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import type { Principal } from '@/lib/data/store';

/**
 * Server boundary for the Data tab routes: turn the signed-in user into the
 * `Principal` the (pure, testable) store scopes on, and fold any thrown
 * Dataset/Identity error — which carries an HTTP `status` — into a JSON response.
 */
export async function requirePrincipal(): Promise<Principal> {
  const u = await requireUser();
  return { id: u.id, domains: u.domains, role: u.role };
}

export function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}
