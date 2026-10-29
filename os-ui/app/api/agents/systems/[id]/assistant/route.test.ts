/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route tests for the THREE-mode Agents assistant (POST /api/agents/systems/[id]/assistant):
 *   1. legacy `{ instruction }` → the UNCHANGED deterministic scaffold that commits system.yaml;
 *   2. chat `{ stage, messages }` → `{ message, suggestions }` (grounded, structured cards);
 *   3. proposal `{ stage:'design', propose:true }` → `{ proposedSystem }` WITHOUT persisting.
 *
 * Auth, the agents store, the grounding + grantable resolvers, and the ONE model call are
 * mocked so the test is offline + deterministic; only the route's own dispatch + shaping
 * logic is under test. The REGRESSION guard: the legacy path still writes system.yaml and
 * returns `{ summary, system }` exactly as before.
 */

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const BASE_YAML = `
system: { name: Desk, domain: sales, visibility: Personal, description: "Handle overdue invoices" }
entrypoint: supervisor
grants: { tools: [search_knowledge, upload_file] }
agents:
  - { id: supervisor, role: router, agent_md: "# Sup", memory_md: "", members: [writer] }
  - { id: writer, role: writes, agent_md: "# Writer", memory_md: "", tools: [upload_file] }
edges:
  - { from: supervisor, to: writer, type: supervise }
`;

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) { const e = new Error('Not authenticated') as Error & { status?: number }; e.status = 401; throw e; }
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});

// The agents store is REAL (many transitive importers depend on its full export surface);
// we seed a system into it and read it back to assert whether a write happened. Imported
// AFTER the auth mock so the route + store share one module instance.
const store = await import('../../../../../../lib/agents/store.ts');

// Grounding + grantable resolvers — hermetic, return a tiny granted set.
mock.module('@tabs/agents/lib/grounding', {
  namedExports: {
    resolveSystemGrounding: async () => ({
      description: 'Handle overdue invoices',
      data: [{ id: 'ds_1', name: 'invoices' }],
      tools: ['search_knowledge', 'query_data'],
    }),
  },
});
mock.module('@tabs/agents/lib/grantable', {
  namedExports: {
    listGrantableForKinds: async () => ({ data: [{ id: 'ds_1', name: 'invoices', scope: 'personal' }] }),
  },
});

// The ONE model call — steered per test via MODEL_REPLY, or MODEL_THROW for 503/402 passthrough.
let MODEL_REPLY = '';
let MODEL_THROW: (Error & { status?: number }) | null = null;
mock.module('@core/runtime/complete', {
  namedExports: {
    assistantComplete: async () => {
      if (MODEL_THROW) throw MODEL_THROW;
      return { content: MODEL_REPLY, model: 'test-model' };
    },
  },
});

const { POST } = await import('./route.ts');

type Body = {
  summary?: string;
  system?: { agents: { id: string }[] };
  message?: string;
  suggestions?: Record<string, unknown>;
  proposedSystem?: { agents: { id: string }[]; entrypoint: string };
  error?: string;
};

let SYS_ID = '';
/** The system.yaml at the last seed — compare against it to detect a write. */
let SEEDED_YAML = '';
const PRINCIPAL = { id: 'ada', domains: ['sales'], role: 'builder' as const };

function currentYaml(): string {
  return (store as { getSystem: (id: string, u: unknown) => { yaml: string } }).getSystem(SYS_ID, PRINCIPAL).yaml;
}
function wrote(): boolean {
  return currentYaml() !== SEEDED_YAML;
}

async function post(payload: Record<string, unknown>): Promise<{ status: number; body: Body }> {
  const req = new Request(`http://x/api/agents/systems/${SYS_ID}/assistant`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const res = await POST(req, { params: Promise.resolve({ id: SYS_ID }) });
  return { status: res.status, body: (await res.json()) as Body };
}

beforeEach(() => {
  ACTING = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'builder' };
  MODEL_REPLY = '';
  MODEL_THROW = null;
  // Seed a fresh system carrying BASE_YAML for each test (owner = the acting user).
  const s = store as {
    __resetStore?: () => void;
    createSystem: (u: unknown, i: { name: string; domain?: string; yaml?: string }) => { id: string; yaml: string };
  };
  s.__resetStore?.();
  const rec = s.createSystem(PRINCIPAL, { name: 'Desk', domain: 'sales', yaml: BASE_YAML.trim() });
  SYS_ID = rec.id;
  SEEDED_YAML = rec.yaml;
});

// --- 1) LEGACY regression -----------------------------------------------------

test('REGRESSION: legacy { instruction } still edits + commits system.yaml unchanged', async () => {
  const { status, body } = await post({ instruction: 'add a research sub-agent that hands off to the writer' });
  assert.equal(status, 200);
  // Same response contract as before: { summary, system }.
  assert.match(body.summary ?? '', /research/i);
  assert.ok(body.system, 'returns the mutated system');
  assert.ok(body.system!.agents.some((a) => /research/i.test(a.id)), 'the researcher was added');
  // It COMMITTED through the store's whitelisted system.yaml write.
  assert.ok(wrote(), 'system.yaml was written');
  assert.match(currentYaml(), /research/i);
});

test('REGRESSION: legacy blank instruction is a 400, no write', async () => {
  const { status, body } = await post({ instruction: '   ' });
  assert.equal(status, 400);
  assert.match(body.error ?? '', /instruction is required/i);
  assert.ok(!wrote());
});

// --- 2) CHAT mode -------------------------------------------------------------

test('chat { stage:"design", messages } returns { message, suggestions } and does NOT write', async () => {
  MODEL_REPLY = JSON.stringify({
    message: 'Here is a team.',
    proposedTeam: [
      { id: 'pull', role: 'Pulls', instruction: 'pull invoices' },
      { id: 'flag', role: 'Flags', instruction: 'flag overdue' },
    ],
    suggestedInstructions: [{ agentId: 'writer', instruction: 'Write a summary.' }],
  });
  const { status, body } = await post({ stage: 'design', messages: [{ role: 'user', content: 'design a team' }] });
  assert.equal(status, 200);
  assert.equal(body.message, 'Here is a team.');
  const s = body.suggestions as { proposedTeam?: unknown[]; suggestedInstructions?: unknown[] };
  assert.equal(s.proposedTeam?.length, 2);
  assert.equal(s.suggestedInstructions?.length, 1);
  assert.ok(!wrote(), 'chat never writes');
});

test('chat grant stage grounds grantable ids; a hallucinated id is dropped by the normaliser', async () => {
  MODEL_REPLY = JSON.stringify({
    message: 'Grant these.',
    suggestedGrants: [
      { kind: 'data', id: 'ds_1', access: 'read-only', reason: 'the invoices' },
      { kind: 'bogus', id: 'x' }, // unknown kind → dropped
    ],
  });
  const { status, body } = await post({ stage: 'grant', messages: [{ role: 'user', content: 'what to grant?' }] });
  assert.equal(status, 200);
  const g = (body.suggestions as { suggestedGrants?: { kind: string; id: string }[] }).suggestedGrants!;
  assert.equal(g.length, 1);
  assert.equal(g[0].id, 'ds_1');
});

test('chat prose stage (build) returns prose with empty suggestions', async () => {
  MODEL_REPLY = 'This node runs first and hands to the next.';
  const { status, body } = await post({ stage: 'build', messages: [{ role: 'user', content: 'what is this?' }] });
  assert.equal(status, 200);
  assert.equal(body.message, 'This node runs first and hands to the next.');
  assert.deepEqual(body.suggestions, {});
});

test('chat: a non-JSON reply on a structured stage degrades to prose, no throw', async () => {
  MODEL_REPLY = 'I could not produce JSON, sorry.';
  const { status, body } = await post({ stage: 'design', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 200);
  assert.match(body.message ?? '', /could not produce JSON/);
  assert.deepEqual(body.suggestions, {});
});

test('an invalid stage is a 400', async () => {
  const { status, body } = await post({ stage: 'nope', messages: [] });
  assert.equal(status, 400);
  assert.match(body.error ?? '', /valid stage/i);
});

// --- 3) PROPOSAL mode ---------------------------------------------------------

test('proposal { stage:"design", propose:true } returns { proposedSystem } and does NOT write', async () => {
  MODEL_REPLY = JSON.stringify({
    agents: [
      { id: 'pull-invoices', role: 'Pulls invoices', instruction: 'Query the granted invoices dataset.' },
      { id: 'flag-overdue', role: 'Flags overdue', instruction: 'Flag invoices past due.' },
    ],
  });
  const { status, body } = await post({ stage: 'design', propose: true });
  assert.equal(status, 200);
  assert.ok(body.proposedSystem, 'returns a proposed system');
  assert.equal(body.proposedSystem!.agents.length, 2);
  assert.equal(body.proposedSystem!.entrypoint, 'pull-invoices');
  assert.ok(!wrote(), 'proposal never persists — the client commits it');
});

// --- honest error passthrough -------------------------------------------------

test('a 503 (no model) surfaces plainly on a chat stage', async () => {
  MODEL_THROW = Object.assign(new Error('no assistant model'), { status: 503 });
  const { status, body } = await post({ stage: 'design', messages: [{ role: 'user', content: 'go' }] });
  assert.equal(status, 503);
  assert.match(body.error ?? '', /no assistant model/i);
});

test('a 402 (cost cap) surfaces plainly on the proposal path', async () => {
  MODEL_THROW = Object.assign(new Error('cost cap reached'), { status: 402 });
  const { status, body } = await post({ stage: 'design', propose: true });
  assert.equal(status, 402);
  assert.match(body.error ?? '', /cost cap/i);
});

test('anonymous caller is refused (401)', async () => {
  ACTING = null;
  const { status } = await post({ stage: 'design', messages: [] });
  assert.equal(status, 401);
});
