/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Tool consoles — list the tool consoles and switch one on or off, audited
 * USER STORY: As a platform admin I see every tool console the OS can serve at <domain>/tools/<key>
 *             (LiteLLM, Dagster, ...), whether this install can serve it, its address and what it
 *             would show, and I switch it on for a demo and off again; each change is in the audit
 *             trail with who, which tool, on/off and which environment.
 * ARCHITECTURE:
 *   - The switch is `settings.toolConsoles[<key>].exposed` (tabs/admin/lib/settings.ts), default
 *     OFF, durable through the settings mirror. This module is its ONLY writer.
 *   - The proxy route reads it and passes it to the kernel's pure gate
 *     (`gateToolRequest`, core/infra/tool-proxy.ts); the kernel never imports this tab.
 *   - Status is static availability (registry + config) plus a LIVE reachability probe of the
 *     upstream: "available" is only claimed for a tool that answered.
 *   - Write and audit succeed together or not at all: an audit failure puts the switch back.
 */
import { TOOLS, consoleAvailability, resolveTool, type Tool } from '@core/infra/tool-proxy';
import { config } from '@core/kernel/config';
import { probeConsole } from '@core/adapters/health/console-probe';
import { auditConfirmed } from '@tabs/admin/lib/audit';
import { setToolConsoleExposed, toolConsoleExposed } from '@tabs/admin/lib/settings';

/** The short addresses os-ui answers (`app/(entry)/<key>/route.ts`), each a 308 to `/tools/<key>/`. */
export const SHORT_ADDRESS_KEYS = ['litellm', 'dagster', 'langfuse', 'opensearch'] as const;

/** What each console shows, in one sentence: the warning next to its switch. */
export const TOOL_CONSOLE_WARNINGS: Record<string, string> = {
  litellm: 'The LiteLLM admin console shows every model, provider credential name, virtual key, budget and spend log. The public Model Hub stays open to signed-in users either way.',
  dagster: 'Dagster shows every domain’s assets, runs, schedules and run logs (read-only: no launches or schedule changes from here).',
  langfuse: 'Langfuse shows users’ prompts and answers, tool calls and results across every agent run.',
  opensearch: 'OpenSearch Dashboards shows the raw search indexes, including file and knowledge content of every domain.',
  mlflow: 'MLflow shows every experiment, run, parameter and stored model artefact.',
  jupyterhub: 'JupyterHub opens notebook servers with a kernel inside the cluster.',
};

export type ToolConsoleStatus = 'available' | 'not-set-up' | 'pending';

export type ToolConsoleRow = {
  key: string;
  title: string;
  exposed: boolean;
  status: ToolConsoleStatus;
  /** Why it is not available (absent when it is). */
  statusReason?: string;
  /** Same-origin address of the console. */
  address: string;
  /** The short address (`/dagster`) when one exists. */
  shortAddress: string | null;
  warning: string;
};

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/**
 * The environment named in the audit row: the host of the OS's public URL (`OS_PUBLIC_URL`),
 * which is what tells dev from production; `unknown` when the install set none.
 */
export function environmentName(): string {
  try {
    return config.osPublicUrl ? new URL(config.osPublicUrl).host : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Does the upstream answer at all? (core/adapters/health/console-probe.ts) */
async function probeUpstream(tool: Tool): Promise<{ answered: boolean; detail: string }> {
  const r = await probeConsole(tool.upstream ? `${tool.upstream}${tool.upstreamRootPath ?? ''}/` : '');
  return r.ok ? { answered: true, detail: r.value.detail } : { answered: false, detail: r.detail };
}

async function rowFor(tool: Tool): Promise<ToolConsoleRow> {
  const base = {
    key: tool.key,
    title: tool.title,
    exposed: toolConsoleExposed(tool.key),
    address: `${tool.basePath}/`,
    shortAddress: (SHORT_ADDRESS_KEYS as readonly string[]).includes(tool.key) ? `/${tool.key}` : null,
    warning: TOOL_CONSOLE_WARNINGS[tool.key] ?? `${tool.title} shows data across every user and domain.`,
  };
  const availability = consoleAvailability(tool);
  if (availability.state !== 'available') {
    return { ...base, status: availability.state, statusReason: availability.reason };
  }
  const probe = await probeUpstream(tool);
  if (!probe.answered) {
    return { ...base, status: 'not-set-up', statusReason: `${tool.title} did not answer at its in-cluster address (${probe.detail}), so it is not set up or not running on this install` };
  }
  return { ...base, status: 'available' };
}

/** Every console of the proxy registry, with its switch, live status, address and warning. */
export async function listToolConsoles(): Promise<ToolConsoleRow[]> {
  return Promise.all(Object.values(TOOLS).map(rowFor));
}

/**
 * Switch one console on or off. Admin-ness is the CALLER's gate (`adminCtx`); this validates the
 * tool, refuses to switch ON a console this install cannot serve (409), writes the switch and the
 * audit row together, and puts the switch back if the audit row cannot be written.
 */
export async function setToolConsole(input: {
  key: unknown;
  exposed: unknown;
  actor: { id: string; role: string };
  tenantId: string;
}): Promise<{ key: string; exposed: boolean }> {
  const key = typeof input.key === 'string' ? input.key : '';
  const tool = resolveTool(key);
  if (!tool) throw fail(`Unknown tool '${key}'`, 404);
  if (typeof input.exposed !== 'boolean') throw fail('`exposed` must be true or false', 400);
  const exposed = input.exposed;
  if (exposed) {
    const availability = consoleAvailability(tool);
    if (availability.state !== 'available') throw fail(`${tool.title} cannot be switched on here: ${availability.reason}`, 409);
  }
  const environment = environmentName();
  // 1. the switch, durably (throws 503 and puts it back when the store does not confirm);
  // 2. its audit row, durably; when that is not confirmed the switch is undone and this fails.
  const undo = await setToolConsoleExposed(key, exposed);
  try {
    await auditConfirmed({
      tenant: input.tenantId,
      actor: input.actor.id,
      role: input.actor.role,
      action: 'tool-console.expose',
      target: `tool:${key}`,
      detail: `${tool.title} console ${exposed ? 'ON' : 'OFF'} at ${tool.basePath}/ (${environment})`,
      data: { tool: key, exposed, environment },
    });
  } catch (e) {
    await undo();
    throw new Error(`The ${tool.title} console was not changed: the audit trail could not be written (${e instanceof Error ? e.message : String(e)})`);
  }
  return { key, exposed };
}
