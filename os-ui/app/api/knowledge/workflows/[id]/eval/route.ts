/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
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

/**
 * POST → run the eval harness for this workflow (online metrics over its indexed
 * units): a golden Q&A set (grounded-answer rate) + access-control checks
 * (policy-violation rate must be ≈ 0). Body may pass { golden, access } to
 * override the default cases; otherwise we derive sensible defaults from the
 * workflow's own hard rules + tacit + links.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const view = getWorkflow(id, user);

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
}, { parse: true, defaultStatus: 500 });
