/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getSystemForRun, setLastRun } from '@tabs/agents/lib/store';
import { prepareRun, withOutputResults } from '@tabs/agents/lib/build/run-service';
import { saveRunOutputs } from '@tabs/agents/lib/build/output-save-server';
import { outputKey, type ProducerRun } from '@tabs/agents/lib/output-saver';
import { parseSystem } from '@tabs/agents/lib/system-schema';

export const dynamic = 'force-dynamic';

/**
 * POST → SAVE the last run's result into its DECLARED OUTPUTS, by hand ("Save now" / "Try saving
 * again" in the Run panel and on Evaluate).
 *
 * It is the SAME save the engine runs when a run finishes (`saveRunOutputs`): the same governed
 * tools as the signed-in user, the same folder check, the same naming — and the same look for
 * what this run already wrote, so pressing it twice, or after the run saved it, writes nothing a
 * second time. Two things differ, both because a person is asking: a read-only team's hold does
 * not apply (it holds what a RUN does), and a run that stopped early can still have a finished
 * agent's result saved.
 *
 * Body: `{ index? }` — one declared output (its position on Define), or all of them when omitted.
 * Only the system's LAST run can be saved; its per-agent results are what is on record.
 */
export const POST = withRoute<{ id: string }, { index?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  const view = getSystemForRun(id, user);
  const last = view.lastRun;
  if (!last || !last.runId) {
    return NextResponse.json({ error: 'There is no run result to save yet — run the team first.' }, { status: 400 });
  }
  if (last.running) {
    return NextResponse.json({ error: 'The run is still going — its results are saved when it finishes.' }, { status: 409 });
  }
  const { yaml } = await prepareRun(user, view, id);
  const system = parseSystem(yaml);
  const outputs = system.outputs ?? [];
  if (outputs.length === 0) {
    return NextResponse.json({ error: 'This system declares no output under “Where the results go”.' }, { status: 400 });
  }
  let only: string[] | undefined;
  if (typeof body.index === 'number') {
    const one = outputs[body.index];
    if (!one) return NextResponse.json({ error: 'No such declared output.' }, { status: 400 });
    only = [outputKey(one)];
  }
  const nodes: ProducerRun[] = (last.nodes ?? []).map((n) => ({ node: n.node, status: n.status, finalText: n.finalText ?? '' }));
  if (nodes.length === 0 && last.output) nodes.push({ node: last.path.at(-1) ?? 'agent', status: last.ok ? 'ok' : 'failed', finalText: last.output });

  const results = await saveRunOutputs({
    user,
    system,
    systemId: id,
    runId: last.runId,
    at: last.at,
    status: last.failed ? 'failed' : last.reachedEnd === false ? 'incomplete' : 'done',
    nodes,
    previous: last.outputs,
    mode: 'by-hand',
    only,
  });
  const status = last.reachedEnd === false || last.failed ? 'stopped' : 'done';
  const fin = withOutputResults({ body: { status, warnings: last.warnings }, lastRun: last }, results);
  try { setLastRun(id, user, fin.lastRun); } catch { /* a run-only consumer cannot record it; the save itself stands */ }
  return NextResponse.json({ outputs: results, warnings: fin.lastRun.warnings ?? [], completedWithUnsavedOutputs: fin.body.completedWithUnsavedOutputs });
}, { parse: true, defaultStatus: 500 });
