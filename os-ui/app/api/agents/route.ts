/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Agents registry. Lists the deployed LangGraph agents / multi-agent systems
 * running on the platform and probes each one's /health server-side so the
 * Agents tab shows live status + role. ml-agent is an opt-in Science component,
 * so a "down" there is expected (off by default) rather than an error.
 */

type AgentDef = {
  key: string;
  name: string;
  role: string;
  runtime: string;
  url: string;
  optional: boolean;
};

const AGENTS: AgentDef[] = [
  {
    key: 'sample-agent',
    name: 'Sample RAG agent',
    role: 'retrieve → generate → trace (talk-to-your-data backbone, under Data)',
    runtime: 'LangGraph',
    url: `${config.sampleAgentUrl}/health`,
    optional: false,
  },
  {
    key: 'ml-agent',
    name: 'ML agent',
    role: 'features → train → deploy (Science / Layer-4 pipeline driver)',
    runtime: 'LangGraph',
    url: `${config.mlAgentUrl}/health`,
    optional: true,
  },
];

// The Hermes autonomous runtime — a SECOND Layer-1 engine next to LangGraph,
// gated OFF by default (chart `hermes.enabled`). Listed always so the Agent tab
// shows BOTH runtimes; when off it reports 'gated off' rather than probing.
const HERMES_AGENT: AgentDef = {
  key: 'hermes-gateway',
  name: 'Hermes autonomous runtime',
  role: 'long-running autonomy + persistent memory + self-improving skills (models via LiteLLM, tools via governed MCP)',
  runtime: 'Hermes (autonomous)',
  url: `${config.hermesGatewayUrl}/health`,
  optional: true,
};

async function probe(a: AgentDef) {
  // Hermes is gated off by default: don't probe, report the gate honestly.
  if (a.key === 'hermes-gateway' && !config.hermesEnabled) {
    return { key: a.key, name: a.name, role: a.role, runtime: a.runtime, optional: true, up: false, detail: 'gated off (hermes.enabled=false)' };
  }
  // An in-OS supervisor runs inside the OS UI process (governed tools via
  // lib/agent-governed), so it has no separate /health to probe.
  if (a.url.startsWith('in-os://')) {
    return { key: a.key, name: a.name, role: a.role, runtime: a.runtime, optional: a.optional, up: true, detail: 'in-OS supervisor' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(a.url, { cache: 'no-store', signal: ctrl.signal });
    // Any HTTP response means the agent process is deployed and serving — these
    // LangGraph services expose different routes (/ask, /write, /run) and some
    // 401/404 on /health, so reachability (not a 2xx) is the "running" signal.
    const up = res.status > 0;
    return {
      key: a.key,
      name: a.name,
      role: a.role,
      runtime: a.runtime,
      optional: a.optional,
      up,
      detail: `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      key: a.key,
      name: a.name,
      role: a.role,
      runtime: a.runtime,
      optional: a.optional,
      up: false,
      detail: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  // No anon access to the agent/health topology; any signed-in user may read it.
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  const agents = await Promise.all([...AGENTS, HERMES_AGENT].map(probe));
  const up = agents.filter((a) => a.up).length;
  return NextResponse.json({ agents, up, total: agents.length });
}
