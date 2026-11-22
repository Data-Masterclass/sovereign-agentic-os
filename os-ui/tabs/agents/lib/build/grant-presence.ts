/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A run says when something its agents were granted is gone
 * USER STORY: As the owner of an agent system granted a dataset, a file, a knowledge note, a
 *             workflow, a metric or a connection that someone has since deleted, I want the run report to say
 *             so before the agents start, by kind and id, instead of finding out from an agent
 *             that "could not find" what it was told to use.
 * ARCHITECTURE:
 *   - Each item grant (a grant that names one id; a folder grant is re-resolved per run and has
 *     its own zero-match warning) is looked up through the governed MCP door, `handleRpc(user,…)`,
 *     with the matching `get_*` tool: the same door, the same identity and the same visibility an
 *     agent's own call would get, and no import of another tab. Only a typed `not_found` counts:
 *     the OS answers that for "deleted" and for "you cannot see it" alike, so the sentence says
 *     both. Any other answer (an outage, a refusal) says nothing rather than guess.
 *   - The warnings join the run's `warnings` (the run report a person reads); they are never put
 *     into an agent's prompt or a tool result.
 *   - A knowledge note (`pk_…`) is probed with `get_knowledge`, a workflow (`wf_…`) with `get_workflow`.
 */
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc as realHandleRpc, type JsonRpcResponse } from '@core/mcp/server';
import type { System } from '@tabs/agents/lib/system-schema';

type Probe = { kind: string; noun: string; tool: string; arg: string };

const PROBES: Record<'data' | 'files' | 'knowledge' | 'workflows' | 'metrics' | 'connections', Probe> = {
  data: { kind: 'data', noun: 'dataset', tool: 'get_dataset', arg: 'datasetId' },
  files: { kind: 'files', noun: 'file', tool: 'get_file', arg: 'fileId' },
  knowledge: { kind: 'knowledge', noun: 'knowledge note', tool: 'get_knowledge', arg: 'id' },
  workflows: { kind: 'workflows', noun: 'workflow', tool: 'get_workflow', arg: 'workflowId' },
  metrics: { kind: 'metrics', noun: 'metric', tool: 'get_metric', arg: 'metricId' },
  connections: { kind: 'connections', noun: 'connection', tool: 'get_connection', arg: 'connId' },
};

function notFound(res: unknown): boolean {
  const r = (res as JsonRpcResponse | null)?.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } } | undefined;
  return r?.isError === true && r.structuredContent?.error?.code === 'not_found';
}

/** One warning per item grant whose target the running user's OS no longer has. */
export async function missingGrantWarnings(
  user: CurrentUser,
  sys: System,
  deps: { handleRpc?: typeof realHandleRpc } = {},
): Promise<string[]> {
  const call = deps.handleRpc ?? realHandleRpc;
  const out: string[] = [];
  for (const [lane, probe] of Object.entries(PROBES) as [keyof typeof PROBES, Probe][]) {
    const grants = (sys.grants[lane] ?? []) as { id?: string; folder?: unknown }[];
    for (const g of grants) {
      if (!g.id || g.folder) continue;
      let res: unknown;
      try {
        res = await call(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: probe.tool, arguments: { [probe.arg]: g.id } } });
      } catch {
        continue;
      }
      if (notFound(res)) {
        out.push(
          `This system is granted the ${probe.noun} ${g.id}, which was deleted or which you can no longer see. ` +
            `Its agents will not find it. Remove the grant, or grant a ${probe.noun} that exists.`,
        );
      }
    }
  }
  return out;
}
