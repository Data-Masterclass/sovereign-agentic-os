/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { mcpTabForPath, osAssistantSystem, osToolSpecs, runOsAssistant } from './agent-loop.ts';
import type { LlmCall } from './agentic.ts';

const creator: CurrentUser = { id: 'u-42', name: 'Robin', domains: ['sales'], role: 'creator' };

/**
 * A scripted LLM that PLANS (no tools), then on the ACT call issues the given
 * tool_calls once, then returns a final answer. Records every system prompt seen
 * and whether the tools param was present (native function-calling).
 */
function actThenFinish(
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[],
  finalText: string,
) {
  const systems: string[] = [];
  const sawTools: boolean[] = [];
  let acted = false;
  const llm: LlmCall = async (req) => {
    systems.push(req.messages.find((m) => m.role === 'system')?.content ?? '');
    sawTools.push(!!req.tools);
    if (!req.tools) return { content: '1. plan', toolCalls: [] }; // PLAN turn (no tools)
    if (!acted) {
      acted = true;
      return { content: '', toolCalls };
    }
    return { content: finalText, toolCalls: [] };
  };
  return { llm, systems, sawTools };
}

// (path mapping) --------------------------------------------------------------
test('mcpTabForPath maps app routes to their MCP tab (and null for overview pages)', () => {
  assert.equal(mcpTabForPath('/data'), 'data');
  assert.equal(mcpTabForPath('/data/some-product'), 'data'); // nested route → same tab
  assert.equal(mcpTabForPath('/big-bets'), 'bigbets'); // href ≠ tab id
  assert.equal(mcpTabForPath('/unstructured'), 'files'); // Files lives at /unstructured
  assert.equal(mcpTabForPath('/'), null);
  assert.equal(mcpTabForPath('/cockpit'), null); // no governed tool surface
  assert.equal(mcpTabForPath(''), null);
});

// (d) tab context is injected into the system prompt --------------------------
test('the system prompt carries OS orientation AND the current tab context', () => {
  const sys = osAssistantSystem('data');
  assert.match(sys, /Sovereign OS Assistant/);
  assert.match(sys, /governed MCP tools/); // governance note present
  assert.match(sys, /CURRENT TAB: Data/); // tab-aware framing
  // With no tab, it says so honestly rather than faking a lens.
  assert.match(osAssistantSystem(null), /CURRENT TAB: none/);
});

test('the system prompt tells the assistant to clarify + plan + confirm before building', () => {
  const sys = osAssistantSystem('data');
  assert.match(sys, /clarify → plan → confirm/i);
  assert.match(sys, /clarifying\s+questions/i); // asks before guessing
  assert.match(sys, /confirm/i);                // confirms before executing
  assert.match(sys, /Read-only .* just\s*\n?\s*answer/i); // reads stay snappy (no ceremony)
});

test('the current tab tools are surfaced FIRST but the full registry is reachable', () => {
  const specs = osToolSpecs(creator, 'data');
  const names = specs.map((s) => s.name);
  // query_data is a data-tab tool → it must appear before any non-data tool.
  const dataIdx = names.indexOf('query_data');
  const knowledgeIdx = names.indexOf('search_knowledge'); // a different tab's tool
  assert.ok(dataIdx >= 0, 'data tool present');
  assert.ok(knowledgeIdx >= 0, 'cross-tab tool still reachable');
  assert.ok(dataIdx < knowledgeIdx, 'current-tab tool ordered before other tabs');
});

// (a)+(b) a tool call routes through handleRpc AS THE USER, feeds back, terminates
test('a model tool_call is dispatched through the governed MCP as the user, then the loop finishes', async () => {
  const { llm, systems } = actThenFinish(
    [{ id: 'w', name: 'whoami', args: {} }],
    'You are Robin, a creator in the sales domain.',
  );
  const res = await runOsAssistant({
    user: creator,
    tab: 'data',
    messages: [{ role: 'user', content: 'who am I and what can I do?' }],
    llm,
  });
  // (a) executed via the governed dispatch under the caller's identity: whoami
  // echoes the caller id back — proof it ran AS this user, not a service account.
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].tool, 'whoami');
  assert.equal(res.steps[0].isError, false);
  assert.match(res.steps[0].result, /u-42/);
  // (b) the result fed back and the loop terminated with the final answer.
  assert.equal(res.finalText, 'You are Robin, a creator in the sales domain.');
  assert.equal(res.tab, 'data');
  // The PLAN turn ran on the tab-aware system prompt.
  assert.match(systems[0], /CURRENT TAB: Data/);
});

// (c) a governance-blocked tool surfaces HONESTLY (no pretend action) ----------
test('a Builder-gated tool is refused for a creator and surfaces as an honest error step', async () => {
  // `promote` (publish a shared asset) needs Builder+. A creator naming it must be
  // rejected by the SAME governed dispatch — surfaced as an isError step, not a
  // silent success. The assistant then tells the truth about the block.
  const { llm } = actThenFinish(
    [{ id: 'p', name: 'promote', args: { appId: 'app-1' } }],
    'I could not promote it — that action needs a Builder.',
  );
  const res = await runOsAssistant({
    user: creator,
    tab: 'software',
    messages: [{ role: 'user', content: 'publish my app to the domain' }],
    llm,
  });
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0].tool, 'promote');
  assert.equal(res.steps[0].isError, true);
  assert.match(res.steps[0].result, /builder|forbidden/i);
});
