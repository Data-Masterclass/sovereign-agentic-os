/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The MCP tool reference, rendered from the registry itself.
 * USER STORY: As someone connecting Claude (or any MCP client) to the OS, I want one page listing
 *             every tool with its role floor, toolset, arguments and a worked example, and I want it
 *             to be generated, so it can never name a tool that does not exist or miss one that does.
 * ARCHITECTURE:
 *   - Pure: takes the tool list (normally `ALL_MCP_TOOLS`) and a toolset resolver, returns markdown.
 *     No `server-only`, no I/O, no tab import.
 *   - Written to `docs/mcp/tool-reference.md` by `os-ui/scripts/gen-mcp-reference.ts`;
 *     `core/mcp/surface-matrix.test.ts` fails when the committed file differs from a fresh render.
 *   - The deprecated aliases are listed from `DEPRECATED_TOOL_ALIASES`, the one place that records them.
 */
import { DEPRECATED_TOOL_ALIASES } from '@core/mcp/deprecated-aliases';

type RefTool = {
  name: string;
  description: string;
  minRole: string;
  tab: string;
  extraTabs?: string[];
  inputSchema: { properties: Record<string, unknown>; required?: string[]; examples?: unknown[] };
};

const TAB_ORDER = ['meta', 'data', 'knowledge', 'workflows', 'files', 'metrics', 'dashboards', 'agents', 'software', 'connections', 'governance', 'monitoring', 'operating-manual'];

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function typeOf(p: Record<string, unknown>): string {
  if (Array.isArray(p.enum)) return (p.enum as unknown[]).map((v) => `\`${String(v)}\``).join(' \\| ');
  const t = p.type;
  if (t === 'array') {
    const items = (p.items ?? {}) as Record<string, unknown>;
    return `${typeof items.type === 'string' ? items.type : 'any'}[]`;
  }
  return typeof t === 'string' ? t : Array.isArray(t) ? t.join(' \\| ') : 'any';
}

function renderTool(t: RefTool, toolset: string | null): string {
  const props = Object.entries(t.inputSchema.properties ?? {}) as [string, Record<string, unknown>][];
  const required = new Set(t.inputSchema.required ?? []);
  const lines = [
    `### \`${t.name}\``,
    '',
    `Floor: **${t.minRole}** · Tab: ${[t.tab, ...(t.extraTabs ?? [])].join(', ')} · External door: ${toolset ? `toolset \`${toolset}\`` : 'core (always listed)'}`,
    '',
    t.description.trim(),
    '',
  ];
  if (props.length) {
    lines.push('| Argument | Type | Required | Description |', '|---|---|---|---|');
    for (const [k, p] of props) {
      lines.push(`| \`${k}\` | ${typeOf(p)} | ${required.has(k) ? 'yes' : ''} | ${cell(typeof p.description === 'string' ? p.description : '')} |`);
    }
    lines.push('');
  } else {
    lines.push('No arguments.', '');
  }
  const ex = t.inputSchema.examples?.[0];
  if (ex !== undefined) lines.push('Example arguments:', '', '```json', JSON.stringify(ex), '```', '');
  return lines.join('\n');
}

/** The whole reference page. Deterministic: tools grouped by tab in a fixed order, then by name. */
export function renderToolReference(tools: RefTool[], toolsetOf: (t: RefTool) => string | null): string {
  const byTab = new Map<string, RefTool[]>();
  for (const t of tools) byTab.set(t.tab, [...(byTab.get(t.tab) ?? []), t]);
  const tabs = [...byTab.keys()].sort((a, b) => {
    const ia = TAB_ORDER.indexOf(a), ib = TAB_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const out = [
    '<!--',
    'SPDX-License-Identifier: Apache-2.0',
    'Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)',
    '-->',
    '# MCP tool reference',
    '',
    '> GENERATED from the tool registry by `os-ui/scripts/gen-mcp-reference.ts` — do not edit by hand.',
    '> Regenerate: `cd os-ui && node --import ./scripts/test-setup.mjs scripts/gen-mcp-reference.ts`.',
    '> `core/mcp/surface-matrix.test.ts` fails when this file is stale. It describes a full install',
    '> (every tab enabled); an install with tabs switched off serves fewer tools.',
    '',
    `${tools.length} tools. **Floor** is the lowest role that sees and may call the tool (creator < builder < domain_admin < admin);`,
    'the governed function behind it re-checks scope on every call. **External door** says whether the',
    'tool is listed from the start on `/api/mcp` or appears after `load_toolset({name})`; the per-tab',
    'endpoints `/api/mcp/<tab>` list their tools without toolsets.',
    '',
    '## Deprecated names',
    '',
    'Still accepted for one release (same governed tool, logged), never listed:',
    '',
    ...Object.entries(DEPRECATED_TOOL_ALIASES).map(([o, n]) => `- \`${o}\` → \`${n}\``),
    '',
    '## Contents',
    '',
    ...tabs.map((tab) => `- [${tab}](#tab-${tab}) — ${byTab.get(tab)!.length}`),
    '',
  ];
  for (const tab of tabs) {
    out.push(`## Tab: ${tab}`, '', `<a id="tab-${tab}"></a>`, '');
    for (const t of [...byTab.get(tab)!].sort((a, b) => a.name.localeCompare(b.name))) out.push(renderTool(t, toolsetOf(t)));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
