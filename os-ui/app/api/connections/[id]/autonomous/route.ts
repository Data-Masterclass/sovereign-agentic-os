/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getConnectionForUser } from '@/lib/connections';
import { roleAtLeast } from '@/lib/core/session';
import {
  SAFETY_PRESETS,
  type SafetyPreset,
  setAgentPreset,
  setAgentToolPreset,
  setDomainDefaultPreset,
} from '@/lib/governance';

export const dynamic = 'force-dynamic';

/**
 * Set the AUTONOMOUS-agent safety preset (Mode B) for this connection: the domain
 * default (Admin), a per-agent override (Builder), and an optional per-tool
 * fine-tune. Presets: read-only → read-propose → read-bounded → full-in-scope.
 * Body: { agent, preset, tool?, domainDefault? }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (!roleAtLeast(user.role, 'builder')) {
      return NextResponse.json({ error: 'Setting an autonomous safety preset requires a Builder or Administrator' }, { status: 403 });
    }
    const { id } = await ctx.params;
    const c = await getConnectionForUser(id, user); // 404/403-scoped
    const body = await req.json();
    const preset = String(body?.preset ?? '') as SafetyPreset;
    if (!SAFETY_PRESETS.includes(preset)) {
      return NextResponse.json({ error: `preset must be one of ${SAFETY_PRESETS.join(', ')}` }, { status: 400 });
    }
    const agent = body?.agent ? String(body.agent) : undefined;
    const tool = body?.tool ? String(body.tool) : undefined;
    if (body?.domainDefault) {
      if (user.role !== 'admin') return NextResponse.json({ error: 'Only an Administrator sets the domain default' }, { status: 403 });
      setDomainDefaultPreset(c.domain, preset);
    }
    if (agent && tool) setAgentToolPreset(agent, c.principal, tool, preset);
    else if (agent) setAgentPreset(agent, preset);
    return NextResponse.json({ ok: true, preset, agent, tool, domain: c.domain });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
