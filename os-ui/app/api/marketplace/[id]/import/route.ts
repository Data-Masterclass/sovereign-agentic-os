/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { importAdapter, type Viewer, type ImportMode } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/**
 * Import a product → a governed grant. Body: { mode?, as? }.
 *   - read-grant types: a per-viewer RLS grant (auto-granted if open, else held
 *     in Governance).
 *   - fork/template/instance: a derived owned artifact (+ grant record).
 * `as` is the domain to import INTO (for multi-domain users).
 */
export const POST = withRoute<{ id: string }, { mode?: ImportMode; as?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role, activeDomain: body.as };
  const result = await importAdapter.import(id, viewer, body.mode);
  return NextResponse.json(result, { status: result.pending ? 202 : 201 });
}, { parse: true, defaultStatus: 500 });
