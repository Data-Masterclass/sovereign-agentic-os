/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { createAndGrant, type ProvisionableType } from '@/lib/software/appspec/context-provision';

export const dynamic = 'force-dynamic';

const CREATE_TYPES = new Set<ProvisionableType>(['data', 'files', 'knowledge']);

/**
 * POST → Phase-4b "Create new context" for the six-type Choose-Context surface.
 *
 * Body:
 *   • { type:'data'|'files'|'knowledge', name }  → create a FRESH, EMPTY governed artifact
 *     in the app's `App «Name»` folder under that tab and grant it (read-only). Metrics have
 *     no direct create (they ride a dataset in the Data tab) so they are NOT a create type
 *     here — the UI routes "Create new metric" to the Data/Metrics tab instead.
 *   • { type:'agents', agentId, name? }  → grant an EXISTING agent (built in the Agents tab)
 *     to the app. Agent authoring stays in the Agents tab; this only records the grant.
 *
 * Everything is governed AS the caller: the store create fns gate the artifact, and
 * `patchAppDesign` gates the grant (a non-owner/-admin is 403). Fail-soft folder placement.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const body = (await req.json().catch(() => ({}))) as { type?: string; name?: string; agentId?: string };
  const type = body.type;

  if (type === 'agents') {
    const agentId = String(body.agentId ?? '').trim();
    if (!agentId) return NextResponse.json({ error: 'An agentId is required to grant an agent.' }, { status: 400 });
    const res = await createAndGrant(id, 'agents', { agentId, name: body.name }, user);
    return NextResponse.json(res);
  }

  if (!type || !CREATE_TYPES.has(type as ProvisionableType)) {
    return NextResponse.json(
      { error: `type must be one of: data, files, knowledge, agents` },
      { status: 400 },
    );
  }
  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'A name is required for the new context.' }, { status: 400 });

  const res = await createAndGrant(id, type as ProvisionableType, { name }, user);
  return NextResponse.json(res);
}, { defaultStatus: 500 });
