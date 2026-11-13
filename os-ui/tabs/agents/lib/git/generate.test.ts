/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Golden-file tests for the agent-system git subtree (Part D, checklist A3)
 * USER STORY: As a maintainer I want the generated `agents/**` tree pinned byte-for-byte for the
 *             canonical shapes, so a change to what an engineer reads in the repo is a visible
 *             diff and regeneration from unchanged state commits nothing.
 * ARCHITECTURE:
 *   - Pure: literal snapshots in, file map out. No store, no git, no cluster.
 *   - `REGEN_AGENT_GOLDENS=1 node --test …` rewrites the goldens after a deliberate change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { generateAgentFiles, placeSystems, segment, AGENTS_PREFIX, ownerToken } from '@tabs/agents/lib/git/generate';
import type { AgentProjectSnapshot, SnapshotSystem } from '@tabs/agents/lib/git/snapshot';

const FIXTURES = join(import.meta.dirname, 'fixtures');

const PERSONAL_YAML = `version: '1'
system:
  name: Support triage
  domain: sales
  visibility: Personal
  description: Classify inbound tickets and recommend the next step.
entrypoint: triage
state:
  channels:
    messages: add_messages
grants:
  data:
    - id: ds_gold_orders
      capability: Read
      layer: gold
  knowledge: []
  metrics: []
  tools:
    - query_data
  connections: []
agents:
  - id: triage
    role: Classifies the ticket and recommends one next step
    agent_md: |
      # triage
      Read the granted gold data and classify the ticket.
    memory_md: '# Memory'
    tools:
      - query_data
`;

const TEAM_YAML = `version: '1'
system:
  name: Revenue review
  domain: sales
  visibility: Shared
safety_preset: read-propose
entrypoint: lead
state:
  channels:
    messages: add_messages
    plan_ready: boolean
grants:
  data: []
  knowledge:
    - id: kn_playbook
      capability: Read
  metrics: []
  tools:
    - search_knowledge
    - query_data
    - request_promotion
  connections: []
agents:
  - id: lead
    role: Routes the review
    agent_md: |
      # lead
      Decide who works next, then summarise.
    memory_md: '# Memory'
    tools: []
    members:
      - researcher
      - publisher
  - id: researcher
    role: Gathers the facts
    agent_md: |
      # researcher
      Search the granted knowledge and record plan_ready when done.
    memory_md: '# Memory'
    tools:
      - search_knowledge
  - id: publisher
    role: Files the promotion
    agent_md: |
      # publisher
      File the promotion request. It is held for a domain admin.
    memory_md: '# Memory'
    tools:
      - request_promotion
edges:
  - from: lead
    to: researcher
    type: supervise
  - from: lead
    to: publisher
    type: supervise
  - from: researcher
    to: publisher
    type: handoff
    when: plan_ready
`;

function sys(over: Partial<SnapshotSystem> & Pick<SnapshotSystem, 'id' | 'name' | 'owner' | 'visibility' | 'yaml'>): SnapshotSystem {
  return {
    origin: 'authored',
    running: false,
    schedule: { kind: 'manual' },
    disabledAgents: [],
    folder: '/',
    version: 1,
    ...over,
  };
}

const SHAPES: Record<string, AgentProjectSnapshot> = {
  // (a) one Personal system in the owner's lane.
  'personal-single-agent': {
    domain: 'sales',
    systems: [sys({ id: 'sys_aaa111', name: 'Support triage', owner: 'amir', visibility: 'Personal', yaml: PERSONAL_YAML, version: 3, lastBuild: { ok: true, at: 1763020800000 } })],
  },
  // (b) a Shared supervisor team in the domain lane, scheduled and running.
  'shared-supervisor-team': {
    domain: 'sales',
    systems: [
      sys({
        id: 'sys_bbb222',
        name: 'Revenue review',
        owner: 'bea',
        visibility: 'Shared',
        yaml: TEAM_YAML,
        version: 7,
        running: true,
        schedule: { kind: 'cron', cron: '0 6 * * 1' },
        disabledAgents: ['publisher'],
        folder: '/reviews',
        lastBuild: { ok: false, at: 1763107200000 },
      }),
    ],
  },
  // (c) two systems slugging identically, one of them unparseable, plus a domain system that
  //     would otherwise shadow the personal lane.
  'collisions-and-bad-source': {
    domain: 'sales',
    systems: [
      sys({ id: 'sys_ccc333', name: 'Support triage', owner: 'amir', visibility: 'Personal', yaml: PERSONAL_YAML }),
      sys({ id: 'sys_ddd444', name: 'Support triage', owner: 'amir', visibility: 'Personal', yaml: PERSONAL_YAML }),
      sys({ id: 'sys_eee555', name: 'Personal', owner: 'bea', visibility: 'Shared', yaml: TEAM_YAML }),
      sys({ id: 'sys_fff666', name: 'Broken', owner: 'bea', visibility: 'Shared', yaml: 'this: [is not: a system\n' }),
    ],
  },
};

for (const [name, snapshot] of Object.entries(SHAPES)) {
  test(`golden: ${name}`, () => {
    const files = generateAgentFiles(snapshot);
    const actual = Object.fromEntries([...files.entries()]);
    const path = join(FIXTURES, `${name}.golden.json`);
    if (process.env.REGEN_AGENT_GOLDENS === '1') {
      writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    assert.deepEqual(actual, expected);
  });
}

test('every generated path is inside the agents/ subtree', () => {
  for (const snapshot of Object.values(SHAPES)) {
    for (const p of generateAgentFiles(snapshot).keys()) {
      assert.ok(p.startsWith(AGENTS_PREFIX), `${p} escapes the subtree`);
      assert.ok(!p.includes('..') && !p.startsWith('/'), `${p} is not a safe repo path`);
    }
  }
});

test('generation is idempotent — the same snapshot yields an identical map', () => {
  for (const snapshot of Object.values(SHAPES)) {
    assert.deepEqual([...generateAgentFiles(snapshot).entries()], [...generateAgentFiles(snapshot).entries()]);
  }
});

test('index.yml parses and maps every slug to its id, owner, scope and version', () => {
  const snapshot = SHAPES['collisions-and-bad-source'];
  const index = yaml.load(generateAgentFiles(snapshot).get(`${AGENTS_PREFIX}index.yml`)!) as {
    domain: string;
    systems: { slug: string; id: string; path: string; owner: string; scope: string; version: number }[];
  };
  assert.equal(index.domain, 'sales');
  const amirLane = `agents/personal/${ownerToken('amir')}`;
  assert.deepEqual(
    index.systems.map((s) => [s.id, s.path, s.scope]),
    [
      ['sys_ccc333', `${amirLane}/support-triage`, 'personal'],
      ['sys_ddd444', `${amirLane}/support-triage-sys-ddd444`, 'personal'],
      ['sys_eee555', 'agents/personal-sys-eee555', 'domain'],
      ['sys_fff666', 'agents/broken', 'domain'],
    ],
    'the first claimant keeps the bare slug; a domain system can never shadow agents/personal/',
  );
  assert.deepEqual(index.systems.map((s) => s.owner), [ownerToken('amir'), ownerToken('amir'), ownerToken('bea'), ownerToken('bea')]);
});

// ------------------------------------------- no principal ids (review M-1) ---

test('the generated tree never publishes a principal id — the owner is an opaque, stable token', () => {
  // An id that IS an e-mail address: the shape the OS actually uses, and the reason the token
  // exists. `index.yml`, every README and the personal lane's path must carry the hash, and the
  // whole subtree must not contain an `@` anywhere.
  const snapshot = {
    ...SHAPES['personal-single-agent'],
    systems: SHAPES['personal-single-agent'].systems.map((s) => ({ ...s, owner: 'amir@acme.example' })),
  };
  const files = generateAgentFiles(snapshot);
  const token = ownerToken('amir@acme.example');
  assert.match(token, /^[0-9a-f]{12}$/);
  assert.ok([...files.keys()].some((p) => p.startsWith(`agents/personal/${token}/`)), 'the lane is the token');
  for (const [path, content] of files) {
    assert.equal(path.includes('@'), false, `${path} carries an address`);
    assert.equal(content.includes('amir@acme.example'), false, `${path} carries the principal id`);
    // `agents/<id>.md` is the agent's own prompt; nothing else may contain an `@` at all.
    if (path.endsWith('index.yml') || path.endsWith('README.md')) assert.equal(content.includes('@'), false, `${path} carries an @`);
  }
  // Stable: the same owner always hashes to the same lane, so no directory moves on a re-save.
  assert.equal(ownerToken('amir@acme.example'), token);
  assert.notEqual(ownerToken('amir@acme.example'), ownerToken('bea@acme.example'));
});

test('placement is stable under a reordered snapshot (sorted by id, not arrival)', () => {
  const snapshot = SHAPES['collisions-and-bad-source'];
  const reversed: AgentProjectSnapshot = { domain: snapshot.domain, systems: [...snapshot.systems].reverse() };
  assert.deepEqual(
    placeSystems(reversed).map((p) => p.dir),
    placeSystems(snapshot).map((p) => p.dir),
    'reordering the input must not move a directory',
  );
});

test('an empty domain still writes the index, so the last removal is a visible commit', () => {
  const files = generateAgentFiles({ domain: 'sales', systems: [] });
  assert.deepEqual([...files.keys()], [`${AGENTS_PREFIX}index.yml`]);
  assert.match(files.get(`${AGENTS_PREFIX}index.yml`)!, /systems: \[\]/);
});

test('an unparseable source is still committed, with a README that says so and no graph', () => {
  const files = generateAgentFiles(SHAPES['collisions-and-bad-source']);
  assert.equal(files.get('agents/broken/system.yaml'), 'this: [is not: a system\n');
  assert.match(files.get('agents/broken/README.md')!, /does not currently parse/);
  assert.equal(files.has('agents/broken/graph.json'), false);
});

test('graph.json is the compiled IR the engine runs, and the README names every member', () => {
  const files = generateAgentFiles(SHAPES['shared-supervisor-team']);
  const ir = JSON.parse(files.get('agents/revenue-review/graph.json')!) as {
    entrypoint: string;
    nodes: { id: string; supervisor: boolean; members: string[] }[];
    commands: { from: string; to: string; when: string | null }[];
  };
  assert.equal(ir.entrypoint, 'lead');
  assert.deepEqual(ir.nodes.map((n) => n.id).sort(), ['lead', 'publisher', 'researcher']);
  assert.deepEqual(ir.commands, [{ from: 'researcher', to: 'publisher', when: 'plan_ready' }]);
  const readme = files.get('agents/revenue-review/README.md')!;
  for (const id of ['lead', 'researcher', 'publisher']) assert.match(readme, new RegExp(`\\\`${id}\\\``));
  assert.match(readme, /disabled/, 'a disabled member is shown as disabled');
  assert.match(readme, /\*\*Last build\*\* FAILED at 2025-11-14T08:00:00\.000Z/);
});

test("each agent's prompt is its own markdown file", () => {
  const files = generateAgentFiles(SHAPES['personal-single-agent']);
  assert.equal(files.get(`agents/personal/${ownerToken('amir')}/support-triage/agents/triage.md`), '# triage\nRead the granted gold data and classify the ticket.\n');
});

test('segment refuses to produce an unsafe or empty path piece', () => {
  assert.equal(segment('../../etc/passwd', 'x'), '-etc-passwd'.replace(/^-+/, ''));
  assert.equal(segment('', 'fallback'), 'fallback');
  assert.equal(segment('...', 'fallback'), 'fallback');
  assert.equal(segment('Über Käse', 'x'), 'ber-k-se');
});
