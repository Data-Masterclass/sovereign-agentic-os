/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { refreshVendoredSdk } from '@/lib/software/server';

export const dynamic = 'force-dynamic';

/**
 * Re-vendor the OS-client SDK into an EXISTING governed-frontend app so it gains the
 * `os.records.*` write surface (new scaffolds get it automatically). Edit-scoped
 * (owner / in-domain admin, enforced in `refreshVendoredSdk`); runs the compile gate
 * on the merged tree, so a refresh never lands a non-building app. A non-frontend
 * template is a no-op (honest `skipped`, not an error).
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const out = await refreshVendoredSdk(params.id, user);
  if ('skipped' in out) return NextResponse.json({ skipped: true, reason: out.reason });
  return NextResponse.json({ ok: out.step.ok, detail: out.step.detail, mode: out.step.mode });
}, { defaultStatus: 500 });
