/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { registerConnectionProfile, type ConnToolPolicy } from '@/lib/agent-governed';
import type { GeneratedTool, OpenApiSpec } from './model.ts';

/**
 * Auto-MCP (Software golden path §E) — the key automation: an app's OpenAPI spec
 * is the source of truth; the platform generates an MCP server from it
 * (FastMCP / openapi-mcp-generator pattern), registers it as a Connection with
 * the **reads-on / writes-off** preset, and compiles that preset into OPA.
 *
 * This module is the SECURITY-CRITICAL heart of that automation:
 *   1. `toolsFromOpenApi` — derive tools from paths × methods (GET/HEAD = read,
 *      everything side-effecting = write).
 *   2. `applyReadsOnWritesOff` — the least-privilege preset: every read tool is
 *      enabled `Read`; every write tool is held `Write-approval` (NOT auto-on).
 *      The Builder review curates which writes graduate to Write-bounded later.
 *   3. `compileToOpa` — register the per-tool capability profile into the SAME
 *      offline OPA mirror / live OPA bundle every Connection uses
 *      (`registerConnectionProfile`), so an app MCP tool is governed identically
 *      to any other connection tool: only enabled, in-scope tools are exposed.
 *
 * Auto-gen is ~76–94% complete (deep-design), so the capability profile + the
 * Builder review CURATE the result; this is expected, not a flaw.
 */

const READ_METHODS = new Set(['get', 'head', 'options']);

function methodVerb(method: string): string {
  const m = method.toLowerCase();
  if (m === 'get' || m === 'head' || m === 'options') return 'get';
  if (m === 'post') return 'create';
  if (m === 'put' || m === 'patch') return 'update';
  if (m === 'delete') return 'delete';
  return m;
}

function pathToName(path: string, method: string): string {
  const segs = path
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]/g, '_'))
    .filter(Boolean);
  const base = segs.join('_') || 'root';
  return `${methodVerb(method)}_${base}`.toLowerCase();
}

/**
 * Derive the candidate MCP tools from an OpenAPI spec. A method is a READ tool
 * iff it is GET/HEAD/OPTIONS; any other verb side-effects and is a WRITE tool.
 * The reads-on/writes-off preset is applied here so callers get a ready profile.
 */
export function toolsFromOpenApi(spec: OpenApiSpec): GeneratedTool[] {
  const tools: GeneratedTool[] = [];
  const seen = new Set<string>();
  const paths = spec?.paths ?? {};
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      const write = !READ_METHODS.has(method.toLowerCase());
      const name = (op?.operationId && op.operationId.trim()) || pathToName(path, method);
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tools.push({
        name,
        description: op?.summary?.trim() || `${method.toUpperCase()} ${path} (${write ? 'write' : 'read'}).`,
        write,
        // reads-on / writes-off preset: reads enabled, writes held for approval.
        mode: write ? 'Write-approval' : 'Read',
      });
    }
  }
  return tools;
}

/**
 * Re-apply the reads-on / writes-off preset to an arbitrary tool list (used when
 * tools come from a template rather than an OpenAPI parse). Idempotent + the
 * single source of the least-privilege default — never auto-enable a write.
 */
export function applyReadsOnWritesOff(
  tools: { name: string; description: string; write: boolean }[],
): GeneratedTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    write: t.write,
    mode: t.write ? ('Write-approval' as const) : ('Read' as const),
  }));
}

/**
 * Compile the auto-MCP capability profile into OPA (the offline mirror locally,
 * the live bundle on a cluster) under the app's MCP principal, EXACTLY as a
 * manually-created Connection compiles (`lib/connections.ts` → `compileProfile`).
 * After this, `authorizeConnectionCall(principal, tool)` governs the app MCP:
 * reads allow, writes require approval, anything not in the profile is denied.
 *
 * Returns the compiled policy for the caller to persist on the app.
 */
export function compileToOpa(principal: string, tools: GeneratedTool[]): ConnToolPolicy[] {
  const policies: ConnToolPolicy[] = tools.map((t) => ({
    name: t.name,
    mode: t.mode,
    write: t.write,
  }));
  registerConnectionProfile(principal, policies);
  return policies;
}

/**
 * The full auto-MCP step for a new/updated app: derive (or accept) the tools,
 * apply the preset, and compile to OPA. Returns the governed tool list so the
 * app record + the Connections surface show exactly the enabled, in-scope tools.
 */
export function generateAndCompile(
  principal: string,
  input: { openapi?: OpenApiSpec; tools?: { name: string; description: string; write: boolean }[] },
): GeneratedTool[] {
  const tools = input.openapi
    ? toolsFromOpenApi(input.openapi)
    : applyReadsOnWritesOff(input.tools ?? []);
  compileToOpa(principal, tools);
  return tools;
}
