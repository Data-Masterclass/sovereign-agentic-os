/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    go_live and retire — EXACTLY the two new MCP tools the lifecycle adds
 * USER STORY: As an AI client I want one verb that makes a version the one that runs and one
 *             that stops it running, with the same guard and the same refusal the UI gives —
 *             and I want every tool I already call to keep working with the arguments I
 *             already send.
 * ARCHITECTURE:
 *   - TWO tools, and that is the whole MCP surface change (simplicity contract §4). `run_tests`
 *     is deliberately NOT here: testing means running, building or previewing the DRAFT from
 *     Studio with each kind's existing verify tool (`verify_software`, `run_quality_checks`,
 *     `run_agent_system`, `preview_metric`), so a third verb would be a managed state nobody
 *     asked for.
 *   - Thin adapters over `@core/kernel/go-live`, which is the same function the UI route calls,
 *     so the two doors cannot drift. No business logic lives here.
 *   - No new REQUIRED argument anywhere else in the registry: this module adds tools, it does
 *     not touch an existing tool's schema. `sha` is optional and defaults to the head.
 *   - Error shapes are the registry's documented four: an unknown `kind` is `bad_request`, an
 *     object you cannot see is `not_found`, an object you may not operate is `forbidden`, and a
 *     dependency that is not live is `conflict` with a reason that NAMES it.
 */
import 'server-only';

import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import { LIFECYCLE_KINDS } from '@core/kernel/object-lifecycle';
import { goLive, retire } from '@core/kernel/go-live';
import type { LifecycleActor } from '@core/kernel/lifecycle-adapters';

/** The acting principal — from the MCP session, never from the request body. */
const A = (u: CurrentUser): LifecycleActor => ({
  id: u.id,
  name: u.name,
  role: u.role,
  domains: u.domains,
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const KIND_PROP = {
  type: 'string',
  enum: [...LIFECYCLE_KINDS],
  description:
    'Which kind of object: dataset, metric, dashboard, agent (an agent system), app (a software app), knowledge or connection.',
};

const ID_PROP = {
  type: 'string',
  description: 'The object id, exactly as the matching list_* tool returned it.',
};

const GO_LIVE_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'Pin a version as the one that runs. Lifecycle (Draft · Testing · Live) is a SEPARATE axis from audience (My · Domain · Company): going live does not share the object with anybody, and promoting it does not declare it finished.',
  properties: {
    kind: KIND_PROP,
    id: ID_PROP,
    sha: {
      type: 'string',
      description:
        'OPTIONAL. The commit or tag to pin. Omit to pin what you are looking at now (the object’s current draft).',
    },
  },
  required: ['kind', 'id'],
  examples: [
    { kind: 'dashboard', id: 'dash_7a1c22' },
    { kind: 'agent', id: 'sys_19b4', sha: '9f2c1ab0c4e5d6f70819a2b3c4d5e6f708192a3b' },
  ],
};

const RETIRE_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'Stop running a version. Nothing is deleted — the draft and every version stay.',
  properties: { kind: KIND_PROP, id: ID_PROP },
  required: ['kind', 'id'],
  examples: [{ kind: 'dashboard', id: 'dash_7a1c22' }],
};

export const lifecycleTools: McpTool[] = [
  {
    name: 'go_live',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Go live: pin this version as the one the OS RUNS (also called: publish a version, make it the running version). Lifecycle is Draft · Testing · Live and is INDEPENDENT of audience (My · Domain · Company) — your own My object can be Live, and going live needs no approval. Everything that operates then reads the pin: an agent schedule runs the pinned definition and Run serves the pinned spec. Editing afterwards creates a new draft and does NOT change what Run shows until you go live again. Path: after you have built and tried the draft from Studio. Before: the matching list_*/get_* tool for the id. Governance: refused, naming the culprit, if anything this object depends on is not itself Live.',
    inputSchema: GO_LIVE_SCHEMA,
    call: async (user, args) =>
      goLive(A(user), str(args.kind).trim(), str(args.id).trim(), str(args.sha).trim() || undefined, {
        surface: 'mcp:go_live',
      }),
  },
  {
    name: 'retire',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Retire: unpin this object so the OS stops running it (also called: take it out of Run, stop the running version). Run stops showing it; the draft, its history and every version are kept exactly as they are, and you can go live again at any time. This is NOT a delete and NOT a demotion: it changes only the lifecycle axis, never the audience — use the promotion tools for My · Domain · Company. Path: when a live version should stop operating. Before: the matching list_*/get_* tool for the id.',
    inputSchema: RETIRE_SCHEMA,
    call: async (user, args) =>
      retire(A(user), str(args.kind).trim(), str(args.id).trim(), { surface: 'mcp:retire' }),
  },
];
