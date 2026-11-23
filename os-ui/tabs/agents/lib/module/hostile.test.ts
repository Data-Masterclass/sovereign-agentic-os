/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53 — hostile names never become code in the generated module
 * USER STORY: As the owner I want any text a creator types — a team name, a role, a prompt, a
 *             hand-off condition, a model alias — to reach `graph.mjs` only as data, and any
 *             identifier that is not a plain token to be refused, so no definition can make the
 *             generator emit code that the hash check would then approve.
 * ARCHITECTURE:
 *   - Each payload is put into one field of a valid definition (the parsed `System`, not YAML, so
 *     the YAML layer cannot neutralise it first). Text payloads: the module is generated, `node
 *     --check` must pass, and importing it plus `buildGraph()` in a FRESH node process must leave
 *     no side effect (no marker file, no global) while `TEAM` carries the payload byte for byte.
 *   - Identifier payloads (agent ids, members, channels, tools): the generator AND the store's
 *     identifier check refuse them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { identifierProblems } from '@tabs/agents/lib/safe-ids';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';

const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const BASE = `version: '1'
system: { name: Base, domain: sales, visibility: Personal }
entrypoint: lead
state: { channels: { messages: add_messages, flag: string } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: lead, role: Routes, agent_md: '# lead', memory_md: '', tools: [], members: [worker] }
  - { id: worker, role: Works, agent_md: '# worker', memory_md: '', tools: [search_knowledge] }
edges:
  - { from: lead, to: worker, type: supervise }
  - { from: worker, to: lead, type: handoff, when: "state.flag == 'done'" }
`;
const base = (): System => structuredClone(parseSystem(BASE));

/** A payload that writes a marker file and sets a global if it ever executes. */
const exploit = (marker: string) => `globalThis.PWNED = 1; import('node:fs').then((f) => f.writeFileSync(${JSON.stringify(marker)}, 'x'));`;
const BREAKERS = ['\n', '\r', '\r\n', '\u2028', '\u2029', '*/', '`', '${', '"', "'", '\\', '</script>', '-->', '\u0085'];
const payloads = (marker: string) => BREAKERS.flatMap((b) => [`${b}${exploit(marker)}//`, `x${b}${exploit(marker)}${b}`, `${b}\`\${${exploit(marker)}}\``]);

function runsClean(files: Map<string, string>, marker: string): { ok: boolean; detail: string; team?: unknown } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wp53-hostile-'));
  for (const [p, c] of files) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
  symlinkSync(path.join(OS_UI, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const f of ['graph.mjs', 'run.mjs']) {
    const c = spawnSync(process.execPath, ['--check', path.join(dir, f)], { encoding: 'utf8' });
    if (c.status !== 0) return { ok: false, detail: `${f} does not parse: ${c.stderr}` };
  }
  const probe = [
    "import { fakeModel, tool } from 'langchain';",
    "const m = await import('./graph.mjs');",
    "const tools = m.TOOL_NAMES.map((name) => tool(async () => 'x', { name, description: name, schema: { type: 'object', properties: {} } }));",
    'm.buildGraph({ model: fakeModel(), tools });',
    'await new Promise((r) => setTimeout(r, 50));',
    'console.log(JSON.stringify({ pwned: globalThis.PWNED ?? null, team: m.TEAM }));',
  ].join('\n');
  writeFileSync(path.join(dir, 'probe.mjs'), probe);
  const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  if (r.status !== 0) return { ok: false, detail: `import failed: ${r.stderr}` };
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { pwned: unknown; team: unknown };
  if (out.pwned !== null || existsSync(marker)) return { ok: false, detail: 'the payload EXECUTED' };
  return { ok: true, detail: '', team: out.team };
}

type TextField = { name: string; set: (s: System, v: string) => void; get: (team: { name: string; agents: { model: string | null }[] }) => string | null };
const TEXT_FIELDS: TextField[] = [
  { name: 'system.name', set: (s, v) => { s.system.name = v; }, get: (t) => t.name },
  // The agent model is no longer free text: a closed choice (strong · standard · auto) that compiles to a role name.
  // A hostile value set on the definition compiles to a role, never into the module (asserted below).
  { name: 'agent model', set: (s, v) => { s.agents[1].model = v as never; }, get: (t) => (['sovereign-strong', 'sovereign-worker'].includes(t.agents[1].model ?? '') ? null : t.agents[1].model) },
  { name: 'agent role', set: (s, v) => { s.agents[0].role = v; }, get: () => null },
  { name: 'agent_md', set: (s, v) => { s.agents[0].agent_md = v; }, get: () => null },
  { name: 'memory_md', set: (s, v) => { s.agents[1].memory_md = v; }, get: () => null },
  { name: 'system.description', set: (s, v) => { s.system.description = v; }, get: () => null },
  // A hand-off literal cannot hold its own quote character; every other breaker is allowed in it.
  { name: 'when literal', set: (s, v) => { s.edges[1].when = `state.flag == '${v.replace(/'/g, '')}'`; }, get: () => null },
];

test('hostile TEXT in every field reaches graph.mjs only as data: it parses, imports and runs nothing', () => {
  // One generation per payload, with the payload in EVERY text field at once.
  for (const [i, v] of payloads('').entries()) {
    const marker = path.join(os.tmpdir(), `wp53-pwned-${process.pid}-${i}`);
    const payload = v.replaceAll(JSON.stringify(''), JSON.stringify(marker));
    const sys = base();
    for (const f of TEXT_FIELDS) f.set(sys, payload);
    const m = generateAgentModule({ id: 'sys_hostile1', slug: 'hostile', sys, ...hostModuleInputs() });
    const r = runsClean(m.files, marker);
    assert.equal(r.ok, true, `${JSON.stringify(payload)}: ${r.detail}`);
    for (const f of TEXT_FIELDS) {
      const got = f.get(r.team as never);
      if (got !== null) assert.equal(got, payload, `${f.name}: the payload is carried as data, byte for byte`);
    }
  }
});

test('hostile IDENTIFIERS are refused by the generator and by the store check', () => {
  const ids = ['../evil', '__proto__', 'constructor', 'a b', 'A', 'x\ny', 'x\u2028y', 'evil/..', '', 'a"b', "a'b", 'a`b', 'steps', '-lead'];
  const cases: [string, (s: System, v: string) => void][] = [
    ['agent id', (s, v) => { s.agents[1].id = v; s.agents[0].members = [v]; s.edges[0].to = v; s.edges[1].from = v; }],
    ['state channel', (s, v) => { s.state.channels = { messages: 'add_messages', [v]: 'string' }; }],
    ['tool', (s, v) => { s.grants.tools = [v]; s.agents[1].tools = [v]; }],
  ];
  for (const [what, set] of cases) {
    for (const v of ids) {
      if (what === 'state channel' && v === '') continue;
      const sys = base();
      set(sys, v);
      assert.ok(identifierProblems(sys).length > 0, `${what} ${JSON.stringify(v)} passes the store check`);
      assert.throws(() => generateAgentModule({ id: 'sys_hostile1', slug: 'hostile', sys, ...hostModuleInputs() }), undefined, `${what} ${JSON.stringify(v)}`);
    }
  }
  for (const id of ['sys\nx', '../x', 'sys x', '']) {
    assert.throws(() => generateAgentModule({ id, slug: 'hostile', sys: base(), ...hostModuleInputs() }), /not a plain identifier/);
  }
});
