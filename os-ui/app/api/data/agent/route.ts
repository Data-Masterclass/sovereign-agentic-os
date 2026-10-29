/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { authorize, queryRun, trace } from '@core/infra/governed';
import { privatePrefix } from '@tabs/data/lib/personal-lane';
import { claimsFromUser } from '@tabs/data/lib/identity';
import { runAgentTool, type AgentScope, type Executors } from '@tabs/data/lib/agent-tools';

export const dynamic = 'force-dynamic';

/**
 * The scoped data-agent tools endpoint. Runs the `personal` / `domain` / `marketplace`
 * tool under the signed-in user's DELEGATED identity (R2), forwarding the user to Trino
 * (RLS, R3). SINGLE-ENGINE: the personal lane
 * runs through the SAME governed Trino path (AS the owner), so there is no separate
 * query engine. Wires the real governed executors into the pure {@link runAgentTool}.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { scope?: AgentScope; sql?: string };
  const scope = body.scope;
  if (!scope || !['personal', 'domain', 'marketplace'].includes(scope)) {
    return NextResponse.json({ error: 'scope must be personal | domain | marketplace' }, { status: 400 });
  }

  const executors: Executors = {
    authorize: (principal, tool) => authorize(principal, tool),
    async trinoQuery(sql, principal) {
      const r = await queryRun(sql, principal);
      return { columns: r.columns, rows: r.rows };
    },
    trace: (event) => trace({ principal: String(event.principal), tool: 'query', input: event, output: {} }),
  };

  try {
    const claims = claimsFromUser({ id: user.id, domains: user.domains, role: user.role });
    const result = await runAgentTool(claims, { scope, kind: 'query', sql: body.sql }, executors);
    return NextResponse.json({ ...result, prefix: scope === 'personal' ? privatePrefix(user.id) : undefined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}
