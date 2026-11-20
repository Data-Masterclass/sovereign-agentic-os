/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53 eject test — `node run.mjs` from the committed directory reaches the same final
 *             state as the OS run of the same input
 * USER STORY: As an AI engineer I want to take the agent directory out of git, run `node run.mjs`
 *             with a model URL and key and stub tools, and get the run the OS gets — the same
 *             agents in the same order, the same tool calls, the same team state, the same answer.
 * ARCHITECTURE:
 *   - One commit in a REAL git repository holds the generated module. The OS side reads it back,
 *     hash-verifies and imports it (`module/load.ts`) and runs it through `createOsAgent` with the
 *     governed executor (`grantedToolExecutor`, recording `handleRpc`) and `runAgentModule`. The
 *     eject side copies the same commit's files into an empty directory and runs `node run.mjs
 *     --stub-tools --json` in a child process: no OS module is imported there.
 *   - Both talk to the WP-02 harness's scripted OpenAI-compatible stub over HTTP, with the same
 *     script. Compared: the agent sequence, the team channels, every message's type, author and
 *     text, and every tool call's name and arguments. Not compared: tool RESULT text (stub tools vs
 *     the governed door answer differently by design) and generated ids.
 *   - `node_modules` beside the ejected directory is a link to os-ui's, i.e. the exact versions
 *     `package.json` pins; `npm ci` from the registry is not run here (no network in tests).
 *   - Negative twin (11 §4.2 twin 2): the same directory with an OS import added to `graph.mjs`
 *     must fail to run.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest, JsonRpcResponse } from '@core/mcp/server';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { grantedToolExecutor, grantedToolSpecs, type OsToolDeps } from '@tabs/agents/lib/build/os-tools';
import { holdDecisionFor } from '@tabs/agents/lib/build/hold';
import { memoryApprovalPort } from '@tabs/agents/lib/engine/approval-port';
import { memoryToolCallLedger, withToolCallLedger } from '@tabs/agents/lib/engine/tool-call-ledger';
import { FIXTURE_USER } from '@tabs/agents/lib/engine/parity-harness';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { loadAgentModule, readCommittedModule } from '@core/adapters/agent-module/load';
import { createOsAgent, memoryHoldStore } from '@tabs/agents/lib/module/os-agent';
import { requireGatewayChatModel } from '@core/adapters/litellm/chat-model';
import { memoryModuleRunStamps, runAgentModule } from '@tabs/agents/lib/module/run';
import { moduleVersions } from '@tabs/agents/lib/module/fixtures/module.pg-fixture';
import { python3Available, startModelStub, type ModelStub, type StubReply } from '@tabs/agents/lib/module/fixtures/stub-model';

const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const skip = python3Available() ? false : 'python3 missing — the model stub cannot start';

const TEAM_YAML = `version: '1'
system: { name: Eject team, domain: sales, visibility: Shared }
safety_preset: read-only
entrypoint: lead
state: { channels: { messages: add_messages, plan_ready: boolean } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge, query_data], connections: [] }
agents:
  - { id: lead, role: Routes the work, agent_md: '# lead', memory_md: '', tools: [], members: [researcher, analyst] }
  - { id: researcher, role: Finds the facts, agent_md: '# researcher', memory_md: '', tools: [search_knowledge] }
  - { id: analyst, role: Answers, agent_md: '# analyst', memory_md: '', tools: [query_data] }
edges:
  - { from: lead, to: researcher, type: supervise }
  - { from: lead, to: analyst, type: supervise }
  - { from: researcher, to: analyst, type: handoff, when: plan_ready }
`;
const TASK = 'How many open orders are there?';
const SCRIPT: StubReply[] = [
  { content: 'Delegating to the researcher.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'researcher', brief: 'find the order facts' } }] },
  { tool_calls: [{ name: 'search_knowledge', arguments: { query: 'open orders' } }] },
  { tool_calls: [{ name: 'set_state', arguments: { channel: 'plan_ready', value: true } }] },
  { content: 'Found the definition of an open order.' },
  { tool_calls: [{ name: 'query_data', arguments: { sql: 'select count(*) from orders where open' } }] },
  { content: 'There are 42 open orders.' },
  { tool_calls: [{ name: 'route', arguments: { next: 'END' } }] },
];

type Msg = { type: string; name: string | null; content: unknown; tool_calls: { name: string; args: unknown }[] };
type Final = { nodes: string[]; channels: Record<string, unknown>; messages: Msg[] };

/** What must be equal between the OS run and the eject run. */
function comparable(f: Final) {
  return {
    agents: f.nodes.filter((n) => n.startsWith('agent_')),
    channels: f.channels,
    messages: f.messages.map((m) => ({
      type: m.type,
      name: m.name,
      content: m.type === 'tool' ? '(tool result)' : m.content,
      tool_calls: m.tool_calls.map((c) => ({ name: c.name, args: c.args })),
    })),
  };
}

let stub: ModelStub;
let reposDir: string;
let commit: string;
const DIR = 'agents/eject-team';
const expected = () => generateAgentModule({ id: 'sys_eject', slug: 'eject-team', sys: parseSystem(TEAM_YAML), versions: moduleVersions() });

before(async () => {
  if (skip) return;
  stub = await startModelStub();
  reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53-eject-repos-'));
  await openOrInit('sales', { reposDir });
  const tree = new Map([...expected().files.entries()].map(([p, c]) => [`${DIR}/${p}`, c]));
  commit = (await commitTree('sales', tree, { reposDir, author: { name: 'wp53', email: 'wp53@example.invalid' }, message: 'agents: eject team' })).sha;
});
after(() => stub?.stop());

/** The committed directory, copied out of git into an empty directory. */
async function ejectedDir(edit?: (files: Map<string, string>) => void): Promise<string> {
  const { files } = await readCommittedModule('sales', DIR, commit, { reposDir });
  edit?.(files);
  const root = mkdtempSync(path.join(os.tmpdir(), 'wp53-ejected-'));
  for (const [p, c] of files) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), c);
  }
  symlinkSync(path.join(OS_UI, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function runEjected(dir: string) {
  return spawnSync(process.execPath, ['run.mjs', '--input', TASK, '--stub-tools', '--json'], {
    cwd: dir,
    // A clean environment: the model endpoint and key, nothing of the OS.
    env: { PATH: process.env.PATH ?? '', OPENAI_BASE_URL: stub.url, OPENAI_API_KEY: 'sk-stub', OPENAI_MODEL: 'stub' },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

async function runInOs(): Promise<Final> {
  const sys = parseSystem(TEAM_YAML);
  const at = await readCommittedModule('sales', DIR, commit, { reposDir });
  const loaded = await loadAgentModule({ committed: at.files, expected: expected().files, commit: at.commit, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53-eject-cache-')) });
  const rpc: string[] = [];
  const deps: OsToolDeps = {
    enqueue: (() => { throw new Error('nothing is held in a read-only team'); }) as unknown as OsToolDeps['enqueue'],
    handleRpc: (async (user: CurrentUser, req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      rpc.push(`${user.id}:${String(req.params?.name)}`);
      return { jsonrpc: '2.0', id: req.id ?? 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
    }) as unknown as OsToolDeps['handleRpc'],
    trace: (async () => undefined) as unknown as OsToolDeps['trace'],
  };
  const runId = `eject-${Date.now()}`;
  const graph = createOsAgent(loaded.module, {
    modelFor: () => requireGatewayChatModel({ model: 'stub', baseURL: stub.url, apiKey: 'sk-stub', writeSystem: false }),
    specs: grantedToolSpecs(FIXTURE_USER, sys),
    executor: withToolCallLedger(grantedToolExecutor(FIXTURE_USER, sys, 'sys_eject', deps, { holdAt: 'node' }), memoryToolCallLedger()),
    decide: (tool) => holdDecisionFor(sys.safetyPreset, tool),
    holds: memoryHoldStore(),
    threadId: runId,
    checkpointer: new MemorySaver(),
  });
  const nodes: string[] = [];
  const r = await runAgentModule({
    graph: graph as never,
    runId,
    owner: { systemId: 'sys_eject', userId: FIXTURE_USER.id, domain: 'sales' },
    task: TASK,
    approvals: memoryApprovalPort(),
    stamps: memoryModuleRunStamps(),
    runner: { id: FIXTURE_USER.id, role: FIXTURE_USER.role, domains: FIXTURE_USER.domains },
    agent: 'os-sys_eject',
    module: { digest: loaded.digest, commit: loaded.commit },
  });
  assert.equal(r.reachedEnd, true);
  assert.ok(rpc.every((x) => x.startsWith(`${FIXTURE_USER.id}:`)), 'every governed call ran as the runner');
  nodes.push(...r.path.map((a) => `agent_${a}`));
  const { messages, ...channels } = r.values as { messages: { type: string; name?: string; content: unknown; tool_calls?: { name: string; args: unknown }[] }[] } & Record<string, unknown>;
  return {
    nodes,
    channels,
    messages: messages.map((m) => ({ type: m.type, name: m.name ?? null, content: m.content, tool_calls: (m.tool_calls ?? []).map((c) => ({ name: c.name, args: c.args })) })),
  };
}

test('eject: node run.mjs from the committed directory reaches the same final state as the OS run', { skip }, async () => {
  await stub.script(SCRIPT);
  const inOs = await runInOs();
  assert.equal((await stub.stats()).cursor, SCRIPT.length, 'the OS run used the whole script');

  await stub.script(SCRIPT);
  const dir = await ejectedDir();
  const r = runEjected(dir);
  assert.equal(r.status, 0, r.stderr);
  const ejected = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Final;
  assert.equal((await stub.stats()).cursor, SCRIPT.length, 'the eject run used the whole script');

  assert.deepEqual(comparable(ejected), comparable(inOs));
  // And it is the run the definition describes: supervisor → researcher → hand-off → analyst.
  assert.deepEqual(comparable(ejected).agents, ['agent_lead', 'agent_researcher', 'agent_analyst']);
  assert.equal(ejected.channels.plan_ready, true);
  assert.equal(ejected.messages.at(-1)?.content, 'There are 42 open orders.');
});

test('negative twin: an OS import in graph.mjs makes the ejected directory fail to run', { skip }, async () => {
  await stub.script(SCRIPT);
  const dir = await ejectedDir((files) => files.set('graph.mjs', `import '@core/runtime/agentic';\n${files.get('graph.mjs')}`));
  const r = runEjected(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cannot find (package|module) '@core\/runtime\/agentic'|ERR_MODULE_NOT_FOUND/);
});
