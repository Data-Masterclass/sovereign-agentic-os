/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { callConnectionTool } from '@/lib/connections';

export const dynamic = 'force-dynamic';

/**
 * A thin REST surface over the governed Airflow tools of one `airflow` connection.
 * Every action routes through the SAME `callConnectionTool` gate as the MCP + the
 * generic tool door — so the capability profile decides allow / deny / held:
 *   • list / status  → Read, auto-allowed;
 *   • trigger        → Write-approval by default, HELD for Governance approval.
 * The vaulted credential is injected server-side and never appears in the response.
 *
 * GET  ?action=list                                → list_dags
 * GET  ?action=status&dagId=..&runId=..            → get_dag_run
 * GET  ?action=runs&dagId=..[&state=..&limit=..]   → list_dag_runs
 * GET  ?action=tasks&dagId=..&runId=..             → get_task_instances
 * GET  ?action=logs&dagId=..&runId=..&taskId=..[&tryNumber=] → get_task_logs
 * GET  ?action=xcom&dagId=..&runId=..&taskId=..[&key=]       → get_xcom
 * GET  ?action=datasets[&limit=]                   → list_datasets
 * GET  ?action=datasetEvents[&limit=]              → get_dataset_events
 * POST { action:'trigger', dagId, conf?, logicalDate? }     → trigger_dag (held)
 * POST { action:'pause'|'unpause', dagId }                  → pause/unpause (held)
 * POST { action:'clear', dagId, runId, taskIds?, onlyFailed? } → clear_task (held)
 *
 * Every write action is HELD for Governance approval; every read auto-allows.
 */

async function auth(): Promise<{ user: Awaited<ReturnType<typeof requireUser>> } | { error: NextResponse }> {
  try {
    return { user: await requireUser() };
  } catch (e) {
    return { error: NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }) };
  }
}

/** allow→200, held/proposed→202, deny/block→403. */
function statusFor(decision: unknown): number {
  return decision === 'allow' ? 200 : decision === 'requires_approval' || decision === 'propose' ? 202 : 403;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'list';
  const q = (k: string) => (url.searchParams.get(k) ?? '').trim();
  const run = async (tool: string, args: Record<string, unknown>) => {
    const out = await callConnectionTool(id, a.user, { tool, args });
    return NextResponse.json(out, { status: statusFor(out.decision) });
  };
  try {
    switch (action) {
      case 'status': {
        if (!q('dagId') || !q('runId')) return NextResponse.json({ error: 'status needs a dagId and a runId' }, { status: 400 });
        return run('get_dag_run', { dagId: q('dagId'), runId: q('runId') });
      }
      case 'runs': {
        if (!q('dagId')) return NextResponse.json({ error: 'runs needs a dagId' }, { status: 400 });
        const args: Record<string, unknown> = { dagId: q('dagId') };
        if (q('state')) args.state = q('state');
        if (q('limit')) args.limit = Number(q('limit'));
        return run('list_dag_runs', args);
      }
      case 'tasks': {
        if (!q('dagId') || !q('runId')) return NextResponse.json({ error: 'tasks needs a dagId and a runId' }, { status: 400 });
        return run('get_task_instances', { dagId: q('dagId'), runId: q('runId') });
      }
      case 'logs': {
        if (!q('dagId') || !q('runId') || !q('taskId')) return NextResponse.json({ error: 'logs needs a dagId, runId and taskId' }, { status: 400 });
        const args: Record<string, unknown> = { dagId: q('dagId'), runId: q('runId'), taskId: q('taskId') };
        if (q('tryNumber')) args.tryNumber = Number(q('tryNumber'));
        return run('get_task_logs', args);
      }
      case 'xcom': {
        if (!q('dagId') || !q('runId') || !q('taskId')) return NextResponse.json({ error: 'xcom needs a dagId, runId and taskId' }, { status: 400 });
        const args: Record<string, unknown> = { dagId: q('dagId'), runId: q('runId'), taskId: q('taskId') };
        if (q('key')) args.key = q('key');
        return run('get_xcom', args);
      }
      case 'datasets': {
        const args: Record<string, unknown> = {};
        if (q('limit')) args.limit = Number(q('limit'));
        return run('list_datasets', args);
      }
      case 'datasetEvents': {
        const args: Record<string, unknown> = {};
        if (q('limit')) args.limit = Number(q('limit'));
        return run('get_dataset_events', args);
      }
      default:
        return run('list_dags', {});
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number })?.status ?? 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await auth();
  if ('error' in a) return a.error;
  const { id } = await ctx.params;
  let body: {
    action?: string;
    dagId?: string;
    runId?: string;
    conf?: Record<string, unknown>;
    logicalDate?: string;
    taskIds?: unknown[];
    onlyFailed?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const action = String(body?.action ?? 'trigger');
  const dagId = String(body?.dagId ?? '').trim();
  if (!dagId) return NextResponse.json({ error: `${action} needs a dagId` }, { status: 400 });

  // Map the control action → its governed tool + args. Every one is Write-approval.
  let tool: string;
  const args: Record<string, unknown> = { dagId };
  switch (action) {
    case 'trigger':
      tool = 'trigger_dag';
      if (body.conf && typeof body.conf === 'object') args.conf = body.conf;
      if (body.logicalDate) args.logicalDate = String(body.logicalDate);
      break;
    case 'pause':
      tool = 'pause_dag';
      break;
    case 'unpause':
      tool = 'unpause_dag';
      break;
    case 'clear': {
      tool = 'clear_task';
      const runId = String(body?.runId ?? '').trim();
      if (!runId) return NextResponse.json({ error: 'clear needs a runId' }, { status: 400 });
      args.runId = runId;
      if (Array.isArray(body.taskIds)) args.taskIds = body.taskIds.map(String);
      if (body.onlyFailed) args.onlyFailed = true;
      break;
    }
    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
  try {
    const out = await callConnectionTool(id, a.user, { tool, args });
    return NextResponse.json(out, { status: statusFor(out.decision) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number })?.status ?? 500 });
  }
}
