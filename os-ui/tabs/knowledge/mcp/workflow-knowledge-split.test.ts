/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A workflow and a knowledge note are two artifacts in the MCP tool surface
 * USER STORY: As an agent told to "save the report as knowledge" I must be offered a note tool and
 *             never a workflow tool; as an agent told to "document this process" I must be offered a
 *             workflow tool and never a note tool; and an old client that still calls
 *             `author_knowledge` must keep working, once, with the operator told.
 * ARCHITECTURE:
 *   - Driven over `handleRpc` like any MCP client. The stores are the real in-process ones.
 *   - NEGATIVE TWINS sit next to every positive: the old name must not be LISTED, a note must not
 *     appear in the workflow list and a workflow must not appear in the note list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, toolsForTab, ALL_MCP_TOOLS, type JsonRpcResponse } from '@core/mcp/server';
import { setDeprecationSink, DEPRECATED_TOOL_ALIASES } from '@core/mcp/deprecated-aliases';
import { normalizeLadderKind } from '@core/policy/ladder';
import { __resetStore as resetWorkflows } from '@tabs/knowledge/lib/store';
import { __resetStore as resetNotes } from '@tabs/knowledge/lib/personal-store';
import { __resetApprovals } from '@core/policy/approvals';

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };

function reset(): void {
  resetWorkflows();
  resetNotes();
  __resetApprovals();
}

async function raw(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
const payload = <T = Record<string, unknown>>(r: Record<string, unknown>): T => {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
};
const errorOf = (r: Record<string, unknown>) => {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: { code: string; reason: string; hint: string } }).error;
};

/** Collect deprecation notices for the duration of `fn`. */
async function withDeprecationLog<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const prev = setDeprecationSink((l) => lines.push(l));
  try {
    return { out: await fn(), lines };
  } finally {
    setDeprecationSink(prev);
  }
}

// ─── the two artifacts live behind different tools ────────────────────────────────────────

test('the Workflows tab owns the workflow tools; the Knowledge tab owns the note tools; no tool is on both', () => {
  const wf = new Set(toolsForTab('workflows').filter((t) => t.tab === 'workflows').map((t) => t.name));
  const kn = new Set(toolsForTab('knowledge').filter((t) => t.tab === 'knowledge').map((t) => t.name));
  for (const n of ['author_workflow', 'list_workflows', 'get_workflow', 'index_workflow', 'publish_workflow', 'retire_workflow']) assert.ok(wf.has(n), `${n} is a Workflows tool`);
  for (const n of ['save_knowledge_note', 'list_knowledge', 'get_knowledge', 'search_knowledge']) assert.ok(kn.has(n), `${n} is a Knowledge tool`);
  for (const n of wf) assert.ok(!kn.has(n), `${n} must not be on the knowledge tab`);
});

test('NEGATIVE TWIN: descriptions never use the other artifact as a synonym', () => {
  const wf = ALL_MCP_TOOLS.filter((t) => t.tab === 'workflows');
  const kn = ALL_MCP_TOOLS.filter((t) => t.tab === 'knowledge');
  assert.ok(wf.length >= 6 && kn.length >= 4);
  const alsoCalled = (d: string): string => (/\(also called:[^)]*(?:\([^)]*\)[^)]*)*\)/i.exec(d)?.[0] ?? '').toLowerCase();
  for (const t of wf) assert.doesNotMatch(alsoCalled(t.description), /knowledge/, `${t.name}: a workflow is never "also called" knowledge`);
  for (const t of kn) {
    assert.doesNotMatch(alsoCalled(t.description), /workflow|business process|sop/, `${t.name}: a note is never "also called" a workflow`);
    // The two OKF tools are the Open Knowledge Format interchange: their bundle is built from a workflow
    // and says so. Every other knowledge tool may only mention a workflow to say it is NOT one, or to
    // point at the workflow tool.
    if (/okf/.test(t.name)) continue;
    for (const m of t.description.matchAll(/(?:workflow|business process)/gi)) {
      const around = t.description.slice(Math.max(0, m.index! - 80), m.index! + 80).toLowerCase();
      assert.match(around, /not a workflow|not a business process|different artifact|author_workflow|get_workflow|list_workflows|\bwf_|workflows? \(|indexed workflows|text of indexed/, `${t.name}: unexplained "workflow" in a knowledge tool description`);
    }
  }
  for (const t of wf) assert.doesNotMatch(t.description, /business process\s*\(also called/i);
});

test('NEGATIVE TWIN: no deprecated name is listed — not in tools/list, not on a tab, not in list_capabilities', async () => {
  // Dana is a domain admin, so the whole workflow family (publish_workflow included) is in her list.
  const listed = (await handleRpc(dana, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as JsonRpcResponse).result as { tools: { name: string }[] };
  const names = new Set(listed.tools.map((t) => t.name));
  const caps = payload<{ available: { name: string }[]; gated: { name: string }[] }>(await raw(dana, 'list_capabilities'));
  const capNames = new Set([...caps.available, ...caps.gated].map((t) => t.name));
  for (const old of Object.keys(DEPRECATED_TOOL_ALIASES)) {
    assert.ok(!names.has(old), `${old} must not be in tools/list`);
    assert.ok(!capNames.has(old), `${old} must not be in list_capabilities`);
    assert.ok(ALL_MCP_TOOLS.every((t) => t.name !== old), `${old} is not a second tool`);
    assert.ok(names.has(DEPRECATED_TOOL_ALIASES[old]), `${DEPRECATED_TOOL_ALIASES[old]} is listed instead`);
  }
});

// ─── an artifact lands in ITS list, never the other ───────────────────────────────────────

test('save_knowledge_note creates a note that list_knowledge shows and list_workflows does not; author_workflow the reverse', async () => {
  reset();
  const note = payload<{ id: string }>(await raw(cara, 'save_knowledge_note', { title: 'Q3 report', md: '## Revenue\nUp.' }));
  const wf = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Refund handling' }));
  assert.match(note.id, /^pk_/);
  assert.match(wf.id, /^wf_/);

  const notes = payload<{ mine: { id: string }[] }>(await raw(cara, 'list_knowledge')).mine.map((n) => n.id);
  const flows = payload<{ mine: { id: string }[] }>(await raw(cara, 'list_workflows')).mine.map((n) => n.id);
  assert.deepEqual(notes, [note.id], 'the note list holds the note only');
  assert.deepEqual(flows, [wf.id], 'the workflow list holds the workflow only');

  assert.equal(payload<{ title: string }>(await raw(cara, 'get_knowledge', { id: note.id })).title, 'Q3 report');
  assert.equal(payload<{ title: string }>(await raw(cara, 'get_workflow', { workflowId: wf.id })).title, 'Refund handling');
});

test('NEGATIVE TWIN: get_knowledge refuses a workflow id, and get_workflow refuses a note id', async () => {
  reset();
  const note = payload<{ id: string }>(await raw(cara, 'save_knowledge_note', { title: 'N', md: 'x' }));
  const wf = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'W' }));
  const a = errorOf(await raw(cara, 'get_knowledge', { id: wf.id }));
  assert.equal(a.code, 'bad_request');
  assert.match(a.reason, /workflow/);
  assert.match(a.reason, /get_workflow/);
  assert.equal(errorOf(await raw(cara, 'get_workflow', { workflowId: note.id })).code, 'not_found');
});

// ─── back-compat: the old names still work and say so ─────────────────────────────────────

test('author_knowledge still works as a deprecated alias of author_workflow — it makes a WORKFLOW, and logs', async () => {
  reset();
  const { out, lines } = await withDeprecationLog(() => raw(cara, 'author_knowledge', { title: 'Old client flow' }));
  const rec = payload<{ id: string; title: string }>(out);
  assert.match(rec.id, /^wf_/, 'the alias runs the workflow tool: it never creates a note');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /DEPRECATED tool name 'author_knowledge'/);
  assert.match(lines[0], /use 'author_workflow'/);
  assert.doesNotMatch(lines[0], /Old client flow/, 'the notice never carries arguments');
  // It is the very same workflow the new tool reads back.
  assert.equal(payload<{ title: string }>(await raw(cara, 'get_workflow', { workflowId: rec.id })).title, 'Old client flow');
  assert.equal(payload<{ mine: unknown[] }>(await raw(cara, 'list_knowledge')).mine.length, 0, 'and no note appeared');
});

test('every deprecated name resolves, logs once per call, and keeps the role floor of its target', async () => {
  reset();
  const wf = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Flow' }));
  const calls: [string, CurrentUser, Record<string, unknown>][] = [
    ['index_knowledge', cara, { workflowId: wf.id }],
    ['publish_knowledge', dana, { workflowId: wf.id }],
    ['retire_knowledge', cara, { workflowId: wf.id }],
  ];
  for (const [name, who, args] of calls) {
    const { out, lines } = await withDeprecationLog(() => raw(who, name, args));
    assert.ok(out.isError !== true || errorOf(out).code !== 'not_found', `${name} must resolve (got ${JSON.stringify(out).slice(0, 200)})`);
    assert.equal(lines.length, 1, `${name} logs exactly one deprecation line`);
    assert.match(lines[0], new RegExp(`'${name}'.*use '${DEPRECATED_TOOL_ALIASES[name]}'`));
  }
  // The floor is the target's: a creator calling the old publish name is the same typed forbidden.
  reset();
  const wf2 = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Flow 2' }));
  const denied = await withDeprecationLog(() => raw(cara, 'publish_knowledge', { workflowId: wf2.id }));
  assert.equal(errorOf(denied.out).code, 'forbidden');
  assert.match(errorOf(denied.out).reason, /requires (builder|domain_admin)/i);
});

test('get_knowledge called the OLD way (workflowId) still returns the workflow, and logs; a plain unknown tool name still errors', async () => {
  reset();
  const wf = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Legacy read' }));
  const { out, lines } = await withDeprecationLog(() => raw(cara, 'get_knowledge', { workflowId: wf.id }));
  assert.equal(payload<{ title: string }>(out).title, 'Legacy read');
  assert.equal(lines.length, 1);
  const res = await handleRpc(cara, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'author_everything', arguments: {} } }) as JsonRpcResponse;
  assert.ok(res.error, 'a name that was never a tool is still a JSON-RPC error');
});

// ─── promotion kinds ──────────────────────────────────────────────────────────────────────

test('request_promotion: `workflow` is the workflow kind; `knowledge` with a note id means the note', async () => {
  assert.equal(normalizeLadderKind('workflow', 'wf_1'), 'knowledge', 'the persisted ladder kind of a workflow is unchanged');
  assert.equal(normalizeLadderKind('knowledge', 'pk_1'), 'personal_knowledge');
  assert.equal(normalizeLadderKind('knowledge', 'wf_1'), 'knowledge', 'the old spelling of a workflow still works');
  assert.equal(normalizeLadderKind('personal_knowledge', 'pk_1'), 'personal_knowledge');
  assert.equal(normalizeLadderKind('dataset', 'ds_1'), 'dataset');

  reset();
  const wf = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'To promote' }));
  const filed = payload<{ status?: string }>(await raw(cara, 'request_promotion', { kind: 'workflow', id: wf.id }));
  assert.equal(filed.status, 'pending');
  const note = payload<{ id: string }>(await raw(cara, 'save_knowledge_note', { title: 'Note to share', md: 'text' }));
  const filedNote = payload<{ status?: string }>(await raw(cara, 'request_promotion', { kind: 'knowledge', id: note.id }));
  assert.equal(filedNote.status, 'pending', 'a note filed under the old `knowledge` kind word is routed to the note path');
});
