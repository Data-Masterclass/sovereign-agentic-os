/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The confirmation gate's plumbing and the harness's third tool outcome, `parked`.
 * USER STORY: As the owner I need to know that a parked write did NOT run, that the model was not
 *             given a chance to say it did, and that today's assistants behave exactly as before.
 * ARCHITECTURE: the pure gate + the pure harness with a scripted model; the store is a spy port.
 *             The last block is a SOURCE SCAN: it pins which production files call the harness and
 *             which still use the explicit pass-through, so both lists change only in review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import {
  runAgentic,
  dedupNote,
  parkedFinalText,
  CAP_NOTE,
  SKIPPED_AFTER_PARK_NOTE,
  type LlmCall,
  type PendingToolCall,
  type ToolExecutor,
  type ToolSpec,
} from '@core/runtime/agentic';
import {
  userConfirmGate,
  engineHeldGate,
  readOnlyGate,
  ungatedInteractive,
  gateKindOf,
  parkedText,
  type ConfirmContext,
  type ConfirmationPort,
} from '@core/runtime/confirm-gate';

const OS_UI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// `create_dataset` is a catalogued write (needs confirmation); `list_datasets` a reviewed read.
const WRITE = 'create_dataset';
const READ = 'list_datasets';

const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const TOOLS = [spec(WRITE), spec(READ), spec('retire_dataset')];

type Call = { id: string; name: string; args: Record<string, unknown> };
function scriptLlm(script: Array<{ content: string; toolCalls?: Call[] }>) {
  const calls: { hadTools: boolean; last: string }[] = [];
  let i = 0;
  const llm: LlmCall = async (req) => {
    calls.push({ hadTools: !!req.tools, last: req.messages[req.messages.length - 1]?.content ?? '' });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return { content: step.content, toolCalls: step.toolCalls ?? [] };
  };
  return { llm, calls };
}

/** An inner executor that records every call that REACHED it. */
function spyInner(result: (name: string, args: Record<string, unknown>) => { text: string; isError: boolean } = () => ({ text: 'ok', isError: false })) {
  const reached: { name: string; args: Record<string, unknown> }[] = [];
  const inner: ToolExecutor = async (name, args) => {
    reached.push({ name, args });
    return result(name, args);
  };
  return { inner, reached };
}

/** A port that records what it was asked to create and hands back sequential ids. */
function spyPort(over: Partial<ConfirmationPort> = {}) {
  const created: Parameters<ConfirmationPort['create']>[0][] = [];
  const port: ConfirmationPort = {
    create: (request) => {
      created.push(request);
      const pending: PendingToolCall = { confirmationId: `cfm_${created.length}`, tool: request.tool, args: request.args, expiresAt: '2026-11-19T12:10:00.000Z' };
      return pending;
    },
    ...over,
  };
  return { port, created };
}

const CTX: ConfirmContext = { userId: 'rae', conversationId: 'conv-1', surface: 'ask', traceId: 'ask-t1' };

const run = (callTool: Parameters<typeof runAgentic>[0]['callTool'], llm: LlmCall, extra: Partial<Parameters<typeof runAgentic>[0]> = {}) =>
  runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'do it' }],
    tools: TOOLS,
    callTool,
    llm,
    planModel: 'plan',
    actModel: 'act',
    ...extra,
  });

// ------------------------------------------------------------------ the gate, call by call ----

test('userConfirmGate: a confirm-free tool runs; a write is parked and NEVER reaches the inner executor', async () => {
  const { inner, reached } = spyInner();
  const { port, created } = spyPort();
  const gate = userConfirmGate(inner, CTX, port);

  const read = await gate(READ, { q: 1 });
  assert.deepEqual(read, { text: 'ok', isError: false });
  assert.deepEqual(reached, [{ name: READ, args: { q: 1 } }]);
  assert.equal(created.length, 0, 'a read creates no confirmation');

  const write = await gate(WRITE, { name: 'Orders' });
  assert.equal(reached.length, 1, 'the write must not have reached the executor');
  assert.equal(write.isError, false);
  assert.equal(write.text, parkedText(WRITE));
  assert.deepEqual(write.parked, { confirmationId: 'cfm_1', tool: WRITE, args: { name: 'Orders' }, expiresAt: '2026-11-19T12:10:00.000Z' });
  assert.deepEqual(created, [{ userId: 'rae', conversationId: 'conv-1', surface: 'ask', tool: WRITE, args: { name: 'Orders' }, traceId: 'ask-t1' }]);
});

test('userConfirmGate is fail-closed: an unknown tool name is parked, not run', async () => {
  const { inner, reached } = spyInner();
  const { port, created } = spyPort();
  const gate = userConfirmGate(inner, CTX, port);
  for (const name of ['no_such_tool', 'constructor', '__proto__', '']) {
    const out = await gate(name, {});
    assert.ok(out.parked, `'${name}' must park`);
  }
  assert.equal(reached.length, 0);
  assert.equal(created.length, 4);
});

test('userConfirmGate: a tool the surface has closed is REFUSED — not parked, not run, no confirmation created', async () => {
  const { inner, reached } = spyInner();
  const { port, created } = spyPort();
  const gate = userConfirmGate(inner, { ...CTX, surface: 'team', closed: (t) => (t === 'retire_dataset' ? 'retire_dataset is not offered in this panel' : null) }, port);
  const out = await gate('retire_dataset', { id: 'ds_1' });
  assert.equal(out.isError, true);
  assert.equal(out.parked, undefined);
  assert.deepEqual(JSON.parse(out.text), { error: { code: 'surface_closed', reason: 'retire_dataset is not offered in this panel' } });
  assert.equal(reached.length, 0);
  assert.equal(created.length, 0);
  // Closed wins even over a confirm-free tool: the surface decides what it offers at all.
  const closedRead = await userConfirmGate(inner, { ...CTX, closed: () => 'nothing here' }, port)(READ, {});
  assert.equal(closedRead.isError, true);
  assert.equal(reached.length, 0);
});

test('userConfirmGate: a session allowance lets the call run; a port that cannot answer is treated as "not allowed"', async () => {
  const { inner, reached } = spyInner();
  const asked: unknown[] = [];
  const { port, created } = spyPort({ sessionAllows: (r) => { asked.push(r); return r.tool === WRITE; } });
  const gate = userConfirmGate(inner, CTX, port);
  const allowed = await gate(WRITE, { name: 'A' });
  assert.deepEqual(allowed, { text: 'ok', isError: false });
  assert.deepEqual(asked, [{ userId: 'rae', conversationId: 'conv-1', tool: WRITE }]);
  assert.equal(created.length, 0);
  const other = await gate('retire_dataset', { id: 'x' });
  assert.ok(other.parked, 'an allowance for one tool allows no other');
  assert.equal(reached.length, 1);

  const throwing = spyPort({ sessionAllows: () => { throw new Error('store down'); } });
  const out = await userConfirmGate(inner, CTX, throwing.port)(WRITE, {});
  assert.ok(out.parked, 'an unanswerable "allowed?" must park, not run');
  // Only literal `true` allows — a truthy non-boolean from a careless port does not.
  const truthy = spyPort({ sessionAllows: (() => 'yes') as unknown as ConfirmationPort['sessionAllows'] });
  assert.ok((await userConfirmGate(inner, CTX, truthy.port)(WRITE, {})).parked);
  assert.equal(reached.length, 1);
});

test('userConfirmGate: if the confirmation cannot be recorded the call is refused — never executed', async () => {
  const { inner, reached } = spyInner();
  const { port } = spyPort({ create: () => { throw new Error('mirror unreachable'); } });
  const out = await userConfirmGate(inner, CTX, port)(WRITE, {});
  assert.equal(out.isError, true);
  assert.equal(out.parked, undefined);
  assert.equal(JSON.parse(out.text).error.code, 'confirmation_unavailable');
  assert.match(out.text, /NOT executed/);
  assert.equal(reached.length, 0);
});

test('readOnlyGate runs confirm-free tools and refuses everything else; engineHeldGate and ungatedInteractive pass through', async () => {
  const { inner, reached } = spyInner();
  const ro = readOnlyGate(inner);
  assert.deepEqual(await ro(READ, {}), { text: 'ok', isError: false });
  for (const name of [WRITE, 'retire_dataset', 'no_such_tool', 'get_software_status']) {
    const out = await ro(name, {});
    assert.equal(out.isError, true, name);
    assert.equal(out.parked, undefined, `${name} must be refused, not parked`);
    assert.equal(JSON.parse(out.text).error.code, 'read_only');
  }
  assert.deepEqual(reached.map((r) => r.name), [READ]);

  for (const make of [engineHeldGate, ungatedInteractive]) {
    const s = spyInner((name) => ({ text: `ran ${name}`, isError: name === 'boom' }));
    const g = make(s.inner);
    assert.deepEqual(await g(WRITE, { a: 1 }), { text: `ran ${WRITE}`, isError: false });
    assert.deepEqual(await g('boom', {}), { text: 'ran boom', isError: true });
    assert.deepEqual(await g('no_such_tool', {}), { text: 'ran no_such_tool', isError: false });
    assert.equal(s.reached.length, 3, 'a pass-through gate hands every call to the executor');
  }
});

test('every constructor stamps its kind; a plain function carries none and the inner executor is not mutated', () => {
  const { inner } = spyInner();
  const { port } = spyPort();
  assert.equal(gateKindOf(userConfirmGate(inner, CTX, port)), 'user-confirm');
  assert.equal(gateKindOf(engineHeldGate(inner)), 'engine-held');
  assert.equal(gateKindOf(readOnlyGate(inner)), 'read-only');
  assert.equal(gateKindOf(ungatedInteractive(inner)), 'ungated-interactive');
  assert.equal(gateKindOf(inner), null, 'wrapping must not brand the executor it wraps');
  assert.equal(gateKindOf(async () => ({ text: '', isError: false })), null);
  assert.equal(gateKindOf(null), null);
});

// ------------------------------------------------------------- the harness: `parked` ----------

test('PARKED: the call never reaches the executor, the turn ends, and the final text is the server\'s — not the model\'s', async () => {
  const { inner, reached } = spyInner();
  const { port } = spyPort();
  const { llm, calls } = scriptLlm([
    { content: 'plan' },
    // The model narrates success alongside the call. None of this may reach the user.
    { content: 'Done — I created the Orders dataset for you.', toolCalls: [{ id: 'c1', name: WRITE, args: { name: 'Orders' } }] },
    { content: 'I have created the dataset.' }, // must never be requested
  ]);
  const seen: string[] = [];
  const result = await run(userConfirmGate(inner, CTX, port), llm, { onStep: (s) => seen.push(`${s.tool}:${s.parked ? 'parked' : 'ran'}`) });

  assert.equal(reached.length, 0, 'the parked write must not have run');
  assert.equal(calls.length, 2, 'plan + ONE act call — no further completion after the park');
  assert.deepEqual(result.pending, [{ confirmationId: 'cfm_1', tool: WRITE, args: { name: 'Orders' }, expiresAt: '2026-11-19T12:10:00.000Z' }]);
  assert.deepEqual(result.steps, [{ tool: WRITE, args: { name: 'Orders' }, result: parkedText(WRITE), isError: false, parked: true }]);
  assert.deepEqual(seen, [`${WRITE}:parked`]);
  assert.equal(result.finalText, parkedFinalText(result.pending));
  assert.match(result.finalText, /Nothing has been changed yet/);
  assert.match(result.finalText, /NOT been run/);
  assert.doesNotMatch(result.finalText, /created the Orders dataset|I have created/);
  assert.doesNotMatch(result.finalText, /tool-step budget/, 'a parked turn is not a capped turn');
  assert.equal(result.iterations, 1);
});

test('PARKED: later calls in the same batch are not executed; calls BEFORE it in the batch are', async () => {
  const { inner, reached } = spyInner();
  const { port, created } = spyPort();
  const { llm, calls } = scriptLlm([
    { content: 'plan' },
    {
      content: '',
      toolCalls: [
        { id: 'c1', name: READ, args: {} },
        { id: 'c2', name: WRITE, args: { name: 'A' } },
        { id: 'c3', name: READ, args: { again: true } },
        { id: 'c4', name: 'retire_dataset', args: { id: 'ds_1' } },
      ],
    },
    { content: 'should not be asked' },
  ]);
  const result = await run(userConfirmGate(inner, CTX, port), llm);

  assert.deepEqual(reached, [{ name: READ, args: {} }], 'only the read BEFORE the parked call ran');
  assert.equal(created.length, 1, 'the write after the park is not even offered for confirmation');
  assert.equal(result.pending.length, 1);
  assert.deepEqual(
    result.steps.map((s) => [s.tool, s.parked ? 'parked' : s.skipped ? 'skipped' : 'ran', s.result]),
    [
      [READ, 'ran', 'ok'],
      [WRITE, 'parked', parkedText(WRITE)],
      [READ, 'skipped', SKIPPED_AFTER_PARK_NOTE],
      ['retire_dataset', 'skipped', SKIPPED_AFTER_PARK_NOTE],
    ],
  );
  assert.match(SKIPPED_AFTER_PARK_NOTE, /^not executed: an earlier action awaits the user/);
  assert.equal(result.finalText, parkedFinalText(result.pending, 2));
  assert.match(result.finalText, /2 further steps were not attempted/);
  assert.equal(calls.length, 2);
});

test('PARKED is not deduped and not a failed write: an identical call is never answered "you already ran this"', async () => {
  // Turn 1: the same write twice in one batch. The second must be "not executed", never the
  // dedup note (which would tell the model the first one RAN) and never the failed-write note.
  const a = spyInner();
  const first = await run(userConfirmGate(a.inner, CTX, spyPort().port), scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: WRITE, args: { name: 'A' } }, { id: 'c2', name: WRITE, args: { name: 'A' } }] },
  ]).llm, { writeToolNames: [WRITE] });
  assert.equal(a.reached.length, 0);
  assert.equal(first.steps[1].result, SKIPPED_AFTER_PARK_NOTE);
  assert.notEqual(first.steps[1].result, dedupNote(1));
  assert.equal(first.steps[1].isError, false, 'and it is not the identical-failed-write guard either');

  // Turn 2 (the allowance now exists): a read that ran, then the write runs for real, then the
  // model repeats the write — THAT repeat is deduped, because the call genuinely ran once.
  const b = spyInner();
  const allowed = spyPort({ sessionAllows: () => true });
  const second = await run(userConfirmGate(b.inner, CTX, allowed.port), scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: WRITE, args: { name: 'A' } }] },
    { content: '', toolCalls: [{ id: 'c2', name: WRITE, args: { name: 'A' } }] },
    { content: 'created once' },
  ]).llm);
  assert.equal(b.reached.length, 1, 'the write ran exactly once');
  assert.equal(second.steps[1].result, dedupNote(1), 'dedup notes stay truthful: it is said only of a call that ran');
  assert.deepEqual(second.pending, []);
});

test('PARKED does not count in the error streak: three real errors then a park is a park, not a forced stop', async () => {
  // The same tool errors three times in a row (one short of the streak cap), then the fourth
  // call parks. Were a park counted as an error the streak would hit four, the result would be
  // replaced by the "stop retrying" note and the turn would end in a cap synthesis.
  let n = 0;
  const { inner, reached } = spyInner(() => ({ text: 'Error: bad name', isError: true }));
  const { port } = spyPort({ sessionAllows: () => (n += 1) <= 3 });
  const { llm, calls } = scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: WRITE, args: { name: 'a' } }] },
    { content: '', toolCalls: [{ id: 'c2', name: WRITE, args: { name: 'b' } }] },
    { content: '', toolCalls: [{ id: 'c3', name: WRITE, args: { name: 'c' } }] },
    { content: '', toolCalls: [{ id: 'c4', name: WRITE, args: { name: 'd' } }] },
    { content: 'synthesis that must not be requested' },
  ]);
  const result = await run(userConfirmGate(inner, CTX, port), llm, { maxIterations: 10 });
  assert.equal(reached.length, 3, 'three real (failing) executions, then the fourth parked');
  assert.deepEqual(result.steps.map((s) => [s.isError, !!s.parked]), [[true, false], [true, false], [true, false], [false, true]]);
  assert.equal(result.steps[3].result, parkedText(WRITE), 'the parked result is not replaced by the error-streak note');
  assert.equal(result.finalText, parkedFinalText(result.pending));
  assert.ok(!result.finalText.includes(CAP_NOTE));
  assert.equal(calls.length, 5, 'plan + four act calls — no cap synthesis');
});

test('PARKED never triggers the budget-exhaustion escalation or the cap synthesis', async () => {
  const { inner } = spyInner();
  const escalations: unknown[] = [];
  const { llm, calls } = scriptLlm([{ content: 'plan' }, { content: '', toolCalls: [{ id: 'c1', name: WRITE, args: {} }] }, { content: 'never' }]);
  const result = await run(userConfirmGate(inner, CTX, spyPort().port), llm, {
    maxIterations: 1, // the park happens ON the last allowed iteration
    escalateActModel: 'reasoning',
    onEscalate: (e) => escalations.push(e),
  });
  assert.deepEqual(escalations, []);
  assert.equal(calls.length, 2);
  assert.equal(result.finalText, parkedFinalText(result.pending));
});

test('PARKED in ReAct mode (no native tool-calling) ends the turn the same way', async () => {
  const { inner, reached } = spyInner();
  const { ToolCallingUnsupportedError } = await import('@core/runtime/agentic');
  let i = 0;
  const llm: LlmCall = async (req) => {
    i += 1;
    if (i === 1) return { content: 'plan', toolCalls: [] };
    if (req.tools) throw new ToolCallingUnsupportedError();
    return { content: `{"tool":"${WRITE}","args":{"name":"R"}}`, toolCalls: [] };
  };
  const result = await run(userConfirmGate(inner, CTX, spyPort().port), llm);
  assert.equal(reached.length, 0);
  assert.equal(result.toolCallingSupported, false);
  assert.equal(result.pending.length, 1);
  assert.equal(result.finalText, parkedFinalText(result.pending));
});

test('NO BEHAVIOUR CHANGE: with ungatedInteractive nothing parks — a write runs and the model writes the final text', async () => {
  const { inner, reached } = spyInner();
  const { llm, calls } = scriptLlm([
    { content: 'plan' },
    { content: '', toolCalls: [{ id: 'c1', name: WRITE, args: { name: 'A' } }, { id: 'c2', name: 'retire_dataset', args: { id: 'x' } }] },
    { content: 'Both done.' },
  ]);
  const result = await run(ungatedInteractive(inner), llm);
  assert.deepEqual(reached.map((r) => r.name), [WRITE, 'retire_dataset']);
  assert.deepEqual(result.pending, []);
  assert.equal(result.finalText, 'Both done.');
  assert.ok(result.steps.every((s) => !s.parked && !s.skipped));
  assert.deepEqual(result.steps.map((s) => Object.keys(s).sort()), [['args', 'isError', 'result', 'tool'], ['args', 'isError', 'result', 'tool']], 'a step that ran carries no new field');
  assert.equal(calls.length, 3);
});

test('parkedFinalText names the tools, says nothing ran, and never shows arguments', () => {
  const p = (tool: string): PendingToolCall => ({ confirmationId: 'cfm_x', tool, args: { secret: 'hunter2' }, expiresAt: 'x' });
  const one = parkedFinalText([p('create_dataset')]);
  assert.match(one, /One action is waiting for your confirmation: `create_dataset`\./);
  assert.match(one, /It has NOT been run/);
  assert.doesNotMatch(one, /hunter2|cfm_x/);
  assert.doesNotMatch(one, /further step/);
  assert.match(parkedFinalText([p('a'), p('b')]), /2 actions are waiting for your confirmation: `a`, `b`\. They have NOT been run/);
  assert.match(parkedFinalText([p('a')], 1), /One further step was not attempted, because it came after/);
});

// ------------------------------------------------------------------ SOURCE-SCAN RATCHETS ------

/** Every non-test source file under the app's own directories, as os-ui-relative paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
      out.push(relative(OS_UI, full));
    }
  };
  for (const top of ['app', 'core', 'tabs', 'components', 'lib', 'scripts']) {
    try { walk(resolve(OS_UI, top)); } catch { /* a top-level dir this checkout does not have */ }
  }
  return out.sort();
}
const read = (rel: string) => readFileSync(resolve(OS_UI, rel), 'utf8');
const countOf = (src: string, needle: string) => src.split(needle).length - 1;
function occurrences(needle: string): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const f of sourceFiles()) {
    const n = countOf(read(f), needle);
    if (n > 0) hits[f] = n;
  }
  return hits;
}

test('RATCHET: exactly these non-test files contain `runAgentic(` — a new caller of the harness is a reviewed change', () => {
  assert.deepEqual(occurrences('runAgentic('), {
    'core/runtime/agent-loop.ts': 1, // Ask the OS
    'core/runtime/agentic.ts': 1, // the definition
    'core/runtime/runtime.ts': 1, // tab assistant, app chat, Build chat
    'tabs/agents/lib/build/agentic-graph.ts': 1, // Software Team panel (one node per turn)
  });
});

test('RATCHET: the exact `ungatedInteractive(` call sites — every one is a known gap, and the list must only shrink', () => {
  // TO SHRINK: replace a call site with `userConfirmGate(...)` (or `readOnlyGate`) and delete its
  // line here. TO GROW: do not. A new assistant surface chooses a real gate.
  assert.deepEqual(occurrences('ungatedInteractive('), {
    'core/runtime/agent-loop.ts': 1, // Ask the OS
    'core/runtime/confirm-gate.ts': 1, // the definition
    'core/runtime/runtime.ts': 1, // tab assistant, app chat, Build chat
    'tabs/agents/lib/build/agentic-graph.ts': 1, // Software Team panel
  });
});

test('GROUNDWORK: no production code uses a real gate or the confirmation store yet', () => {
  // The other three constructors exist and are tested, and nothing calls them: this PR changes
  // no behaviour. A later PR that wires one adds its call site here, in review.
  for (const ctor of ['userConfirmGate(', 'readOnlyGate(', 'engineHeldGate(']) {
    assert.deepEqual(occurrences(ctor), { 'core/runtime/confirm-gate.ts': 1 }, `${ctor} is called from production code`);
  }
  const storeUsers = sourceFiles().filter((f) => f !== 'core/policy/confirmations.ts' && /policy\/confirmations|confirmationPort|createConfirmation|grantSessionAllowance/.test(read(f)));
  assert.deepEqual(storeUsers, [], 'the confirmation store has a production consumer');
  const gateImporters = sourceFiles().filter((f) => /@core\/runtime\/confirm-gate/.test(read(f)));
  assert.deepEqual(gateImporters, [
    'core/policy/confirmations.ts', // types only
    'core/runtime/agent-loop.ts',
    'core/runtime/agentic.ts', // type only
    'core/runtime/confirm-gate.typecheck.ts', // types only
    'core/runtime/runtime.ts',
    'tabs/agents/lib/build/agentic-graph.ts',
  ]);
});

test('THE EXTERNAL MCP DOOR IS UNTOUCHED: server.ts, http.ts and the route reference neither the gate nor the store', () => {
  // A signed-in person's own MCP client is not confirm-gated — it reaches `handleRpc` directly.
  for (const file of ['core/mcp/server.ts', 'core/mcp/http.ts', 'app/api/mcp/route.ts']) {
    const src = read(file);
    assert.doesNotMatch(src, /confirm-gate|GatedToolExecutor|userConfirmGate|ungatedInteractive|readOnlyGate|engineHeldGate/, `${file} must not reference the gate`);
    assert.doesNotMatch(src, /policy\/confirmations|confirmationPort|createConfirmation|beginExecute|SessionAllowance/, `${file} must not reference the confirmation store`);
    assert.doesNotMatch(src, /tool-classes|needsUserConfirm|CONFIRM_FREE|SESSION_ALLOWABLE/, `${file} must not reference the confirm classes`);
  }
});
