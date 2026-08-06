/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { adoptActions, revokeActionAdoption, listAdoptions } from '@/lib/connections/action-adoptions';
import { getConnectionForUser } from '@/lib/connections/store';
import { listExposureSets } from '@/lib/connections/exposures';

export const dynamic = 'force-dynamic';

type AdoptActionsBody = {
  exposureId?: string;
  domain?: string;
  entities?: string[];
  /** Revoke path — an adoption id to soft-revoke instead of adopting. */
  revoke?: string;
};

/**
 * List the action adoptions for an exposure (the adopt-panel state). DLS-scoped (M10):
 * the route now resolves the connection AS the caller (404 if they cannot see it — no
 * existence leak) and verifies the requested `exposureId` actually belongs to THAT
 * connection before listing — the GET previously ignored `params.id` entirely, so any
 * caller could read any exposure's adoptions by id.
 */
export const GET = withRoute<{ id: string }>(async ({ req, user, params }) => {
  const url = new URL(req.url);
  const exposureId = (url.searchParams.get('exposureId') ?? '').trim();
  if (!exposureId) return NextResponse.json({ adoptions: [] });
  await getConnectionForUser(params.id, user); // 404s if the caller can't see the connection
  const owns = (await listExposureSets(params.id, user)).some((e) => e.id === exposureId);
  if (!owns) {
    return NextResponse.json({ error: 'exposure does not belong to this connection' }, { status: 404 });
  }
  return NextResponse.json({ adoptions: await listAdoptions(exposureId) });
}, { defaultStatus: 500 });

/**
 * ADOPT (or REVOKE) an exposure's entity ACTIONS for a domain (operational-system-
 * connections.md, Phase 3). `domain_admin` of the target domain (or admin) only —
 * re-gated in the lib. Adoption is the consent step that arms a domain's agents for an
 * exposure's action tools; the four-layer intersection re-checks it per call.
 */
export const POST = withRoute<{ id: string }, AdoptActionsBody>(async ({ user, params, body }) => {
  if (body.revoke) {
    const adoption = await revokeActionAdoption(body.revoke.trim(), user);
    return NextResponse.json({ adoption });
  }
  const adoption = await adoptActions(params.id, user, {
    exposureId: (body.exposureId ?? '').trim(),
    domain: (body.domain ?? '').trim(),
    entities: body.entities ?? [],
  });
  return NextResponse.json({ adoption }, { status: 201 });
}, { parse: true, defaultStatus: 500 });
