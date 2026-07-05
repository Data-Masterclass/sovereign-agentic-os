/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { ensureHydrated, type Principal } from '@/lib/agents/store';

/**
 * Server boundary for the Agents tab routes: turn the signed-in user into the
 * `Principal` the (pure, testable) store scopes on, and hydrate the agent-system
 * cache from the durable mirror once per process — so a restarted os-ui serves
 * the persisted agent systems (agent loss-on-deploy fix). Mirrors lib/data/server.ts.
 */
export async function requirePrincipal(): Promise<Principal> {
  const u = await requireUser();
  await ensureHydrated();
  return { id: u.id, domains: u.domains, role: u.role };
}

export function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number }).status ?? 400;
  return NextResponse.json({ error: (e as Error).message }, { status });
}
