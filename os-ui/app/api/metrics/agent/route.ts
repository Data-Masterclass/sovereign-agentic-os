/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { getDataset } from '@/lib/data/store';
import { metricAgentMessages, parseMetricProposal } from '@/lib/metrics/agent';
import { assistantComplete, AssistantNotConfiguredError } from '@/lib/assistant/complete';

export const dynamic = 'force-dynamic';

/**
 * The Metric AGENT — mode='agent' in the Define panel. It reads the host dataset's
 * REAL columns (view-scoped via getDataset), asks the ONE governed assistant LLM to
 * propose a measure grounded in them, and returns a structured {@link MetricForm}
 * the user accepts into the form. It NEVER invents a column, and if no assistant is
 * configured it returns an honest 503 pointing the admin to Platform Admin.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { datasetId?: string; goal?: string };
    const datasetId = (body.datasetId ?? '').trim();
    const goal = (body.goal ?? '').trim();
    if (!datasetId) return NextResponse.json({ error: 'datasetId is required' }, { status: 400 });
    if (!goal) return NextResponse.json({ error: 'a goal is required' }, { status: 400 });

    const dataset = getDataset(datasetId, user); // view-scope guard + real columns
    const columns = dataset.columns.map((c) => c.name);

    const { content, model } = await assistantComplete(metricAgentMessages(columns, goal), { user });
    const form = parseMetricProposal(content, columns, goal);

    return NextResponse.json({ form, columns, model });
  } catch (e) {
    if (e instanceof AssistantNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return errorResponse(e);
  }
}
