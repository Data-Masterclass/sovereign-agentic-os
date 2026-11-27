/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { requireUser } from '@core/kernel/auth';
import { addSource, listSources, requireSourcesLoaded, chooseSourceConnection, CONNECTOR_TEMPLATES, type Provider, type SyncMode, type SyncScope, type SourceConnectionCandidate } from '@tabs/files/lib/connectors';
import type { Sensitivity } from '@tabs/files/lib/asset-schema';
import { listConnectionsForUser } from '@tabs/connections/lib/index';
import { offlineMockAllowed } from '@core/kernel/offline-mock';
import { providerForTemplate, filesProviderFor } from '@core/auth/providers';
import type { ConnectionTemplateKey } from '@tabs/connections/lib/schema';

export const dynamic = 'force-dynamic';

/** Connected drives: GET lists the user's sources + the available Read templates;
 *  POST connects a new source (a folder or whole drive, copy or reference). */
/** The caller's OWN personal drive connections, as candidates a source can sync with. */
async function driveConnections(user: CurrentUser): Promise<SourceConnectionCandidate[]> {
  const out: SourceConnectionCandidate[] = [];
  for (const c of await listConnectionsForUser(user)) {
    const p = c.type === 'Drive' && c.auth === 'oauth' ? providerForTemplate(c.template as ConnectionTemplateKey) : null;
    if (p && c.owner === user.id) out.push({ id: c.id, name: c.name, owner: c.owner, provider: filesProviderFor(p) });
  }
  return out;
}

export const GET = withRoute(async ({ user }) => {
  await requireSourcesLoaded();
  return NextResponse.json({ sources: listSources(user.id), templates: CONNECTOR_TEMPLATES, connections: await driveConnections(user) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

export const POST = withRoute<Record<string, string>, {
  provider?: Provider; label?: string; scope?: SyncScope; target?: string; mode?: SyncMode;
  domain?: string; connectionId?: string; landingSensitivity?: Sensitivity;
}>(async ({ user, body }) => {
  if (body.provider !== 'google-drive' && body.provider !== 'onedrive') {
    return apiError(400, 'provider must be google-drive or onedrive', 'files.providerInvalid');
  }
  // Link to a governed Connection (the OAuth Read profile that holds the token): one of the
  // caller's OWN drive connections for this provider — never someone else's credential or the
  // wrong drive. Without a link the sync has no token, so production refuses an unlinked source.
  const cu = await requireUser();
  const connectionId = chooseSourceConnection({
    provider: body.provider, userId: cu.id, requested: body.connectionId,
    candidates: await driveConnections(cu), allowUnlinked: offlineMockAllowed(),
  });
  await requireSourcesLoaded();
  const domain = body.domain && user.domains.includes(body.domain) ? body.domain : user.domains[0] ?? 'platform';
  const source = addSource({
    provider: body.provider,
    label: body.label?.trim() || (body.scope === 'drive' ? 'Whole drive' : 'Folder'),
    scope: body.scope === 'drive' ? 'drive' : 'folder',
    target: body.target?.trim() || 'root',
    mode: body.mode === 'reference' ? 'reference' : 'copy',
    owner: user.id,
    domain,
    connectionId,
    landingSensitivity: body.landingSensitivity,
  });
  return NextResponse.json({ source }, { status: 201 });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
