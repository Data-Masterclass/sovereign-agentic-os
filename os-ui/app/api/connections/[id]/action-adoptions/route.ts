/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { adoptActions, revokeActionAdoption, listAdoptions } from '@/lib/connections/action-adoptions';

export const dynamic = 'force-dynamic';

type AdoptActionsBody = {
  exposureId?: string;
  domain?: string;
  entities?: string[];
  /** Revoke path — an adoption id to soft-revoke instead of adopting. */
  revoke?: string;
};

/** List the action adoptions for an exposure (the adopt-panel state). Requires the
 *  caller to be able to see the connection (enforced in the lib). */
export const GET = withRoute<{ id: string }>(async ({ req }) => {
  const url = new URL(req.url);
  const exposureId = (url.searchParams.get('exposureId') ?? '').trim();
  if (!exposureId) return NextResponse.json({ adoptions: [] });
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
