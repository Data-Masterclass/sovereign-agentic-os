/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Models & Tools (Gateway) catalogue — what LiteLLM serves, read through the admin client.
 * USER STORY: As a signed-in user I see which models and MCP tools the governed gateway offers.
 * ARCHITECTURE: session-gated; both reads go through `core/infra/litellm-admin.ts` (the ONE admin read
 *             client holding the master key), so no route references the key (A3 MODEL-KEY, repo-wide).
 *             Each read degrades on its own; both failing is a 502 naming the cause.
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { adminGet } from '@core/infra/litellm-admin';
import { errorResponse } from '@tabs/data/lib/server';

export const dynamic = 'force-dynamic';

type Model = { id: string; ownedBy: string };
type Tool = { name: string; description: string; params: string[] };

export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  let models: Model[] = [];
  let tools: Tool[] = [];
  let modelsError = '';
  let toolsError = '';

  const modelsRead = await adminGet<{ data?: Record<string, unknown>[] }>('/v1/models');
  if (modelsRead.ok) {
    models = (Array.isArray(modelsRead.data?.data) ? modelsRead.data.data : []).map((m) => ({
      id: String(m.id ?? ''),
      ownedBy: String(m.owned_by ?? ''),
    }));
  } else {
    modelsError = modelsRead.error;
  }

  const toolsRead = await adminGet<{ tools?: Record<string, unknown>[] }>('/v1/mcp/tools');
  if (toolsRead.ok) {
    tools = (Array.isArray(toolsRead.data?.tools) ? toolsRead.data.tools : []).map((t) => {
      const schema = (t.inputSchema ?? {}) as Record<string, unknown>;
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      return {
        name: String(t.name ?? ''),
        description: String(t.description ?? '').replace(/\s+/g, ' ').trim(),
        params: Object.keys(props),
      };
    });
  } else {
    toolsError = toolsRead.error;
  }

  if (modelsError && toolsError) {
    return NextResponse.json(
      { error: `Could not reach LiteLLM: ${modelsError}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ models, tools, modelsError, toolsError });
}
