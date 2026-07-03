import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';

export const dynamic = 'force-dynamic';

type Model = { id: string; ownedBy: string };
type Tool = { name: string; description: string; params: string[] };

function bearer(): string {
  return `Bearer ${config.litellmMasterKey}`;
}

/**
 * Models & Tools (Gateway) -> LiteLLM. Server-side (Bearer master key stays on
 * the server) we list the available models and the registered MCP tools the
 * agents can call through the one governed endpoint. Requires a session (401 for
 * anon) — the model/tool catalog is config recon, not a public surface.
 */
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

  try {
    const res = await fetch(`${config.litellmUrl}/v1/models`, {
      headers: { authorization: bearer(), accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    models = (Array.isArray(data?.data) ? data.data : []).map(
      (m: Record<string, unknown>) => ({
        id: String(m.id ?? ''),
        ownedBy: String(m.owned_by ?? ''),
      }),
    );
  } catch (e) {
    modelsError = (e as Error).message;
  }

  try {
    const res = await fetch(`${config.litellmUrl}/v1/mcp/tools`, {
      headers: { authorization: bearer(), accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tools = (Array.isArray(data?.tools) ? data.tools : []).map(
      (t: Record<string, unknown>) => {
        const schema = (t.inputSchema ?? {}) as Record<string, unknown>;
        const props = (schema.properties ?? {}) as Record<string, unknown>;
        return {
          name: String(t.name ?? ''),
          description: String(t.description ?? '').replace(/\s+/g, ' ').trim(),
          params: Object.keys(props),
        };
      },
    );
  } catch (e) {
    toolsError = (e as Error).message;
  }

  if (modelsError && toolsError) {
    return NextResponse.json(
      { error: `Could not reach LiteLLM: ${modelsError}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ models, tools, modelsError, toolsError });
}
