/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    The whole MCP surface, tool × role — schemas, examples, floors, names, guides, docs.
 * USER STORY: As a model connected to the OS I want every tool to carry a schema that compiles and
 *             an example that fits it, every description to name only tools that exist, every role
 *             to see exactly the tools its floor allows (and a typed refusal naming the role for the
 *             rest, on the internal door AND the external fast door), every guide pathway the OS
 *             advertises to resolve, and the published tool reference to match the registry.
 * ARCHITECTURE:
 *   - ONE table over `ALL_MCP_TOOLS`, so a tool registered later is covered the moment it exists.
 *     `mcp-conformance.test.ts` owns the not_found / forbidden-for-a-foreign-object vocabulary; this
 *     file owns the static contract (schema, example, name hygiene) and the role floor matrix.
 *   - Imports NO tab (GLUE-9). The fast door is driven through `handleRpc`'s `fast` option, which is
 *     exactly what `serveMcp` (the body of `app/api/mcp/route.ts`) passes for `/api/mcp`.
 *   - Uses the `ajv` the app already depends on to compile each `inputSchema` (examples stripped).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import type { CurrentUser } from '@core/kernel/auth';
import { ROLES, type Role } from '@core/kernel/session';
import { handleRpc, ALL_MCP_TOOLS, roleCanUse, listToolsForRole, type JsonRpcResponse } from '@core/mcp/server';
import { toolsetOf } from '@core/mcp/fast-surface';
import { DEPRECATED_TOOL_ALIASES } from '@core/mcp/deprecated-aliases';
import { GUIDE_PATHS, loadGuide } from '@core/tabs-meta/guides';
import { RESOURCES } from '@core/mcp/resources';
import { PROMPTS } from '@core/mcp/prompts';
import { buildInstructions } from '@core/mcp/instructions';
import { renderToolReference } from '@core/mcp/reference';

const user = (role: Role): CurrentUser => ({ id: `matrix-${role}`, name: role, domains: ['sales'], role }) as CurrentUser;
const NAMES = new Set(ALL_MCP_TOOLS.map((t) => t.name));

type ToolResult = { isError?: boolean; structuredContent?: { error?: { code: string; reason: string; hint: string } } };
async function call(u: CurrentUser, name: string, args: Record<string, unknown>, fast?: string): Promise<JsonRpcResponse> {
  const res = await handleRpc(u, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, fast ? { fast: { sessionKey: fast } } : {});
  assert.ok(res, `${name}: no response`);
  return res;
}

test('every tool: the inputSchema compiles, carries ≥1 example, and every example validates against it', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const problems: string[] = [];
  for (const t of ALL_MCP_TOOLS) {
    const { examples, ...schema } = t.inputSchema;
    assert.equal(schema.type, 'object', `${t.name}: inputSchema.type must be object`);
    for (const r of schema.required ?? []) if (!(r in schema.properties)) problems.push(`${t.name}: required "${r}" is not a property`);
    let validate;
    try { validate = ajv.compile(schema); } catch (e) { problems.push(`${t.name}: schema does not compile — ${(e as Error).message}`); continue; }
    if (!Array.isArray(examples) || examples.length === 0) { problems.push(`${t.name}: no example`); continue; }
    examples.forEach((ex, i) => { if (!validate(ex)) problems.push(`${t.name}: example[${i}] — ${ajv.errorsText(validate.errors)}`); });
  }
  assert.deepEqual(problems, []);
});

/** A word shaped like an OS tool name: a known verb, an underscore, more words. */
const TOOLISH = /\b((?:list|get|create|update|delete|run|set|add|query|search|save|author|index|publish|retire|promote|request|approve|decide|build|commit|use|define|preview|suggest|import|export|ingest|profile|document|transform|tag|diff|rollback|sync|refresh|test|configure|upload|push|read|start|verify|go|generate|design|resume|reindex|reconcile|revoke|adopt|classify|apply|propose|archive|restore|load)_[a-z0-9_]+)\b/g;
/** Words of that shape that are not tool names: a toolset name, prompts, an Iceberg procedure, a table, an approval kind. */
const NOT_TOOLS = new Set(['load_toolset', 'run_jobs', 'run_events', 'rollback_to_snapshot', 'promote_certify', 'run_1b4e28ba', 'run_1b4e', 'adopt_ab12cd', 'list_changed', 'refresh_token']);
const PROMPT_NAMES = new Set(PROMPTS.map((p) => p.name));
function unknownToolNames(text: string): string[] {
  return [...new Set([...text.matchAll(TOOLISH)].map((m) => m[1]))].filter(
    (w) => !NAMES.has(w) && !NOT_TOOLS.has(w) && !PROMPT_NAMES.has(w),
  );
}

test('every description and schema names only tools that exist — and never a deprecated name', () => {
  const problems: string[] = [];
  for (const t of ALL_MCP_TOOLS) {
    const text = `${t.description} ${JSON.stringify(t.inputSchema)}`;
    for (const w of unknownToolNames(text)) problems.push(`${t.name} mentions "${w}"`);
  }
  assert.deepEqual(problems, []);
});

test('the guides, the prompts and the initialize instructions name only tools that exist', () => {
  const problems: string[] = [];
  for (const p of GUIDE_PATHS) for (const w of unknownToolNames(loadGuide(p))) problems.push(`guide ${p} mentions "${w}"`);
  for (const p of PROMPTS) for (const w of unknownToolNames(JSON.stringify(p))) problems.push(`prompt ${p.name} mentions "${w}"`);
  for (const w of unknownToolNames(buildInstructions())) problems.push(`instructions mention "${w}"`);
  // Deprecated names are documented in docs/mcp only — never in text a model reads as an instruction.
  assert.deepEqual(problems, []);
});

test('every guide pathway resolves — get_guide returns it, and it is a sovereign-os://guide resource', async () => {
  const uris = new Set(RESOURCES.map((r) => r.uri));
  for (const p of GUIDE_PATHS) {
    assert.ok(loadGuide(p).length > 200, `guide ${p} has real content`);
    const uri = ['how-to-use', 'overview', 'governance'].includes(p) ? `sovereign-os://guide/${p}` : `sovereign-os://guide/path/${p}`;
    assert.ok(uris.has(uri), `${uri} is listed in resources/list`);
    const read = await handleRpc(user('creator'), { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });
    assert.ok(!read?.error, `${uri} reads`);
    const got = await call(user('creator'), 'get_guide', { path: p });
    assert.notEqual((got.result as ToolResult).isError, true, `get_guide(${p}) answers`);
  }
});

test('ROLE MATRIX (internal door): tools/list is exactly the floor, and a call below it is a typed forbidden naming the role', async () => {
  for (const role of ROLES) {
    const listed = new Set(listToolsForRole(role).map((t) => t.name));
    for (const t of ALL_MCP_TOOLS) {
      const allowed = roleCanUse(role, t.minRole);
      assert.equal(listed.has(t.name), allowed, `${role} × ${t.name}: listed iff the floor (${t.minRole}) allows`);
      if (allowed) continue;
      const r = (await call(user(role), t.name, (t.inputSchema.examples?.[0] ?? {}) as Record<string, unknown>)).result as ToolResult;
      assert.equal(r.isError, true, `${role} × ${t.name}: refused`);
      const err = r.structuredContent?.error;
      assert.equal(err?.code, 'forbidden', `${role} × ${t.name}: forbidden`);
      assert.match(err!.reason, new RegExp(`requires ${t.minRole}; you are ${role}`), `${role} × ${t.name}: names the role`);
      assert.ok(err!.hint.length > 0, `${role} × ${t.name}: carries a hint`);
    }
  }
});

test('ROLE MATRIX (external fast door, /api/mcp): unloaded toolsets are refused with the fix, the floor still applies after loading', async () => {
  for (const role of ROLES) {
    const session = `matrix-session-${role}`;
    const u = user(role);
    const listed = ((await handleRpc(u, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { fast: { sessionKey: session } }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    for (const t of ALL_MCP_TOOLS) {
      const set = toolsetOf(t);
      assert.equal(listed.includes(t.name), set === null && roleCanUse(role, t.minRole), `${role} × ${t.name}: listed at connect iff core and allowed`);
    }
    // One tool per toolset this role can reach: refused before load_toolset, floor-checked after it.
    const sample = new Map<string, string>();
    for (const t of ALL_MCP_TOOLS) { const s = toolsetOf(t); if (s && roleCanUse(role, t.minRole) && !sample.has(s)) sample.set(s, t.name); }
    for (const [set, name] of sample) {
      const before = (await call(u, name, {}, session)).result as ToolResult;
      assert.equal(before.structuredContent?.error?.code, 'toolset_not_loaded', `${role} × ${name}: refused until ${set} is loaded`);
      assert.match(before.structuredContent!.error!.hint, new RegExp(`load_toolset \\{"name":"${set}"\\}`));
      const load = (await call(u, 'load_toolset', { name: set }, session)).result as ToolResult;
      assert.notEqual(load.isError, true, `${role}: load_toolset ${set}`);
    }
    // After loading everything, a tool above the floor is still a typed forbidden.
    for (const t of ALL_MCP_TOOLS.filter((x) => !roleCanUse(role, x.minRole))) {
      const r = (await call(u, t.name, {}, session)).result as ToolResult;
      assert.equal(r.structuredContent?.error?.code, 'forbidden', `${role} × ${t.name} on the fast door`);
    }
  }
});

test('DEPRECATED ALIASES: never listed, resolve to their target on both doors, and keep its floor', async () => {
  const caps = (await call(user('admin'), 'list_capabilities', {})).result as { content: { text: string }[] };
  const capNames = JSON.parse(caps.content[0].text).available.map((t: { name: string }) => t.name);
  for (const [old, current] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
    const target = ALL_MCP_TOOLS.find((t) => t.name === current);
    assert.ok(target, `${old} → ${current}: the target exists`);
    assert.ok(!NAMES.has(old) && !capNames.includes(old), `${old} is never listed`);
    for (const role of ROLES) {
      const r = (await call(user(role), old, {})).result as ToolResult | undefined;
      assert.ok(r, `${role} × ${old}: a tool result, never "Tool not available"`);
      const code = r!.structuredContent?.error?.code;
      if (!roleCanUse(role, target!.minRole)) assert.equal(code, 'forbidden', `${role} × ${old}: the target's floor (${target!.minRole}) applies`);
      else assert.notEqual(code, 'forbidden', `${role} × ${old}: allowed like ${current}`);
    }
  }
});

test('docs/mcp/tool-reference.md is the registry rendered — regenerate with scripts/gen-mcp-reference.ts', () => {
  const committed = readFileSync(join(process.cwd(), '..', 'docs', 'mcp', 'tool-reference.md'), 'utf8');
  assert.equal(committed, renderToolReference(ALL_MCP_TOOLS, toolsetOf as never), 'stale: cd os-ui && node --import ./scripts/test-setup.mjs scripts/gen-mcp-reference.ts');
});

test('docs/mcp: every tool name in the how-to docs exists, and every relative link resolves', () => {
  const dir = join(process.cwd(), '..', 'docs', 'mcp');
  for (const f of ['README.md', 'connect-clients.md', 'oauth.md']) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = unknownToolNames(text).filter((w) => !Object.hasOwn(DEPRECATED_TOOL_ALIASES, w));
    assert.deepEqual(names, [], `${f} names only real tools`);
    for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
      assert.doesNotThrow(() => readFileSync(join(dir, m[1])), `${f}: link ${m[1]} resolves`);
    }
  }
});
