/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { createArtifact, listForUser } from '@/lib/core/artifacts';
import { ARTIFACT_TYPES, type ArtifactType, type Visibility, VISIBILITIES } from '@/lib/core/artifact-model';

export const dynamic = 'force-dynamic';

/** Scoped workspace listing: caller's Personal + their domain's Shared (+ Certified copies). */
export const GET = withRoute(async ({ user, req }) => {
  const { searchParams } = new URL(req.url);
  const typeParam = searchParams.get('type') as ArtifactType | null;
  const visParam = searchParams.get('visibility') as Visibility | null;
  const items = await listForUser(user, {
    type: typeParam && ARTIFACT_TYPES.includes(typeParam) ? typeParam : undefined,
    visibility: visParam && VISIBILITIES.includes(visParam) ? visParam : undefined,
    includeArchived: searchParams.get('archived') === '1',
  });
  return NextResponse.json({ user, items });
}, { defaultStatus: 500 });

/** Create a Personal artifact owned by the caller in their domain. */
export const POST = withRoute(async ({ user, req }) => {
  const body = await req.json();
  const type = body?.type as ArtifactType;
  if (!ARTIFACT_TYPES.includes(type)) {
    return NextResponse.json({ error: 'Unknown artifact type' }, { status: 400 });
  }
  if (!body?.name || !String(body.name).trim()) {
    return NextResponse.json({ error: 'A name is required' }, { status: 400 });
  }
  const item = await createArtifact(user, {
    type,
    name: String(body.name),
    description: body.description ? String(body.description) : '',
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    spec: typeof body.spec === 'object' && body.spec ? body.spec : {},
    domain: body.domain ? String(body.domain) : undefined,
  });
  return NextResponse.json({ item }, { status: 201 });
}, { defaultStatus: 500 });
