/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/platform-admin/providers — step 1 of the provider flow: the presets, LiteLLM's OWN provider
 * list (`/public/providers/fields`), the connections LiteLLM holds (no key, ever), the access group
 * new models join, and the hosts the egress proxy lets out. The write steps are the sibling routes
 * connections/, test/, models/; the dry-run migration is migration/. Logic: tabs/admin/lib/llm-providers.ts.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { PRESETS, providerCatalog, listConnections, accessGroup, egressAllowlist } from '@tabs/admin/lib/llm-providers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    const [catalog, conns] = await Promise.all([providerCatalog(), listConnections()]);
    return NextResponse.json({
      presets: PRESETS,
      providers: catalog.ok ? catalog.providers : [],
      connections: conns.ok ? conns.connections : [],
      gateway: catalog.ok && conns.ok ? 'reachable' : 'unreachable',
      accessGroup: accessGroup(),
      egressAllowlist: egressAllowlist(),
    });
  } catch (e) {
    return fail(e);
  }
}
