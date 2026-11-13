/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    EVERY MCP tool dispatches — one table-driven conformance test over the whole
 *             registry (engine rebuild Part F, checklist X7)
 * USER STORY: As an AI client I want every tool `list_capabilities` advertises to be callable, to
 *             carry a schema I can fill, and to answer a governance denial with a typed
 *             `{code, reason, hint}` from a documented vocabulary — never `Tool not available`,
 *             never a stack trace, never a leaked filesystem path — so I can act on the refusal
 *             instead of guessing.
 * ARCHITECTURE:
 *   - ONE test over `ALL_MCP_TOOLS` — what `list_capabilities` enumerates — so a tool registered
 *     later is covered the moment it exists. The data half (B4) covered `tab === 'data'` only;
 *     this GENERALISES it to the whole registry (agents, run, governance, software, knowledge,
 *     metrics, dashboards, monitoring, connections, files, operating-manual, meta) rather than
 *     duplicating it, and `tabs/data/lib/mcp-conformance.test.ts` keeps the data-specific
 *     commit/launch assertions a core test may not reach.
 *   - Imports NO tab (CORE-INDEPENDENCE). Every object this test needs is MINTED through the
 *     dispatcher as another user, exactly as a client would mint it — so the "foreign object"
 *     case is a real cross-principal refusal, not a seeded fixture.
 *   - The refusal code is asserted PER TOOL, never as "one of two" (the review-M-5 standard):
 *       · an object that does NOT exist            ⇒ `not_found`, from every object-addressed tool
 *       · an object that EXISTS and is invisible   ⇒ `forbidden` ("Not permitted to …"), which is
 *         the OS's convention on every surface (deviation B4-11) …
 *       · … EXCEPT the whole software tab, which answers `not_found` for an app the caller cannot
 *         see — from its READ/BUILD doors AND, since iteration 2 (F2-1), from its WRITE doors too.
 *         Part F measured the split (eight write doors said `forbidden` where the read doors said
 *         `not_found`, telling an enumerating caller the app EXISTS); the owner's call was
 *         `not_found`, so {@link SOFTWARE_FOREIGN} is now ONE expectation for every software tool
 *         and the leak cannot come back one door at a time.
 *       · an agent RUN                             ⇒ `not_found` DELIBERATELY, even when it
 *         exists and belongs to someone else (`assertRunVisible`): a run id you do not own must be
 *         indistinguishable from one that was never minted.
 *       · a role gate                              ⇒ `forbidden`, NAMING the role required.
 *   - `error` is the dispatcher's last-resort catch-all and is therefore NOT conformant: a tool
 *     answering it has leaked an unexpected failure to the client. That tripwire is what caught
 *     `suggest_metrics` returning a raw `fetch failed` when the model gateway is unreachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import {
  handleRpc,
  ALL_MCP_TOOLS,
  roleCanUse,
  type JsonRpcResponse,
  type ToolError,
  type McpTool,
  type JsonSchema,
} from '@core/mcp/server';

/** The documented error vocabulary (`structuredError` in `core/mcp/server.ts`). `error` is the
 *  catch-all an UNEXPECTED failure falls into and is deliberately excluded: a conformant tool
 *  never answers with it. */
const DOCUMENTED = new Set(['not_found', 'forbidden', 'bad_request', 'conflict', 'upstream_error']);

const admin = { id: 'sara', name: 'Sara', domains: ['ops'], role: 'admin' } as unknown as CurrentUser;
const creator = { id: 'cara', name: 'Cara', domains: ['ops'], role: 'creator' } as unknown as CurrentUser;
/** The OWNER of every minted object: another user, in a domain neither caller above shares. */
const stranger = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'admin' } as unknown as CurrentUser;

/** The id-shaped argument names the registry uses. A tool requiring one of these ADDRESSES an
 *  object, so it owes the caller `not_found` when that object does not exist. */
const ID_ARG = /^(id|.*Id)$/;

/** Arguments that are an id but whose tool needs a companion value to reach the object guard. */
const SPECIAL_ARGS: Record<string, Record<string, unknown>> = {
  // `kind: 'dataset'` is routed to the Data tab's own certification flow before the id is read,
  // so certify a kind that reaches the guard.
  request_certification: { kind: 'knowledge' },
  // `ref` is `<kind>:<id>`, not a bare id.
  get_lineage: { ref: 'dataset:ds_absent_conformance' },
};

async function rpc(user: CurrentUser, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res, `${name}: the dispatcher answered nothing`);
  return res;
}

function resultOf(res: JsonRpcResponse, name: string): Record<string, unknown> {
  assert.ok(
    !('error' in res && res.error),
    `${name}: the dispatcher answered a JSON-RPC error — ${JSON.stringify((res as { error?: unknown }).error)}`,
  );
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

/** The typed error of a call that must be refused, with the no-leak checks every refusal owes. */
function errorOf(result: Record<string, unknown>, name: string): ToolError {
  assert.equal(result.isError, true, `${name}: expected a typed tool error, got a success`);
  const err = (result.structuredContent as { error: ToolError }).error;
  assert.ok(err, `${name}: isError with no structuredContent.error`);
  assert.ok(DOCUMENTED.has(err.code), `${name}: code '${err.code}' is outside the documented set (${[...DOCUMENTED].join('|')})`);
  assert.ok(err.reason.length > 0, `${name}: an empty reason`);
  assert.ok(err.hint.length > 0, `${name}: no actionable hint`);
  assert.ok(!err.reason.includes('\n    at '), `${name}: the reason leaks a stack trace`);
  assert.ok(!/\/Users\/|\/home\/|node_modules/.test(err.reason), `${name}: the reason leaks a filesystem path`);
  return err;
}

/** A plausible value for one schema property. Ids point at an object that does not exist. */
function filler(name: string, prop: JsonSchema): unknown {
  if (ID_ARG.test(name)) {
    // `versionId` is numeric in the operating-manual tools; every other id is a string.
    return prop.type === 'number' ? 999_999 : `${name}_absent_conformance`;
  }
  const type = prop.type;
  if (type === 'array') return [];
  if (type === 'number') return 1;
  if (type === 'boolean') return false;
  if (type === 'object') return { schema: 'public', table: 'events' };
  const enumValues = (prop as { enum?: string[] }).enum;
  if (enumValues?.length) return enumValues[0];
  return 'x';
}

/** Fill a tool's REQUIRED arguments so the call reaches the tool's own guard, not its validator. */
function argsFor(tool: McpTool, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, unknown> = {};
  for (const name of tool.inputSchema.required ?? []) out[name] = filler(name, props[name] ?? {});
  // Shapes a validator checks before the object guard — supplied so a refusal is the GUARD's.
  if ('rules' in out) out.rules = [{ rule: 'not_null', column: 'order_id' }];
  if ('columns' in out) out.columns = ['order_id'];
  if ('picks' in out) out.picks = [];
  if ('content' in out) out.content = 'order_id\n1';
  if ('sql' in out) out.sql = 'select 1';
  if ('sections' in out) out.sections = [{ id: 'general', content: 'x' }];
  if ('entities' in out) out.entities = ['e1'];
  if ('tables' in out) out.tables = ['public.events'];
  if ('domains' in out) out.domains = ['ops'];
  if ('charts' in out) out.charts = [{ metricId: 'm_absent', kind: 'line' }];
  if ('message' in out) out.message = 'hello';
  if ('spec' in out) out.spec = { name: 'x' };
  // Both file-committing tools take `files` as an OPTIONAL property but require it at runtime.
  if (tool.name === 'commit_agent_files' || tool.name === 'commit') out.files = [{ path: 'a.md', content: 'x' }];
  return { ...out, ...(SPECIAL_ARGS[tool.name] ?? {}), ...overrides };
}

/** Tools that address a specific object, and the id argument they address it by. */
function objectArg(tool: McpTool): string | null {
  if (tool.name === 'get_lineage') return 'ref';
  return (tool.inputSchema.required ?? []).find((r) => ID_ARG.test(r)) ?? null;
}

// ---- the catalogue ------------------------------------------------------------------

test('X7: every tool in the registry is advertised by list_capabilities and carries a usable input schema', async () => {
  assert.ok(ALL_MCP_TOOLS.length >= 100, `expected the whole registry, found ${ALL_MCP_TOOLS.length}`);
  const payload = JSON.parse(
    (resultOf(await rpc(admin, 'list_capabilities', {}), 'list_capabilities').content as { text: string }[])[0].text,
  ) as { available: { name: string }[]; gated: { name: string }[] };
  const advertised = new Set([...payload.available, ...payload.gated].map((t) => t.name));
  for (const tool of ALL_MCP_TOOLS) {
    assert.ok(advertised.has(tool.name), `${tool.name} is registered but not advertised by list_capabilities`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema must be an object schema`);
    assert.ok(tool.inputSchema.properties, `${tool.name}: inputSchema has no properties`);
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(
        (tool.inputSchema.properties as Record<string, unknown>)[req],
        `${tool.name}: required '${req}' is not described in properties`,
      );
    }
    assert.ok(tool.description.length > 40, `${tool.name}: no usable description (${tool.description.length} chars)`);
  }
});

// ---- dispatch, and the documented vocabulary ---------------------------------------

test('X7: every tool DISPATCHES — the dispatcher never answers "Tool not available", and never the `error` catch-all', async () => {
  const nonConformant: string[] = [];
  for (const tool of ALL_MCP_TOOLS) {
    const result = resultOf(await rpc(admin, tool.name, argsFor(tool)), tool.name);
    if (result.isError !== true) continue; // a read/create that succeeded — it dispatched
    const err = (result.structuredContent as { error: ToolError }).error;
    if (!DOCUMENTED.has(err.code)) nonConformant.push(`${tool.name} → ${err.code}: ${err.reason}`);
    else errorOf(result, tool.name);
  }
  assert.deepEqual(nonConformant, [], `tool(s) answered outside the documented error vocabulary:\n${nonConformant.join('\n')}`);
});

// ---- an object that does not exist -------------------------------------------------

test('X7: every object-addressed tool answers an ABSENT object with `not_found` — per tool, no exceptions', async () => {
  const addressed = ALL_MCP_TOOLS.filter((t) => objectArg(t) !== null);
  assert.ok(addressed.length >= 60, `expected the object-addressed tools, found ${addressed.length}`);
  for (const tool of addressed) {
    const err = errorOf(resultOf(await rpc(admin, tool.name, argsFor(tool)), tool.name), tool.name);
    assert.equal(
      err.code,
      'not_found',
      `${tool.name}: an object that does not exist must be not_found, got ${err.code} (${err.reason})`,
    );
  }
});

// ---- a role gate ------------------------------------------------------------------

test('X7: a role gate answers `forbidden` and NAMES the role it needs, before any work', async () => {
  const gated = ALL_MCP_TOOLS.filter((t) => !roleCanUse('creator', t.minRole));
  assert.ok(gated.length >= 10, `expected the role-gated tools, found ${gated.length}`);
  for (const tool of gated) {
    const err = errorOf(resultOf(await rpc(creator, tool.name, argsFor(tool)), tool.name), tool.name);
    assert.equal(err.code, 'forbidden', `${tool.name}: a role gate is forbidden, got ${err.code}`);
    assert.match(err.reason, new RegExp(tool.minRole), `${tool.name}: the reason must name the role required`);
  }
});

// ---- an object that EXISTS and belongs to someone else ------------------------------

/**
 * The software tab hides an app the caller cannot see: every one of its object-addressed tools
 * answers `not_found`, read and write alike. Until iteration 2 the write half answered
 * `forbidden`, which confirmed the app's EXISTENCE to a caller the read half refused to tell
 * (finding F-3); converged in F2-1 by putting the visibility gate FIRST in `startPreview`,
 * `requestDeploy`, `setAppSpec`, `consumeResource` (`use_connection` / `use_data` /
 * `use_knowledge`), `useAsData` and `archiveApp`. A role or ownership gate on an app the caller
 * CAN see is still `forbidden` — that is a permission answer, not an existence answer.
 *
 * Kept as an explicit per-tool map rather than a blanket `tab === 'software' ⇒ not_found` so a
 * NEW software tool must be added here deliberately, and so a single door regressing to
 * `forbidden` names itself in the failure.
 */
const SOFTWARE_FOREIGN: Record<string, 'not_found' | 'forbidden'> = {
  design_software: 'not_found',
  build_software: 'not_found',
  verify_software: 'not_found',
  generate_app_spec: 'not_found',
  get_app_spec: 'not_found',
  set_app_design: 'not_found',
  get_software: 'not_found',
  read_app_files: 'not_found',
  // night-2 S6: the push verb is edit-scoped in-lib (`getEditableAppForUser` → `getAppForUser`),
  // so an app the caller cannot SEE answers `not_found` like every other software door.
  push_app_files: 'not_found',
  get_software_status: 'not_found',
  commit_software_files: 'not_found',
  request_deploy: 'not_found',
  start_preview: 'not_found',
  set_app_spec: 'not_found',
  use_connection: 'not_found',
  use_data: 'not_found',
  use_knowledge: 'not_found',
  use_as_data: 'not_found',
  archive: 'not_found',
};

/** The convention is a SINGLE answer for the tab — pinned so no future entry re-opens the split. */
test('X7: the software tab answers an invisible app with ONE code, read doors and write doors alike', () => {
  const codes = [...new Set(Object.values(SOFTWARE_FOREIGN))];
  assert.deepEqual(codes, ['not_found'], `the software tab must hide an invisible app uniformly, found ${codes.join(' + ')}`);
  // Every software tool that ADDRESSES an app must carry an expectation — a new door cannot
  // slip in on the `?? 'forbidden'` default and silently re-open the existence leak.
  // Scoped to the doors a CREATOR reaches: `promote` / `delete` / `commit` floor at builder, so
  // the dispatcher's role gate answers first and their object gate is never the code the client
  // sees. Pinning an expectation the foreign-object test cannot exercise would be a claim, not a test.
  const missing = ALL_MCP_TOOLS.filter(
    (t) =>
      t.tab === 'software' &&
      objectArg(t) === 'appId' &&
      roleCanUse('creator', t.minRole) &&
      SOFTWARE_FOREIGN[t.name] === undefined,
  ).map((t) => t.name);
  assert.deepEqual(missing, [], `software tool(s) addressing an app with no pinned refusal code: ${missing.join(', ')}`);
});

test('X7: an object that EXISTS but is invisible is refused per the OS convention, and the refusal names no content of it', async () => {
  // Mint one object of each kind AS the stranger, through the dispatcher, as a client would.
  const minted: Record<string, string> = {};
  const mints: [string, Record<string, unknown>, string][] = [
    ['create_agent_system', { name: 'Conformance system' }, 'systemId'],
    ['create_software', { name: 'Conformance app' }, 'appId'],
    ['create_dataset', { name: 'Conformance orders' }, 'datasetId'],
    ['author_knowledge', { title: 'Conformance workflow' }, 'workflowId'],
    ['upload_file', { name: 'conformance.txt', content: 'secret-payload' }, 'fileId'],
  ];
  for (const [name, args, key] of mints) {
    const result = resultOf(await rpc(stranger, name, args), name);
    assert.notEqual(result.isError, true, `${name}: minting the fixture failed — ${(result.content as { text: string }[])[0]?.text}`);
    const id = /"id":\s*"([^"]+)"/.exec((result.content as { text: string }[])[0].text)?.[1];
    assert.ok(id, `${name}: no id in the mint payload`);
    minted[key] = id;
  }

  const addressed = ALL_MCP_TOOLS.filter((t) => {
    const arg = objectArg(t);
    return arg !== null && minted[arg] !== undefined;
  });
  assert.ok(addressed.length >= 25, `expected the tools addressing a minted object kind, found ${addressed.length}`);
  for (const tool of addressed) {
    const arg = objectArg(tool)!;
    const err = errorOf(resultOf(await rpc(creator, tool.name, argsFor(tool, { [arg]: minted[arg] })), tool.name), tool.name);
    const expected =
      // A role floor is checked by the dispatcher before the object is ever loaded.
      !roleCanUse(creator.role, tool.minRole) ? 'forbidden'
        : tool.tab === 'software' ? (SOFTWARE_FOREIGN[tool.name] ?? 'forbidden')
          : 'forbidden';
    assert.equal(
      err.code,
      expected,
      `${tool.name}: an EXISTING invisible object must be ${expected}, got ${err.code} (${err.reason})`,
    );
    // Whatever the code, the refusal must not echo the object back.
    assert.ok(!err.reason.includes('secret-payload'), `${tool.name}: the refusal leaked the object's content`);
    assert.ok(!/Conformance (system|app|orders|workflow)/.test(err.reason), `${tool.name}: the refusal leaked the object's name`);
  }
});

// ---- the one place existence is deliberately hidden --------------------------------

test('X7: an agent RUN is deliberately indistinguishable — every run-addressed tool answers `not_found`, never `forbidden`', async () => {
  // A valid run-id SHAPE that was never minted (`newRunId()`'s shape).
  const ghost = 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const runTools = ALL_MCP_TOOLS.filter((t) => (t.inputSchema.required ?? []).includes('runId'));
  assert.ok(runTools.length >= 3, `expected the run-addressed tools, found ${runTools.length}`);
  for (const tool of runTools) {
    const err = errorOf(resultOf(await rpc(creator, tool.name, argsFor(tool, { runId: ghost })), tool.name), tool.name);
    assert.equal(err.code, 'not_found', `${tool.name}: a run you do not own must be not_found, got ${err.code}`);
  }
});
