/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import {
  getTileOrder,
  setTileOrder,
  ORDER_LIMIT,
  TILE_ORDER_SURFACES,
  type TileOrderSurface,
} from '@/lib/prefs/tile-order';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

function validSurface(s: unknown): s is TileOrderSurface {
  return (TILE_ORDER_SURFACES as readonly string[]).includes(s as string);
}

/** Max length of a single tile id — real ids are ~20 chars; 256 is generous. */
const ID_MAX = 256;

/**
 * Sanitize a client-supplied order array: strings only, trimmed, non-empty,
 * capped per-id length, deduped, sliced to ORDER_LIMIT. Defense in depth on
 * top of applyTileOrder's own dedupe — garbage never reaches the store/mirror.
 */
function sanitizeOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || id.length > ID_MAX || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ORDER_LIMIT) break;
  }
  return out;
}

/**
 * GET /api/prefs/tile-order?surface=strategy.pillars
 * Returns { order: string[] } — the session user's saved tile order for the
 * given surface. Returns { order: [] } if nothing saved yet. 400 on unknown
 * surface, 401 if unauthenticated.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const surface = req.nextUrl.searchParams.get('surface') ?? '';
    if (!validSurface(surface)) {
      return NextResponse.json({ error: `Unknown surface: "${surface}"` }, { status: 400 });
    }
    const order = await getTileOrder(user.id, surface);
    return NextResponse.json({ order });
  } catch (e) {
    return fail(e);
  }
}

/**
 * PUT /api/prefs/tile-order
 * Body: { surface: TileOrderSurface; order: string[] }
 * Persists the session user's tile order for the given surface.
 * The userId always comes from the session — never from the body.
 * 400 on unknown surface, 401 if unauthenticated.
 */
export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const surface = body?.surface ?? '';
    if (!validSurface(surface)) {
      return NextResponse.json({ error: `Unknown surface: "${surface}"` }, { status: 400 });
    }
    await setTileOrder(user.id, surface, sanitizeOrder(body?.order));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
