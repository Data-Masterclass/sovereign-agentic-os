/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getWorkflow, getDomainKnowledge } from '@/lib/knowledge/store';
import { chunkWorkflow, chunkDomain } from '@/lib/knowledge/chunk';
import {
  embedUnits,
  evaluateGolden,
  evaluateAccessControl,
  type GoldenCase,
  type AccessCase,
} from '@/lib/knowledge/eval-harness';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * POST → run the eval harness for this workflow (online metrics over its indexed
 * units): a golden Q&A set (grounded-answer rate) + access-control checks
 * (policy-violation rate must be ≈ 0). Body may pass { golden, access } to
 * override the default cases; otherwise we derive sensible defaults from the
 * workflow's own hard rules + tacit + links.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const view = getWorkflow(id, user);
    const body = await req.json().catch(() => ({}));

    const units = embedUnits([
      ...chunkWorkflow({ workflow: view.workflow, owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt }),
      ...chunkDomain(getDomainKnowledge(view.domain)),
    ]);

    const principal = { id: user.id, domains: user.domains, role: user.role };

    // Default golden cases: each hard rule + the first tacit note must be grounded.
    const defaultGolden: GoldenCase[] = [];
    for (const r of view.workflow.rules.filter((x) => x.hard)) {
      defaultGolden.push({ id: `rule-${r.id}`, query: r.text, principal, expect: r.text.split(/\s+/).slice(0, 3).join(' ') });
    }
    for (const s of view.workflow.steps) {
      for (const r of s.rules.filter((x) => x.hard)) {
        defaultGolden.push({ id: `step-rule-${r.id}`, query: r.text, principal, expect: r.text.split(/\s+/).slice(0, 3).join(' ') });
      }
      if (s.tacit.trim()) {
        defaultGolden.push({ id: `tacit-${s.id}`, query: s.tacit.slice(0, 60), principal, expect: s.id });
      }
    }

    const golden = Array.isArray(body.golden) ? (body.golden as GoldenCase[]) : defaultGolden;
    const access = Array.isArray(body.access) ? (body.access as AccessCase[]) : [];

    const goldenReport = evaluateGolden(units, golden.length ? golden : [{ id: 'noop', query: view.title, principal, expect: view.workflow.id }]);
    const accessReport = evaluateAccessControl(units, access);

    return NextResponse.json({
      golden: goldenReport,
      access: accessReport,
      metrics: {
        groundedRate: goldenReport.groundedRate,
        policyViolationRate: accessReport.violationRate,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
