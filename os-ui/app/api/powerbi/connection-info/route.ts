/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { errorResponse } from '@/lib/data/server';
import { config } from '@/lib/core/config';
import { connectionInfoForDomain, type SqlApiExposure } from '@/lib/powerbi/connection-info';

export const dynamic = 'force-dynamic';

/**
 * Governed "Connect Power BI" info for a builder's OWN domain. Returns the exact
 * PostgreSQL connection fields (server/port/database/user) for the per-domain read-only
 * BI principal that Cube's SQL API resolves to that domain's securityContext (→ Trino/OPA
 * RLS). The PASSWORD IS NEVER RETURNED: only a `password.secretName` reference (the vault
 * / k8s Secret the operator hands to the report author). The requester must belong to the
 * domain; a domain they aren't a member of is rejected (403) so one domain can't discover
 * another's principal.
 *
 * ?domain=<id> selects which of the caller's domains to describe; defaults to the first.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const requested = new URL(req.url).searchParams.get('domain');
    const domain = requested ?? user.domains[0];
    if (!domain) {
      const err = new Error('No domain in scope') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    if (!user.domains.includes(domain)) {
      const err = new Error(`Not a member of domain '${domain}'`) as Error & { status?: number };
      err.status = 403;
      throw err;
    }

    const exposure: SqlApiExposure = {
      enabled: config.cubeSqlApiEnabled,
      host: config.cubeSqlHost,
      port: config.cubeSqlPort,
      passwordSecretName: config.cubeSqlPasswordSecret,
    };
    return NextResponse.json(connectionInfoForDomain(domain, exposure));
  } catch (e) {
    return errorResponse(e);
  }
}
