/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { errorResponse } from '@/lib/data/server';
import { config } from '@/lib/core/config';
import { buildPbids, pbidsToString, pbidsFilename } from '@/lib/powerbi/pbids';

export const dynamic = 'force-dynamic';

/**
 * Governed one-click Power BI connect: returns a `.pbids` (Power BI Data Source) file
 * that opens directly in Power BI Desktop with the Cube SQL API pre-configured.
 *
 * The caller must belong to the requested domain; a domain they aren't a member of is
 * rejected (403) so one domain can't discover another's connection endpoint.
 *
 * Password handling:
 *   The .pbids file contains NO password — Power BI prompts the user for it. The shared
 *   `bi_<domain>` SQL password is retrieved out-of-band from the vault / k8s Secret
 *   (the `connection-info` endpoint explains how to get it). This route is intentionally
 *   incapable of leaking credentials.
 *
 * RLS:
 *   When Power BI connects using the `bi_<domain>` username, Cube's `checkSqlAuth`
 *   maps it to the domain's securityContext (lib/powerbi/principal.ts). Every query runs
 *   through Trino with OPA enforcing the domain boundary — the caller sees only their
 *   domain's rows, regardless of which metric or view they query.
 *
 * SQL API availability:
 *   If `CUBE_SQL_API_ENABLED` is false (the default until the operator opens the port),
 *   the route returns 503. The UI surfaces an honest "not yet available" state instead
 *   of offering a file that points at a closed port.
 *
 * ?domain=<id> — selects which of the caller's domains to generate for; defaults to first.
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
    if (!config.cubeSqlApiEnabled) {
      const err = new Error(
        'The Cube SQL API is not enabled on this instance. Ask your platform admin to set CUBE_SQL_API_ENABLED=true and configure an external ingress for the SQL API port.',
      ) as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    const pbids = buildPbids(domain, config.cubeSqlHost, config.cubeSqlPort);
    const body = pbidsToString(pbids);
    const filename = pbidsFilename(domain);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // The `.pbids` extension triggers Power BI Desktop to open it directly.
        'Content-Disposition': `attachment; filename="${filename}"`,
        // No caching — connection details can change if the operator updates the host/port.
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
