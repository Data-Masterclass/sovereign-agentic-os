/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    `get_engineering_view({kind, id})` — the MCP twin of the "Under the hood" panel
 * USER STORY: As an AI client (or an engineer with one) I want the same tool-native artefacts the
 *             UI shows — the dbt model and YAML, the Dagster asset and last run, the compiled
 *             LangGraph graph, the git files and head, the Langfuse trace — as ONE structure I can
 *             parse, with the engineer's command included (checklist T8).
 * ARCHITECTURE:
 *   - ONE tool over the shared registry: the identical `EngineeringView` the panel renders, so
 *     there is no second code path to drift (plan D25). `engineering-parity.test.ts` asserts it.
 *   - The object gate is the TAB's own: an adapter calls `getDataset` / `getMetric` /
 *     `getDashboard` / `getSystem` / `getAppForUser`, each of which throws the status-carrying
 *     error the dispatcher maps — so an absent object is `not_found` and an invisible one is
 *     refused exactly as every other door on that tab refuses it (no new visibility rule here).
 *   - A kind whose tab is disabled answers `bad_request` NAMING the reason, never an empty view.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { engineeringAdapter } from '@core/engineering/registry';
import { engineeringAdaptersReady, engineeringKindSkipReason } from '@core/engineering/register';
import { ENGINEERING_KINDS, type EngineeringKind } from '@core/engineering/types';

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

/** `kind` → the adapter, after the registry is filled. Typed refusals, never a silent empty. */
export async function engineeringViewFor(
  user: Parameters<McpTool['call']>[0],
  kind: string,
  id: string,
): Promise<unknown> {
  if (!(ENGINEERING_KINDS as readonly string[]).includes(kind)) {
    fail(`kind must be one of ${ENGINEERING_KINDS.join(' | ')}; got '${kind}'`, 400);
  }
  if (!id) fail('id is required', 400);
  await engineeringAdaptersReady;
  const adapter = engineeringAdapter(kind as EngineeringKind);
  if (!adapter) {
    fail(`no engineering view for kind '${kind}' in this deployment: ${engineeringKindSkipReason(kind as EngineeringKind) ?? 'its tab is not loaded'}`, 400);
  }
  return adapter(user, id);
}

export const engineeringTools: McpTool[] = [
  {
    name: 'get_engineering_view',
    description:
      'The tool-native artefacts behind one OS object — the dbt model SQL and YAML as committed with its repo path, the Dagster asset keys, job, schedule and last run, the compiled LangGraph graph (nodes, edges, guards, channels, interrupts), the git file list and head commit, and the Langfuse trace — each with a deep link and the exact command to run it yourself (dbt build --select …, dagster asset materialize --select …, mf query --metrics …). Same structure the "Under the hood" panel renders. Read-only, scoped to your identity: an object you cannot see answers exactly as its tab answers.',
    minRole: 'creator',
    tab: 'meta',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...ENGINEERING_KINDS],
          description: 'The object kind: dataset (data product), metric (KPI), dashboard, agent_system or app.',
        },
        id: { type: 'string', description: 'The object id, as the tab\'s own list tool returns it.' },
      },
      required: ['kind', 'id'],
    },
    call: async (user, args) => engineeringViewFor(user, String(args.kind ?? ''), String(args.id ?? '')),
  },
];
